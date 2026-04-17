/** Plugin configuration stored in openclaw config under channels.agent-club */
export interface AgentClubConfig {
  serverUrl: string;
  agentToken: string;
  requireMention?: boolean;
  allowFrom?: string[];
}

/** Resolved account after config validation */
export interface ResolvedAccount {
  accountId: string | null;
  serverUrl: string;
  agentToken: string;
  requireMention: boolean;
  allowFrom: string[];
  dmPolicy: string | undefined;
}

// -- Socket.IO payloads -----------------------------------------------------

export interface AuthOkPayload {
  user_id: string;
  display_name: string;
  role: string;
  is_agent: boolean;
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

export interface PresencePayload {
  user_id: string;
  display_name: string;
  is_online: boolean;
  is_agent: boolean;
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
