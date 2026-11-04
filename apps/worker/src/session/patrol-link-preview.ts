import { prepareWAMessageMedia } from "@whiskeysockets/baileys";
import type { WAMediaUploadFunction, WAUrlInfo } from "@whiskeysockets/baileys";
import { assertSafeOutboundUrlWithDns } from "../security";

const PREVIEW_TIMEOUT_MS = 4_000;
const LARGE_PREVIEW_TIMEOUT_MS = 6_000;
const THUMBNAIL_UPLOAD_TIMEOUT_MS = 3_000;
const MAX_HTML_BYTES = 128 * 1024;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 64 * 1024;
const MAX_LARGE_THUMBNAIL_BYTES = 256 * 1024;
const HTML_ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&quot;": '"',
  "&lt;": "<",
  "&gt;": ">",
  "&apos;": "'",
  "&#39;": "'",
  "&#039;": "'",
};

function decodeHtml(value: string): string {
  return value.replace(/&(?:amp|quot|lt|gt|apos|#0?39);/g, entity => HTML_ENTITIES[entity]).trim();
}

function signedUrl(value: string): URL | null {
  if (value.length > 2048) return null;
  const url = URL.parse(value);
  if (!url || url.protocol !== "https:" || url.port || url.username || url.password || url.hash) {
    return null;
  }
  const signatures = url.searchParams.getAll("signature");
  if (signatures.length !== 1 || !/^[a-f0-9]{64}$/.test(signatures[0])) return null;
  return url;
}

function reportPhotoUrl(value: string, report: URL): URL | null {
  if (!value || value.length > 2048) return null;
  const photo = URL.parse(value, report.href);
  if (!photo || photo.protocol !== "https:" || photo.port || photo.username || photo.password || photo.search || photo.hash) {
    return null;
  }
  // Spatie's public disk may serve photos from the ERP sibling hostname.
  const erpHost = report.hostname.startsWith("patrol.") ? "erp." + report.hostname.slice("patrol.".length) : null;
  if (photo.hostname !== report.hostname && photo.hostname !== erpHost) return null;
  return /^\/storage\/\d+\/[^/\\%]+\.(?:jpe?g|png|webp)$/i.test(decodeURIComponent(photo.pathname)) ? photo : null;
}

async function readPreviewBytes(response: Response, mime: RegExp, limit: number): Promise<ArrayBuffer | null> {
  const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (!response.ok || !type || !mime.test(type) || Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return null;

  const bytes = new Uint8Array(limit);
  const reader = response.body.getReader();
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return bytes.slice(0, length).buffer;
      if (length + value.byteLength > limit) {
        await reader.cancel();
        return null;
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}

async function resizeJpeg(images: ImagesBinding, source: ArrayBuffer, size: number, limit: number): Promise<Buffer | null> {
  const input = new Response(source);
  if (!input.body) return null;
  const transformed = await images.input(input.body)
    .transform({ width: size, height: size, fit: "scale-down" })
    .output({ format: "image/jpeg", quality: 70 });
  const jpeg = await readPreviewBytes(transformed.response(), /^image\/jpeg$/, limit);
  if (!jpeg) return null;
  const header = new Uint8Array(jpeg, 0, Math.min(3, jpeg.byteLength));
  return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff ? Buffer.from(jpeg) : null;
}

type PatrolPreview = { preview: WAUrlInfo & { jpegThumbnail: Buffer }; source: ArrayBuffer };

async function buildPreview(
  report: URL, matchedText: string, images: ImagesBinding, signal: AbortSignal,
): Promise<PatrolPreview | null> {
  const options: RequestInit = { redirect: "manual", cache: "no-store", signal };
  if (!(await assertSafeOutboundUrlWithDns(report.href, { timeoutMs: 1_000 })).ok) return null;
  const html = await readPreviewBytes(await fetch(report.href, options), /^text\/html$/, MAX_HTML_BYTES);
  if (!html) return null;

  let title = "";
  let photoUrl = "";
  await new HTMLRewriter()
    .on("head title", {
      text(chunk) { title += chunk.text.slice(0, Math.max(0, 2048 - title.length)); },
    })
    .on("button.photo-button[data-photo-url]", {
      element(element) { photoUrl ||= decodeHtml(element.getAttribute("data-photo-url") ?? ""); },
    })
    .transform(new Response(html)).arrayBuffer();

  title = decodeHtml(title).slice(0, 256);
  const photo = reportPhotoUrl(photoUrl, report);
  if (!title || !photo) return null;
  if (photo.origin !== report.origin && !(await assertSafeOutboundUrlWithDns(photo.href, { timeoutMs: 1_000 })).ok) {
    return null;
  }
  const source = await readPreviewBytes(await fetch(photo.href, options), /^image\/(?:jpeg|png|webp)$/, MAX_SOURCE_BYTES);
  if (!source) return null;
  signal.throwIfAborted();
  const jpeg = await resizeJpeg(images, source, 320, MAX_THUMBNAIL_BYTES);
  if (!jpeg || signal.aborted) return null;

  return {
    preview: { "canonical-url": report.href, "matched-text": matchedText, title, jpegThumbnail: jpeg },
    source,
  };
}

async function withPreviewTimeout<T>(work: (signal: AbortSignal) => Promise<T>, fallback: T, timeoutMs: number): Promise<T> {
  const signal = AbortSignal.timeout(timeoutMs);
  let onAbort: () => void = () => {};
  const timeout = new Promise<T>(resolve => {
    onAbort = () => resolve(fallback);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work(signal), timeout]);
  } catch {
    // Optional preview errors may contain signed URLs or media upload credentials.
    return fallback;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function withUploadedThumbnail(
  { preview, source }: PatrolPreview, images: ImagesBinding, upload: WAMediaUploadFunction,
): Promise<WAUrlInfo> {
  return withPreviewTimeout(async signal => {
    const largeJpeg = await resizeJpeg(images, source, 800, MAX_LARGE_THUMBNAIL_BYTES);
    if (!largeJpeg) return preview;
    signal.throwIfAborted();
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(largeJpeg);
        controller.close();
      },
    });
    const size = await images.info(input);
    if (!("width" in size) || !size.width || !size.height) return preview;
    signal.throwIfAborted();
    // Baileys uses the encrypted thumbnail reference to build the full-size link card.
    const { imageMessage } = await prepareWAMessageMedia({
      image: largeJpeg,
      mimetype: "image/jpeg",
      width: size.width,
      height: size.height,
      jpegThumbnail: preview.jpegThumbnail.toString("base64"),
    }, {
      mediaTypeOverride: "thumbnail-link",
      mediaUploadTimeoutMs: THUMBNAIL_UPLOAD_TIMEOUT_MS,
      upload: (file, options) => {
        signal.throwIfAborted();
        return upload(file, options);
      },
    });
    return imageMessage?.directPath ? { ...preview, highQualityThumbnail: imageMessage } : preview;
  }, preview, LARGE_PREVIEW_TIMEOUT_MS);
}

export async function patrolLinkPreview(
  text: string, configuredHosts?: string, images?: ImagesBinding, upload?: WAMediaUploadFunction,
): Promise<WAUrlInfo | null> {
  if (!configuredHosts?.trim() || !images) return null;
  const hosts = new Set(configuredHosts.split(",").map(host => host.trim().toLowerCase()));
  for (const [matchedText] of text.matchAll(/https:\/\/[^\s<>"]+/gi)) {
    const report = signedUrl(matchedText);
    if (!report || !hosts.has(report.hostname) || !/^\/result\/\d+$/.test(report.pathname)) continue;

    const card = await withPreviewTimeout(signal => buildPreview(report, matchedText, images, signal), null, PREVIEW_TIMEOUT_MS);
    if (!card) return null;
    return upload ? withUploadedThumbnail(card, images, upload) : card.preview;
  }
  return null;
}
