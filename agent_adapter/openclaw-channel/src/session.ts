import type { ChatType } from "./types.js";

/**
 * Separator used in the OpenClaw session key.
 * Format: "agentclub:{chatType}:{chatId}"
 */
const CHANNEL_PREFIX = "agentclub";
const SEP = ":";

export interface ParsedSession {
  chatType: ChatType;
  chatId: string;
}

/**
 * Build an OpenClaw session key from IM chat coordinates.
 *
 * @example toSessionKey("direct", "abc123") => "agentclub:direct:abc123"
 */
export function toSessionKey(chatType: ChatType, chatId: string): string {
  return `${CHANNEL_PREFIX}${SEP}${chatType}${SEP}${chatId}`;
}

/**
 * Parse an OpenClaw session key back into IM chat coordinates.
 * Returns null if the key does not belong to this channel.
 */
export function parseSessionKey(sessionKey: string): ParsedSession | null {
  if (!sessionKey.startsWith(CHANNEL_PREFIX + SEP)) return null;
  const rest = sessionKey.slice(CHANNEL_PREFIX.length + SEP.length);
  const idx = rest.indexOf(SEP);
  if (idx === -1) return null;

  const chatType = rest.slice(0, idx) as ChatType;
  const chatId = rest.slice(idx + SEP.length);
  if (!chatId || (chatType !== "group" && chatType !== "direct")) return null;

  return { chatType, chatId };
}
