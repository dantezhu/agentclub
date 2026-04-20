import { describe, it, expect } from "vitest";
import {
  contentTypeFromExtension,
  inferContentTypeFromUrl,
  inferContentTypeFromUploadType,
  isRemoteHttpUrl,
  stripFileScheme,
} from "../src/mime.js";

describe("contentTypeFromExtension", () => {
  it("maps image extensions to image", () => {
    expect(contentTypeFromExtension("png")).toBe("image");
    expect(contentTypeFromExtension("JPG")).toBe("image");
    expect(contentTypeFromExtension("webp")).toBe("image");
  });

  it("maps audio extensions to audio", () => {
    expect(contentTypeFromExtension("mp3")).toBe("audio");
    expect(contentTypeFromExtension("M4A")).toBe("audio");
  });

  it("maps video extensions to video", () => {
    expect(contentTypeFromExtension("mp4")).toBe("video");
    expect(contentTypeFromExtension("MOV")).toBe("video");
  });

  it("falls back to file for unknown or empty extensions", () => {
    expect(contentTypeFromExtension("pdf")).toBe("file");
    expect(contentTypeFromExtension("")).toBe("file");
    expect(contentTypeFromExtension("bin")).toBe("file");
  });
});

describe("inferContentTypeFromUrl", () => {
  it("infers from a plain remote URL", () => {
    expect(inferContentTypeFromUrl("https://cdn.example.com/cat.jpg")).toBe("image");
    expect(inferContentTypeFromUrl("https://example.com/podcast.mp3")).toBe("audio");
    expect(inferContentTypeFromUrl("https://example.com/clip.MP4")).toBe("video");
  });

  it("strips query string and fragment before looking at the extension", () => {
    expect(inferContentTypeFromUrl("https://cdn/cat.jpg?v=2")).toBe("image");
    expect(inferContentTypeFromUrl("https://cdn/song.mp3#t=30")).toBe("audio");
    expect(inferContentTypeFromUrl("https://cdn/cat.jpg?v=2#anchor")).toBe("image");
  });

  it("infers from a bare local filesystem path", () => {
    expect(inferContentTypeFromUrl("/tmp/upload.png")).toBe("image");
    expect(inferContentTypeFromUrl("./relative/note.txt")).toBe("file");
  });

  it("returns file when no extension is present", () => {
    expect(inferContentTypeFromUrl("https://example.com/no-ext")).toBe("file");
    expect(inferContentTypeFromUrl("https://example.com/")).toBe("file");
  });

  it("does not mistake a dot in the directory for an extension", () => {
    expect(inferContentTypeFromUrl("https://example.com/v1.0/README")).toBe("file");
    expect(inferContentTypeFromUrl("/tmp/dot.in.dir/file")).toBe("file");
  });
});

describe("inferContentTypeFromUploadType", () => {
  it("accepts server bucket names", () => {
    expect(inferContentTypeFromUploadType("image")).toBe("image");
    expect(inferContentTypeFromUploadType("audio")).toBe("audio");
    expect(inferContentTypeFromUploadType("video")).toBe("video");
    expect(inferContentTypeFromUploadType("file")).toBe("file");
  });

  it("accepts real MIME types", () => {
    expect(inferContentTypeFromUploadType("image/png")).toBe("image");
    expect(inferContentTypeFromUploadType("audio/mpeg")).toBe("audio");
    expect(inferContentTypeFromUploadType("video/mp4")).toBe("video");
    expect(inferContentTypeFromUploadType("application/pdf")).toBe("file");
  });

  it("handles null / undefined / empty", () => {
    expect(inferContentTypeFromUploadType(undefined)).toBe("file");
    expect(inferContentTypeFromUploadType(null)).toBe("file");
    expect(inferContentTypeFromUploadType("")).toBe("file");
  });
});

describe("isRemoteHttpUrl", () => {
  it("recognises http and https", () => {
    expect(isRemoteHttpUrl("http://example.com/a.png")).toBe(true);
    expect(isRemoteHttpUrl("https://example.com/a.png")).toBe(true);
    expect(isRemoteHttpUrl("HTTPS://EXAMPLE.COM/a.png")).toBe(true);
  });

  it("rejects non-http schemes and bare paths", () => {
    expect(isRemoteHttpUrl("file:///tmp/a.png")).toBe(false);
    expect(isRemoteHttpUrl("/tmp/a.png")).toBe(false);
    expect(isRemoteHttpUrl("./a.png")).toBe(false);
    expect(isRemoteHttpUrl("data:image/png;base64,xxx")).toBe(false);
  });
});

describe("stripFileScheme", () => {
  it("strips the file:// prefix when present", () => {
    expect(stripFileScheme("file:///tmp/x.png")).toBe("/tmp/x.png");
  });

  it("leaves non-file inputs untouched", () => {
    expect(stripFileScheme("/tmp/x.png")).toBe("/tmp/x.png");
    expect(stripFileScheme("https://x.com/y.png")).toBe("https://x.com/y.png");
  });
});
