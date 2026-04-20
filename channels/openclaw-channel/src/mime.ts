import type { ContentType } from "./types.js";

/**
 * Extensions accepted by the Agent Club IM server's upload endpoint.
 * Kept in sync with `agentclub/config.py :: ALLOWED_EXTENSIONS` on the
 * server side — any extension we list here must also be whitelisted there,
 * otherwise `/api/agent/upload` rejects the file with HTTP 400.
 */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"] as const;
export const AUDIO_EXTENSIONS = ["mp3", "wav", "ogg", "m4a"] as const;
export const VIDEO_EXTENSIONS = ["mp4", "webm", "mov"] as const;

/**
 * Map a bare file extension (no leading dot) to an IM `content_type` bucket.
 * Falls back to `"file"` for unknown extensions — mirrors the server's
 * `_detect_content_type()` behaviour so the channel and server never disagree.
 */
export function contentTypeFromExtension(ext: string): ContentType {
  const lower = ext.toLowerCase();
  if ((IMAGE_EXTENSIONS as readonly string[]).includes(lower)) return "image";
  if ((AUDIO_EXTENSIONS as readonly string[]).includes(lower)) return "audio";
  if ((VIDEO_EXTENSIONS as readonly string[]).includes(lower)) return "video";
  return "file";
}

/**
 * Infer `content_type` from a URL or local path by looking at the trailing
 * extension. Strips query string and fragment first so
 * `https://cdn/cat.jpg?v=2` still resolves to `image`.
 */
export function inferContentTypeFromUrl(url: string): ContentType {
  const path = url.split("?")[0].split("#")[0];
  const dot = path.lastIndexOf(".");
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (dot <= slash) return "file";
  return contentTypeFromExtension(path.slice(dot + 1));
}

/**
 * Normalise the `content_type` value returned by the IM server's
 * `/api/agent/upload` endpoint. Server returns a bucket name
 * (`"image"` / `"audio"` / `"video"` / `"file"`) today, but we also accept
 * real MIME strings (`"image/png"`) so callers that already have a MIME
 * don't have to massage it.
 */
export function inferContentTypeFromUploadType(
  mimeOrBucket: string | undefined | null,
): ContentType {
  if (!mimeOrBucket) return "file";
  const lower = mimeOrBucket.toLowerCase();
  if (lower === "image" || lower.startsWith("image/")) return "image";
  if (lower === "audio" || lower.startsWith("audio/")) return "audio";
  if (lower === "video" || lower.startsWith("video/")) return "video";
  return "file";
}

/**
 * True if a string looks like an absolute URL we can hand straight to the
 * browser — i.e. it already has an `http(s)://` scheme. Anything else
 * (bare paths, `file://`, `data:` URIs) needs to be read locally and
 * re-uploaded before we can reference it from an IM message.
 */
export function isRemoteHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * Strip the `file://` scheme if present, returning a plain filesystem path.
 * Leaves other inputs untouched.
 */
export function stripFileScheme(url: string): string {
  if (url.startsWith("file://")) return url.slice(7);
  return url;
}
