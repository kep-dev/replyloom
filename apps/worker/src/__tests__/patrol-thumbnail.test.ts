import { PhotonImage } from "@cf-wasm/photon/node";
import { imageSize } from "image-size";
import { describe, expect, it, vi } from "vitest";
import { patrolThumbnails } from "../session/patrol-thumbnail";

// Vitest runs in Node; the benchmark also exercises the actual workerd entrypoint.
vi.mock("@cf-wasm/photon/workerd", () => import("@cf-wasm/photon/node"));

function fixture(width = 960, height = 480, format = "jpeg") {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Distinct quadrants let orientation tests inspect actual pixels.
      const offset = (y * width + x) * 4;
      pixels.set([x < width / 2 ? 240 : 20, y < height / 2 ? 240 : 20, 20, 255], offset);
    }
  }
  const image = new PhotonImage(pixels, width, height);
  try {
    return format === "png" ? image.get_bytes() : format === "webp" ? image.get_bytes_webp() : image.get_bytes_jpeg(90);
  } finally {
    image.free();
  }
}

function exif(jpeg: Uint8Array, orientation: number) {
  const app1 = new Uint8Array([
    0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0, 0,
    0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0,
    1, 0, 0, 0, orientation, 0, 0, 0, 0, 0, 0, 0,
  ]);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

function thumbnails(bytes: Uint8Array, signal = new AbortController().signal) {
  return patrolThumbnails(Uint8Array.from(bytes).buffer, signal);
}

describe("Photon patrol thumbnails", () => {
  it.each(["jpeg", "png", "webp"])("creates bounded JPEGs with the original aspect ratio from %s", format => {
    const output = thumbnails(fixture(960, 480, format));
    expect(output).not.toBeNull();
    expect(imageSize(output!.small)).toMatchObject({ type: "jpg", width: 320, height: 160 });
    expect(imageSize(output!.large!.jpeg)).toMatchObject({ type: "jpg", width: 800, height: 400 });
    expect(output!.small.length).toBeLessThanOrEqual(64 * 1024);
    expect(output!.large!.jpeg.length).toBeLessThanOrEqual(256 * 1024);
  });

  it("does not enlarge a small portrait image", () => {
    const output = thumbnails(fixture(48, 96));
    expect(imageSize(output!.small)).toMatchObject({ width: 48, height: 96 });
    expect(output!.large).toMatchObject({ width: 48, height: 96 });
  });

  it.each([
    [1, 96, 48, 240, 240], [2, 96, 48, 20, 240],
    [3, 96, 48, 20, 20], [4, 96, 48, 240, 20],
    [5, 48, 96, 240, 240], [6, 48, 96, 240, 20],
    [7, 48, 96, 20, 20], [8, 48, 96, 20, 240],
  ])("honors EXIF orientation %i in both sizes", (orientation, width, height, red, green) => {
    const output = thumbnails(exif(fixture(96, 48), orientation));
    expect(output).not.toBeNull();
    for (const bytes of [output!.small, output!.large!.jpeg]) {
      expect(imageSize(bytes)).toMatchObject({ width, height });
      const image = PhotonImage.new_from_byteslice(bytes);
      try {
        const pixels = image.get_raw_pixels();
        const offset = (8 * width + 8) * 4;
        expect(Math.abs(pixels[offset] - red)).toBeLessThan(15);
        expect(Math.abs(pixels[offset + 1] - green)).toBeLessThan(15);
      } finally {
        image.free();
      }
    }
  });

  it("rejects a compressed image above four megapixels before decoding", () => {
    const png = fixture(8, 8, "png");
    const header = new DataView(png.buffer, png.byteOffset, png.byteLength);
    header.setUint32(16, 2001);
    header.setUint32(20, 2000);
    const decode = vi.spyOn(PhotonImage, "new_from_byteslice");
    try {
      expect(thumbnails(png)).toBeNull();
      expect(decode).not.toHaveBeenCalled();
    } finally {
      decode.mockRestore();
    }
  });

  it("rejects oversized bytes, malformed input and an expired budget", () => {
    expect(thumbnails(new Uint8Array(2 * 1024 * 1024 + 1))).toBeNull();
    expect(thumbnails(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
    expect(thumbnails(new Uint8Array())).toBeNull();
    expect(thumbnails(fixture(8, 8), AbortSignal.abort())).toBeNull();
    // A rejected source must not poison the WASM instance for the next send.
    expect(thumbnails(fixture(8, 8))).not.toBeNull();
  });

  it("releases decoded images when JPEG encoding fails", () => {
    const source = fixture(16, 8);
    const encode = vi.spyOn(PhotonImage.prototype, "get_bytes_jpeg").mockImplementation(() => { throw new Error("encoder failure"); });
    const release = vi.spyOn(PhotonImage.prototype, "free");
    try {
      expect(thumbnails(source)).toBeNull();
      expect(release).toHaveBeenCalledTimes(3);
    } finally {
      encode.mockRestore();
      release.mockRestore();
    }
  });

  it.each([false, true])("enforces the JPEG output byte limits (compact: %s)", compact => {
    const source = fixture(16, 8);
    const oversized = new Uint8Array((compact ? 64 : 256) * 1024 + 1);
    oversized.set([0xff, 0xd8, 0xff]);
    const original = PhotonImage.prototype.get_bytes_jpeg;
    let calls = 0;
    const encode = vi.spyOn(PhotonImage.prototype, "get_bytes_jpeg").mockImplementation(function (this: PhotonImage, quality) {
      calls++;
      return calls === (compact ? 1 : 2) ? oversized : original.call(this, quality);
    });
    try {
      const output = thumbnails(source);
      if (compact) expect(output).toBeNull();
      else {
        expect(output?.small.length).toBeGreaterThan(0);
        expect(output?.large).toBeNull();
      }
    } finally {
      encode.mockRestore();
    }
  });

  it("handles damaged image data after its dimensions were accepted", () => {
    const png = fixture(16, 8, "png");
    expect(imageSize(png.subarray(0, 40))).toMatchObject({ width: 16, height: 8 });
    expect(thumbnails(png.subarray(0, 40))).toBeNull();
    expect(thumbnails(png)).not.toBeNull();
  });
});
