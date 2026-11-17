import { PhotonImage, SamplingFilter, fliph, flipv, resize } from "@cf-wasm/photon/workerd";
import { imageSize } from "image-size";

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 4_000_000;
const MAX_SMALL_BYTES = 64 * 1024;
const MAX_LARGE_BYTES = 256 * 1024;

export type PatrolThumbnails = {
  small: Buffer;
  large: { jpeg: Buffer; width: number; height: number } | null;
};

function scaledImage(image: PhotonImage, size: number): PhotonImage {
  const scale = Math.min(1, size / Math.max(image.get_width(), image.get_height()));
  const width = Math.max(1, Math.round(image.get_width() * scale));
  const height = Math.max(1, Math.round(image.get_height() * scale));
  return resize(image, width, height, SamplingFilter.Triangle);
}

function orientImage(thumbnail: PhotonImage, orientation: number): PhotonImage | null {
  const width = thumbnail.get_width();
  const height = thumbnail.get_height();
  // Photon does not apply EXIF orientation. Orient the resized result, avoiding
  // another full-resolution allocation for portrait phone photos.
  if (orientation === 2 || orientation === 3) fliph(thumbnail);
  if (orientation === 3 || orientation === 4) flipv(thumbnail);
  if (orientation >= 5 && orientation <= 8) {
    // Exact quarter turns preserve pixels; Photon's arbitrary-angle rotate
    // changes colors even at 90 degrees in the pinned version.
    const pixels = thumbnail.get_raw_pixels();
    const rotated = new Uint8Array(pixels.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dx = orientation === 5 || orientation === 8 ? y : height - 1 - y;
        const dy = orientation === 5 || orientation === 6 ? x : width - 1 - x;
        const from = (y * width + x) * 4;
        rotated.set(pixels.subarray(from, from + 4), (dy * height + dx) * 4);
      }
    }
    return new PhotonImage(rotated, height, width);
  }
  return null;
}

function jpegBytes(image: PhotonImage, limit: number): Buffer | null {
  const bytes = image.get_bytes_jpeg(70);
  if (bytes.byteLength > limit || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
  return Buffer.from(bytes);
}

/** Synchronous WASM: bound input before decoding; timers cannot interrupt it. */
export function patrolThumbnails(source: ArrayBuffer, signal: AbortSignal): PatrolThumbnails | null {
  let image: PhotonImage | undefined;
  let largeImage: PhotonImage | undefined;
  let oriented: PhotonImage | null = null;
  let smallImage: PhotonImage | undefined;
  try {
    signal.throwIfAborted();
    if (!source.byteLength || source.byteLength > MAX_SOURCE_BYTES) return null;
    const bytes = new Uint8Array(source);
    const { width, height, type, orientation = 1 } = imageSize(bytes);
    if (!type || !["jpg", "png", "webp"].includes(type) || !width || !height
      || width * height > MAX_SOURCE_PIXELS) return null;

    image = PhotonImage.new_from_byteslice(bytes);
    if (image.get_width() !== width || image.get_height() !== height) return null;
    signal.throwIfAborted();
    largeImage = scaledImage(image, 800);
    // Release full-resolution pixels before orientation and JPEG encoding.
    image.free();
    image = undefined;
    oriented = orientImage(largeImage, orientation);
    const output = oriented ?? largeImage;
    signal.throwIfAborted();
    // Derive the compact image from the 800px pixels, not a second full-size scan.
    smallImage = scaledImage(output, 320);
    const small = jpegBytes(smallImage, MAX_SMALL_BYTES);
    if (!small) return null;
    signal.throwIfAborted();
    const jpeg = jpegBytes(output, MAX_LARGE_BYTES);
    const large = jpeg ? { jpeg, width: output.get_width(), height: output.get_height() } : null;
    signal.throwIfAborted();
    return { small, large };
  } catch {
    // Optional preview errors must never expose report URLs or decoder details.
    return null;
  } finally {
    smallImage?.free();
    oriented?.free();
    largeImage?.free();
    image?.free();
  }
}
