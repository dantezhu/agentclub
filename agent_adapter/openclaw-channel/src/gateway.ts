import type { NewMessagePayload, ResolvedAccount } from "./types.js";
import { toSessionKey } from "./session.js";

export interface InboundMessage {
  sessionKey: string;
  chatType: string;
  chatId: string;
  senderId: string;
  senderName: string;
  text: string;
  attachmentUrl?: string;
  attachmentName?: string;
  contentType: string;
  rawPayload: NewMessagePayload;
}

export interface InboundGatewayOptions {
  agentUserId: string;
  account: ResolvedAccount;
  onInbound: (msg: InboundMessage) => void;
  logger?: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
}

/**
 * Processes raw IM messages and decides which ones to forward to OpenClaw.
 *
 * Filtering rules:
 * 1. Skip messages sent by the agent itself.
 * 2. If allowFrom is configured, skip messages from unlisted senders.
 * 3. In group chats with requireMention, skip messages without @mention.
 * 4. Direct chats always pass through.
 */
export function createInboundGateway(opts: InboundGatewayOptions) {
  const { agentUserId, account, onInbound } = opts;
  const logger = opts.logger ?? {
    info: (...args: unknown[]) => console.log("[agent-club:gw]", ...args),
    warn: (...args: unknown[]) => console.warn("[agent-club:gw]", ...args),
  };

  return function handleMessage(msg: NewMessagePayload): void {
    if (msg.sender_id === agentUserId) return;

    if (account.allowFrom.length > 0 && !account.allowFrom.includes(msg.sender_id)) {
      logger.warn(`Ignored message from ${msg.sender_name} (not in allowFrom)`);
      return;
    }

    if (msg.chat_type === "group" && account.requireMention) {
      const mentioned = Array.isArray(msg.mentions) && msg.mentions.includes(agentUserId);
      if (!mentioned) return;
    }

    let text = msg.content || "";
    if (msg.file_url && msg.content_type !== "text") {
      const label = msg.file_name || msg.file_url;
      text = text ? `${text}\n[${msg.content_type}: ${label}]` : `[${msg.content_type}: ${label}]`;
    }

    if (!text.trim()) return;

    const sessionKey = toSessionKey(msg.chat_type, msg.chat_id);

    logger.info(
      `Inbound [${msg.chat_type}:${msg.chat_id}] from ${msg.sender_name}: ${text.slice(0, 80)}`,
    );

    onInbound({
      sessionKey,
      chatType: msg.chat_type,
      chatId: msg.chat_id,
      senderId: msg.sender_id,
      senderName: msg.sender_name,
      text,
      attachmentUrl: msg.file_url || undefined,
      attachmentName: msg.file_name || undefined,
      contentType: msg.content_type,
      rawPayload: msg,
    });
  };
}
