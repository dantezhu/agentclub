import type { ContentType } from "./types.js";

/**
 * Normalise the `content_type` echoed by `/api/agent/upload`.
 *
 * The IM server currently returns the already-bucketed value
 * (`"image"` / `"audio"` / `"video"` / `"file"`), but we also accept real
 * MIME strings (`"image/png"`) so this helper stays correct if the server
 * ever switches formats. Anything unrecognised falls back to `"file"`.
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
 * True if `url` looks like an http(s) URL. Used to reject remote URLs in
 * agent replies — mirroring the web UI, channels only accept local file
 * paths that can be uploaded to the IM server. Agents wanting to forward
 * a remote asset must download it locally first.
 */
export function isRemoteHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}
