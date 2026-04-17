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
  /**
   * Called once per message the gateway has "consumed" (i.e. taken
   * responsibility for), whether it was forwarded via `onInbound` or filtered
   * out. Used to ACK the message back to the IM server so it won't be replayed
   * on subsequent reconnects.
   */
  onAck?: (messageId: string) => void;
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
const SEEN_MESSAGE_CAPACITY = 1024;

export function createInboundGateway(opts: InboundGatewayOptions) {
  const { agentUserId, account, onInbound, onAck } = opts;
  const logger = opts.logger ?? {
    info: (...args: unknown[]) => console.log("[agent-club:gw]", ...args),
    warn: (...args: unknown[]) => console.warn("[agent-club:gw]", ...args),
  };

  // Second layer of defense: dedupe recently-seen message ids within this
  // process. The primary mechanism is ACK-based clearing on the server, but
  // if ACKs are in-flight during a rapid reconnect the server may replay the
  // same `offline_messages` batch more than once, so we also track ids here.
  const seenIds = new Set<string>();
  const seenQueue: string[] = [];
  const markSeen = (id: string): boolean => {
    if (!id) return false;
    if (seenIds.has(id)) return true;
    seenIds.add(id);
    seenQueue.push(id);
    if (seenQueue.length > SEEN_MESSAGE_CAPACITY) {
      const evicted = seenQueue.shift();
      if (evicted) seenIds.delete(evicted);
    }
    return false;
  };

  const ack = (id: string): void => {
    if (id && onAck) onAck(id);
  };

  return function handleMessage(msg: NewMessagePayload): void {
    // Agent's own messages never appear in its own unread list, so no ACK.
    if (msg.sender_id === agentUserId) return;

    if (markSeen(msg.id)) {
      logger.warn(`Duplicate inbound message ${msg.id} ignored`);
      // Still ACK in case the prior ACK was lost in-flight.
      ack(msg.id);
      return;
    }

    if (account.allowFrom.length > 0 && !account.allowFrom.includes(msg.sender_id)) {
      logger.warn(`Ignored message from ${msg.sender_name} (not in allowFrom)`);
      ack(msg.id);
      return;
    }

    if (msg.chat_type === "group" && account.requireMention) {
      const mentioned = Array.isArray(msg.mentions) && msg.mentions.includes(agentUserId);
      if (!mentioned) {
        ack(msg.id);
        return;
      }
    }

    let text = msg.content || "";
    if (msg.file_url && msg.content_type !== "text") {
      const label = msg.file_name || msg.file_url;
      text = text ? `${text}\n[${msg.content_type}: ${label}]` : `[${msg.content_type}: ${label}]`;
    }

    if (!text.trim()) {
      ack(msg.id);
      return;
    }

    const sessionKey = toSessionKey(msg.chat_type, msg.chat_id);

    logger.info(
      `Inbound [${msg.chat_type}:${msg.chat_id}] from ${msg.sender_name}: ${text.slice(0, 80)}`,
    );

    // ACK immediately on accept — "plugin has taken responsibility". This is
    // at-most-once semantics relative to agent execution: if the run itself
    // crashes mid-way, the user can resend. It is the only way to prevent
    // reply storms when the Socket.IO transport reconnects before the run
    // finishes.
    ack(msg.id);

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
