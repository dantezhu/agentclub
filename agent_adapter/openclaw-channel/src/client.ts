import { io, type Socket } from "socket.io-client";
import type {
  AgentClubConfig,
  AuthOkPayload,
  NewMessagePayload,
  PresencePayload,
  SendMessagePayload,
  UploadResponse,
} from "./types.js";

export type MessageHandler = (msg: NewMessagePayload) => void;

export interface AgentClubClientOptions {
  config: AgentClubConfig;
  onMessage: MessageHandler;
  onOfflineMessages?: (msgs: NewMessagePayload[]) => void;
  onPresence?: (data: PresencePayload) => void;
  onError?: (err: { message: string }) => void;
  logger?: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

const DEFAULT_LOGGER = {
  info: (...args: unknown[]) => console.log("[agent-club]", ...args),
  warn: (...args: unknown[]) => console.warn("[agent-club]", ...args),
  error: (...args: unknown[]) => console.error("[agent-club]", ...args),
};

/**
 * Socket.IO client wrapper for the Agent Club IM server.
 *
 * Handles connection lifecycle, authentication, reconnection, and
 * bidirectional message passing.
 */
export class AgentClubClient {
  private socket: Socket | null = null;
  private readonly config: AgentClubConfig;
  private readonly onMessage: MessageHandler;
  private readonly onOfflineMessages?: (msgs: NewMessagePayload[]) => void;
  private readonly onPresence?: (data: PresencePayload) => void;
  private readonly onError?: (err: { message: string }) => void;
  private readonly logger: NonNullable<AgentClubClientOptions["logger"]>;

  /** Resolved after auth_ok; holds the agent's own user ID on the IM server */
  private _agentUserId: string | null = null;
  private _displayName: string | null = null;
  private _connected = false;
  private _authPromise: { resolve: (v: AuthOkPayload) => void; reject: (e: Error) => void } | null =
    null;

  constructor(opts: AgentClubClientOptions) {
    this.config = opts.config;
    this.onMessage = opts.onMessage;
    this.onOfflineMessages = opts.onOfflineMessages;
    this.onPresence = opts.onPresence;
    this.onError = opts.onError;
    this.logger = opts.logger ?? DEFAULT_LOGGER;
  }

  get agentUserId(): string | null {
    return this._agentUserId;
  }

  get displayName(): string | null {
    return this._displayName;
  }

  get connected(): boolean {
    return this._connected;
  }

  // -- Lifecycle ------------------------------------------------------------

  /**
   * Connect to the IM server and wait for auth_ok.
   * Resolves with the agent's identity once authenticated.
   */
  async connect(): Promise<AuthOkPayload> {
    if (this.socket) {
      throw new Error("Already connected. Call disconnect() first.");
    }

    return new Promise<AuthOkPayload>((resolve, reject) => {
      this._authPromise = { resolve, reject };

      this.socket = io(this.config.serverUrl, {
        auth: { agent_token: this.config.agentToken },
        transports: ["websocket", "polling"],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 30000,
        reconnectionAttempts: Infinity,
      });

      this.socket.on("auth_ok", (data: AuthOkPayload) => {
        this._agentUserId = data.user_id;
        this._displayName = data.display_name;
        this._connected = true;
        this.logger.info(
          `Authenticated as ${data.display_name} (${data.user_id})`,
        );
        this._authPromise?.resolve(data);
        this._authPromise = null;
      });

      this.socket.on("new_message", (data: NewMessagePayload) => {
        this.onMessage(data);
      });

      this.socket.on("offline_messages", (msgs: NewMessagePayload[]) => {
        this.logger.info(`Received ${msgs.length} offline message(s)`);
        if (this.onOfflineMessages) {
          this.onOfflineMessages(msgs);
        } else {
          for (const msg of msgs) this.onMessage(msg);
        }
      });

      this.socket.on("presence", (data: PresencePayload) => {
        this.onPresence?.(data);
      });

      this.socket.on("error", (data: { message: string }) => {
        this.logger.error("Server error:", data.message);
        this.onError?.(data);
      });

      this.socket.on("connect_error", (err: Error) => {
        this.logger.error("Connection error:", err.message);
        if (this._authPromise) {
          this._authPromise.reject(err);
          this._authPromise = null;
        }
      });

      this.socket.on("disconnect", (reason: string) => {
        this._connected = false;
        this.logger.warn("Disconnected:", reason);
      });

      this.socket.on("reconnect", () => {
        this.logger.info("Reconnected");
      });
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this._connected = false;
      this._agentUserId = null;
      this._displayName = null;
      this.logger.info("Disconnected from IM server");
    }
  }

  // -- Messaging ------------------------------------------------------------

  sendMessage(payload: SendMessagePayload): void {
    this.ensureConnected();
    this.socket!.emit("send_message", payload);
  }

  joinChat(chatType: string, chatId: string): void {
    this.ensureConnected();
    this.socket!.emit("join_chat", { chat_type: chatType, chat_id: chatId });
  }

  leaveChat(chatType: string, chatId: string): void {
    this.ensureConnected();
    this.socket!.emit("leave_chat", { chat_type: chatType, chat_id: chatId });
  }

  markRead(chatType: string, chatId: string): void {
    this.ensureConnected();
    this.socket!.emit("mark_read", { chat_type: chatType, chat_id: chatId });
  }

  // -- File upload via HTTP -------------------------------------------------

  /**
   * Upload a file to the IM server using the agent token auth endpoint.
   * Returns the upload metadata (url, filename, content_type).
   */
  async uploadFile(
    fileBuffer: Uint8Array,
    fileName: string,
  ): Promise<UploadResponse> {
    const formData = new FormData();
    const ab = fileBuffer.buffer.slice(
      fileBuffer.byteOffset,
      fileBuffer.byteOffset + fileBuffer.byteLength,
    ) as ArrayBuffer;
    const blob = new Blob([ab]);
    formData.append("file", blob, fileName);

    const resp = await fetch(`${this.config.serverUrl}/api/agent/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.agentToken}`,
      },
      body: formData,
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Upload failed (${resp.status}): ${body}`);
    }

    return (await resp.json()) as UploadResponse;
  }

  // -- Internals ------------------------------------------------------------

  private ensureConnected(): void {
    if (!this.socket?.connected) {
      throw new Error("Not connected to Agent Club IM server");
    }
  }
}
