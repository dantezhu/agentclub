// ---------------------------------------------------------------------------
// Agent Club IM server protocol types
// ---------------------------------------------------------------------------

/** Plugin configuration stored in openclaw.config.json under channels.agent-club */
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

// -- Socket.IO auth payloads ------------------------------------------------

export interface SocketAuth {
  agent_token: string;
}

/** Server emits this on successful connection */
export interface AuthOkPayload {
  user_id: string;
  display_name: string;
  role: string;
  is_agent: boolean;
}

// -- Message types ----------------------------------------------------------

export type ChatType = "group" | "direct";

export type ContentType = "text" | "image" | "audio" | "video" | "file";

/** Payload sent with the send_message client event */
export interface SendMessagePayload {
  chat_type: ChatType;
  chat_id: string;
  content: string;
  content_type: ContentType;
  file_url?: string;
  file_name?: string;
  mentions?: string[];
}

/** Payload received from new_message server event */
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

// -- Other server events ----------------------------------------------------

export interface PresencePayload {
  user_id: string;
  display_name: string;
  is_online: boolean;
  is_agent: boolean;
}

export interface TypingPayload {
  user_id: string;
  display_name: string;
  chat_type: ChatType;
  chat_id: string;
}

export interface JoinChatPayload {
  chat_type: ChatType;
  chat_id: string;
}

/** Response from POST /api/agent/upload */
export interface UploadResponse {
  url: string;
  filename: string;
  content_type: string;
}

// -- Client events (emitted by the plugin) ----------------------------------

export interface ClientEvents {
  send_message: (data: SendMessagePayload) => void;
  join_chat: (data: JoinChatPayload) => void;
  leave_chat: (data: JoinChatPayload) => void;
  typing: (data: { chat_type: ChatType; chat_id: string }) => void;
  mark_read: (data: { chat_type: ChatType; chat_id: string }) => void;
}

export interface ServerEvents {
  auth_ok: (data: AuthOkPayload) => void;
  new_message: (data: NewMessagePayload) => void;
  offline_messages: (data: NewMessagePayload[]) => void;
  presence: (data: PresencePayload) => void;
  typing: (data: TypingPayload) => void;
  error: (data: { message: string }) => void;
  chat_list_updated: () => void;
  unread_updated: () => void;
}
