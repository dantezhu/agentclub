import { describe, it, expect } from "vitest";
import {
  inferContentTypeFromUploadType,
  isRemoteHttpUrl,
} from "../src/mime.js";

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

  it("is case-insensitive", () => {
    expect(inferContentTypeFromUploadType("IMAGE")).toBe("image");
    expect(inferContentTypeFromUploadType("Image/PNG")).toBe("image");
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
    expect(isRemoteHttpUrl("")).toBe(false);
  });
});
