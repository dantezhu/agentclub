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

/** One group the agent is a member of, as returned by `/api/agent/chats`. */
export interface AgentGroupChat {
  id: string;
  name: string;
  avatar?: string | null;
  description?: string | null;
  created_at?: number;
}

/** One direct chat the agent participates in, as returned by `/api/agent/chats`.
 *
 * The `id` field is the ``direct_chats.id`` (the ``chat_id`` that must be
 * passed to ``send_message`` for a direct message). The ``peer_*`` fields
 * describe the human/agent on the other side of the conversation — look
 * these up by display name when an operator asks the agent to "send a
 * message to Bob".
 */
export interface AgentDirectChat {
  id: string;
  peer_id: string;
  peer_name: string;
  peer_avatar?: string | null;
  peer_description?: string | null;
  peer_is_agent?: boolean | number;
}

/** Response from GET /api/agent/chats */
export interface AgentChatsResponse {
  groups: AgentGroupChat[];
  directs: AgentDirectChat[];
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
