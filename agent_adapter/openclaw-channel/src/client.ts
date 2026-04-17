import { io, type Socket } from "socket.io-client";
import type {
  AuthOkPayload,
  NewMessagePayload,
  SendMessagePayload,
  UploadResponse,
} from "./types.js";

export interface AgentClubClientOptions {
  serverUrl: string;
  agentToken: string;
  onMessage: (msg: NewMessagePayload) => void;
  onOfflineMessages?: (msgs: NewMessagePayload[]) => void;
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
 */
export class AgentClubClient {
  private socket: Socket | null = null;
  private readonly serverUrl: string;
  private readonly agentToken: string;
  private readonly onMessage: (msg: NewMessagePayload) => void;
  private readonly onOfflineMessages?: (msgs: NewMessagePayload[]) => void;
  private readonly logger: NonNullable<AgentClubClientOptions["logger"]>;

  private _agentUserId: string | null = null;
  private _displayName: string | null = null;
  private _connected = false;

  constructor(opts: AgentClubClientOptions) {
    this.serverUrl = opts.serverUrl;
    this.agentToken = opts.agentToken;
    this.onMessage = opts.onMessage;
    this.onOfflineMessages = opts.onOfflineMessages;
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

  /**
   * Connect to the IM server and wait for auth_ok.
   */
  async connect(): Promise<AuthOkPayload> {
    if (this.socket) throw new Error("Already connected");

    return new Promise<AuthOkPayload>((resolve, reject) => {
      this.socket = io(this.serverUrl, {
        auth: { agent_token: this.agentToken },
        transports: ["websocket", "polling"],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 30000,
        reconnectionAttempts: Infinity,
      });

      const onAuthOk = (data: AuthOkPayload) => {
        this._agentUserId = data.user_id;
        this._displayName = data.display_name;
        this._connected = true;
        this.logger.info(`Authenticated as ${data.display_name} (${data.user_id})`);
        resolve(data);
      };

      this.socket.once("auth_ok", onAuthOk);

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

      this.socket.on("error", (data: { message: string }) => {
        this.logger.error("Server error:", data.message);
      });

      this.socket.on("connect_error", (err: Error) => {
        this.logger.error("Connection error:", err.message);
        reject(err);
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
    }
  }

  sendMessage(payload: SendMessagePayload): void {
    this.ensureConnected();
    this.socket!.emit("send_message", payload);
  }

  async uploadFile(fileBuffer: Uint8Array, fileName: string): Promise<UploadResponse> {
    const ab = fileBuffer.buffer.slice(
      fileBuffer.byteOffset,
      fileBuffer.byteOffset + fileBuffer.byteLength,
    ) as ArrayBuffer;
    const formData = new FormData();
    formData.append("file", new Blob([ab]), fileName);

    const resp = await fetch(`${this.serverUrl}/api/agent/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.agentToken}` },
      body: formData,
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Upload failed (${resp.status}): ${body}`);
    }

    return (await resp.json()) as UploadResponse;
  }

  private ensureConnected(): void {
    if (!this.socket?.connected) {
      throw new Error("Not connected to Agent Club IM server");
    }
  }
}
