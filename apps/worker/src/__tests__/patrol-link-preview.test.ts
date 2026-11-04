import { generateWAMessageContent } from "@whiskeysockets/baileys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertSafeOutboundUrlWithDns } from "../security";
import { patrolLinkPreview } from "../session/patrol-link-preview";

vi.mock("../security", () => ({ assertSafeOutboundUrlWithDns: vi.fn() }));

const host = "patrol.example.com";
const report = "https://" + host + "/result/42?signature=" + "a".repeat(64);
const photo = "https://erp.example.com/storage/123/patrol%20photo.jpg";
const text = "Laporan patroli\n" + report;
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const html = () => new Response("<html></html>", { headers: { "content-type": "text/html; charset=utf-8" } });

function mockReport(imageUrl: string) {
  // Node Vitest does not expose Workers' HTMLRewriter.
  vi.stubGlobal("HTMLRewriter", class {
    on(selector: string, handler: {
      text?: (chunk: { text: string }) => void;
      element?: (element: { getAttribute: (name: string) => string | null }) => void;
    }) {
      if (selector === "head title") handler.text?.({ text: "Hasil Patroli - Area A &amp; B" });
      if (selector === "button.photo-button[data-photo-url]") handler.element?.({
        getAttribute: name => name === "data-photo-url" ? imageUrl : null,
      });
      return this;
    }
    transform(response: Response) { return response; }
  });
}

function mockImages() {
  const response = vi.fn(() => new Response(jpeg, { headers: { "content-type": "image/jpeg" } }));
  const output = vi.fn().mockResolvedValue({ response });
  const transform = vi.fn(() => ({ output }));
  const input = vi.fn(() => ({ transform }));
  const info = vi.fn().mockResolvedValue({ format: "image/jpeg", width: 800, height: 600 });
  return { binding: { input, info } as unknown as ImagesBinding, input, transform, output, response };
}

beforeEach(() => {
  vi.mocked(assertSafeOutboundUrlWithDns).mockResolvedValue({ ok: true, url: new URL(report), resolvedIps: [] });
  mockReport(photo);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("patrol link preview", () => {
  it("includes the JPEG and title in the Baileys message while retaining the signed link", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(html())
      .mockResolvedValueOnce(new Response(new Uint8Array(80 * 1024), { headers: { "content-type": "image/jpeg" } }));
    vi.stubGlobal("fetch", fetch);

    const images = mockImages();
    const linkPreview = await patrolLinkPreview(text, host, images.binding);
    const message = await generateWAMessageContent({ text, linkPreview }, { upload: vi.fn() });
    expect(message.extendedTextMessage).toMatchObject({
      title: "Hasil Patroli - Area A & B",
      matchedText: report,
      text,
      jpegThumbnail: Buffer.from(jpeg),
    });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([report, photo]);
    expect(vi.mocked(assertSafeOutboundUrlWithDns).mock.calls.map(([url]) => url)).toEqual([report, photo]);
    expect(images.transform).toHaveBeenCalledWith({ width: 320, height: 320, fit: "scale-down" });
    expect(images.output).toHaveBeenCalledWith({ format: "image/jpeg", quality: 70 });
    expect(fetch.mock.calls[0][1].redirect).toBe("manual");
    expect(fetch.mock.calls[1][1].signal).toBe(fetch.mock.calls[0][1].signal);
  });

  it("adds the encrypted thumbnail reference and dimensions for a large card", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(html())
      .mockResolvedValueOnce(new Response(jpeg, { headers: { "content-type": "image/jpeg" } })));
    const upload = vi.fn().mockResolvedValue({
      mediaUrl: "https://cdn.example.com/thumbnail",
      directPath: "/thumbnail",
    });
    const images = mockImages();
    const linkPreview = await patrolLinkPreview(text, host, images.binding, upload);
    const message = await generateWAMessageContent({ text, linkPreview }, { upload: vi.fn() });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(images.transform).toHaveBeenNthCalledWith(1, { width: 320, height: 320, fit: "scale-down" });
    expect(images.transform).toHaveBeenNthCalledWith(2, { width: 800, height: 800, fit: "scale-down" });
    expect(message.extendedTextMessage).toMatchObject({
      thumbnailDirectPath: "/thumbnail",
      thumbnailWidth: 800,
      thumbnailHeight: 600,
      mediaKey: expect.any(Uint8Array),
      thumbnailEncSha256: expect.any(Uint8Array),
      jpegThumbnail: Buffer.from(jpeg),
    });
  });

  it("keeps the compact preview when uploading the large thumbnail fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(html())
      .mockResolvedValueOnce(new Response(jpeg, { headers: { "content-type": "image/jpeg" } })));
    const upload = vi.fn().mockRejectedValue(new Error("upload failed"));
    const preview = await patrolLinkPreview(text, host, mockImages().binding, upload);
    expect(preview?.jpegThumbnail).toEqual(Buffer.from(jpeg));
    expect(preview?.highQualityThumbnail).toBeUndefined();
  });

  it.each([undefined, "", "other.example.com"])("skips fetches when the report host is disabled (%s)", async hosts => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await patrolLinkPreview(text, hosts, mockImages().binding)).toBeNull();
    expect(assertSafeOutboundUrlWithDns).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["", photo.replace("/storage/", "/admin/"), photo.replace("erp.example.com", "other.example.com"),
    photo.replace("erp.example.com", "erp.example.com.attacker.test"), photo + "?token=secret"])
    ("skips missing or unsafe photo URLs (%s)", async imageUrl => {
      mockReport(imageUrl);
      const fetch = vi.fn().mockResolvedValueOnce(html());
      vi.stubGlobal("fetch", fetch);
      expect(await patrolLinkPreview(text, host, mockImages().binding)).toBeNull();
      expect(fetch).toHaveBeenCalledTimes(1);
    });

  it("does not follow a report redirect", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.redirect(photo));
    vi.stubGlobal("fetch", fetch);
    expect(await patrolLinkPreview(text, host, mockImages().binding)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([[true, 128 * 1024], [false, 2 * 1024 * 1024]])("rejects a streamed response beyond its limit (HTML: %s)", async (reportTooLarge, limit) => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(limit));
        controller.enqueue(new Uint8Array(1));
      },
    });
    const oversized = new Response(body, { headers: { "content-type": reportTooLarge ? "text/html" : "image/jpeg" } });
    const fetch = vi.fn();
    if (!reportTooLarge) fetch.mockResolvedValueOnce(html());
    fetch.mockResolvedValueOnce(oversized);
    vi.stubGlobal("fetch", fetch);
    const images = mockImages();
    expect(await patrolLinkPreview(text, host, images.binding)).toBeNull();
    expect(images.input).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(reportTooLarge ? 1 : 2);
  });

  it("falls back to text even if the image transformation stalls past the deadline", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const fetch = vi.fn().mockResolvedValueOnce(html())
      .mockResolvedValueOnce(new Response(jpeg, { headers: { "content-type": "image/jpeg" } }));
    vi.stubGlobal("fetch", fetch);
    const images = mockImages();
    images.output.mockImplementation(() => {
      deadline.abort();
      return new Promise(() => {});
    });
    const linkPreview = await patrolLinkPreview(text, host, images.binding);
    expect(timeout).toHaveBeenCalledWith(4000);
    expect(linkPreview).toBeNull();
    const message = await generateWAMessageContent({ text, linkPreview }, { upload: vi.fn() });
    expect(message.extendedTextMessage).toMatchObject({ text });
    expect(message.extendedTextMessage?.jpegThumbnail).toBeUndefined();
  });
});
