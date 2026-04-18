/** Plugin configuration stored in openclaw config under channels.agentclub */
export interface AgentClubConfig {
  serverUrl: string;
  agentToken: string;
  requireMention?: boolean;
  /**
   * user_id allowlist. Entries are concrete user_ids plus the wildcard
   * `"*"`. Empty `[]` denies everyone (default-deny).
   */
  allowFrom?: string[];
  /**
   * Role allowlist, intersected with `allowFrom` (both must pass).
   * Valid entries: `"*"` (any kind), `"human"` (non-agent senders),
   * `"agent"` (agent senders). Empty `[]` denies every kind.
   */
  allowFromKind?: string[];
}

/** Resolved account after config validation */
export interface ResolvedAccount {
  accountId: string | null;
  serverUrl: string;
  agentToken: string;
  requireMention: boolean;
  allowFrom: string[];
  allowFromKind: AllowFromKindToken[];
  dmPolicy: string | undefined;
}

/** Legal tokens for `allowFromKind`. Everything else is rejected at load time. */
export const ALLOW_FROM_KIND_TOKENS = ["*", "human", "agent"] as const;
export type AllowFromKindToken = (typeof ALLOW_FROM_KIND_TOKENS)[number];

// -- Socket.IO payloads -----------------------------------------------------

export interface AuthOkPayload {
  user_id: string;
  display_name: string;
  role: string;
  is_agent: boolean;
  /**
   * Server-advertised cadence (in seconds) at which the client should
   * emit the application-level `heartbeat` event. Optional for backward
   * compatibility with older servers; clients fall back to a safe default.
   */
  heartbeat_interval?: number;
}

export type ChatType = "group" | "direct";
export type ContentType = "text" | "image" | "audio" | "video" | "file";

/** Client → Server: send a message */
export interface SendMessagePayload {
  chat_type: ChatType;
  chat_id: string;
  content: string;
  content_type: ContentType;
  file_url?: string;
  file_name?: string;
  mentions?: string[];
}

/** Server → Client: new message arrived */
export interface NewMessagePayload {
  id: string;
  chat_type: ChatType;
  chat_id: string;
  sender_id: string;
  sender_name: string;
  sender_avatar: string;
  sender_is_agent: boolean;
  content: string;
  content_type: ContentType;
  file_url: string;
  file_name: string;
  mentions: string[];
  created_at: number;
}

/** Response from POST /api/agent/upload */
export interface UploadResponse {
  url: string;
  filename: string;
  content_type: string;
}

// -- runEmbeddedAgent result ------------------------------------------------

export interface RunResultPayload {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string;
  isError?: boolean;
}

export interface EmbeddedRunResult {
  payloads?: RunResultPayload[];
  meta: {
    durationMs: number;
    agentMeta?: {
      sessionId: string;
      provider: string;
      model: string;
    };
    aborted?: boolean;
    error?: { kind: string; message: string };
    stopReason?: string;
  };
  didSendViaMessagingTool?: boolean;
  messagingToolSentTexts?: string[];
}
