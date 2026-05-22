import type { ChatType } from "./types.js";
import { CHANNEL_ID, SESSION_KEY_SEPARATOR } from "./constants.js";

/**
 * Separator used in this channel's conversation-side session key.
 * Format: "agentclub:{chatType}:{chatId}"
 *
 * NOTE: this is distinct from the OpenClaw SDK's internal agent session
 * key (shaped `agent:<agentId>:<channel>:<kind>:<peerId>`, built by
 * `buildAgentPeerSessionKey` and returned from `resolveAgentRoute`).
 * The SDK key is for agent state / concurrency scoping; the key below is
 * the conversation-addressable identifier OpenClaw core threads through
 * `resolveInboundConversation` / `resolveDeliveryTarget` — its tail is
 * ALWAYS the same agentclub `chat_id` that the server uses to dispatch
 * `send_message`. Keeping these two namespaces unambiguously separate
 * is what prevents the class of bug where a reply targets a stale
 * conversation ID after the chat has been recreated.
 */
export interface ParsedSession {
  chatType: ChatType;
  /**
   * The agentclub `chat_id` — the synthetic uuid of a `direct_chats` or
   * `groups` row, NOT a user id. This is the exact value we hand back to
   * `client.sendMessage({chat_id})` on reply.
   */
  chatId: string;
}

/**
 * Build this channel's conversation-side session key from IM chat
 * coordinates. The tail is the server-side `chat_id`, stable for the
 * lifetime of that conversation row; deleting+recreating a chat yields
 * a NEW id and therefore a new key (by design — a fresh conversation
 * should behave like a fresh session).
 *
 * @example toSessionKey("direct", "abc123") => "agentclub:direct:abc123"
 */
export function toSessionKey(chatType: ChatType, chatId: string): string {
  return `${CHANNEL_ID}${SESSION_KEY_SEPARATOR}${chatType}${SESSION_KEY_SEPARATOR}${chatId}`;
}

/**
 * Parse a session key built by `toSessionKey` back into IM chat
 * coordinates. Returns null if the key does not belong to this channel
 * (e.g. if an SDK-shaped `agent:...` key accidentally reaches here).
 */
export function parseSessionKey(sessionKey: string): ParsedSession | null {
  if (!sessionKey.startsWith(CHANNEL_ID + SESSION_KEY_SEPARATOR)) return null;
  const rest = sessionKey.slice(CHANNEL_ID.length + SESSION_KEY_SEPARATOR.length);
  const idx = rest.indexOf(SESSION_KEY_SEPARATOR);
  if (idx === -1) return null;

  const chatType = rest.slice(0, idx) as ChatType;
  const chatId = rest.slice(idx + SESSION_KEY_SEPARATOR.length);
  if (!chatId || (chatType !== "group" && chatType !== "direct")) return null;

  return { chatType, chatId };
}
