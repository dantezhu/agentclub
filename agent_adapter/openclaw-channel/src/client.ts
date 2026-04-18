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
  info: (...args: unknown[]) => console.log("[agentclub]", ...args),
  warn: (...args: unknown[]) => console.warn("[agentclub]", ...args),
  error: (...args: unknown[]) => console.error("[agentclub]", ...args),
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
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

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
        this.startHeartbeat(data.heartbeat_interval);
        resolve(data);
      };

      // Subscribe to every auth_ok — the server re-sends it on each
      // reconnect. Re-subscribing also lets config changes to
      // heartbeat_interval take effect without restarting the process.
      this.socket.on("auth_ok", onAuthOk);

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
    this.stopHeartbeat();
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this._connected = false;
      this._agentUserId = null;
      this._displayName = null;
    }
  }

  /**
   * (Re)start the application-level heartbeat. Driven off `auth_ok`
   * payload so the IM server's Config (`HEARTBEAT_INTERVAL`) is the
   * single source of truth across all clients; the server uses our
   * `last_seen` alongside the ws-connection flag to decide real online
   * status, so a silently-dead TCP path eventually surfaces as offline.
   */
  private startHeartbeat(intervalSeconds?: number): void {
    this.stopHeartbeat();
    const sec = Number(intervalSeconds);
    const ms = (Number.isFinite(sec) && sec > 0 ? sec : 30) * 1000;
    this.heartbeatTimer = setInterval(() => {
      if (this.socket?.connected) this.socket.emit("heartbeat");
    }, ms);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  sendMessage(payload: SendMessagePayload): void {
    this.ensureConnected();
    this.socket!.emit("send_message", payload);
  }

  /**
   * Advance the server-side read cursor. Equivalent to saying "I have
   * processed everything in this chat up to and including these messages."
   * Safe to call when disconnected (no-op) — anything unread will be
   * re-delivered via `offline_messages` on the next reconnect.
   */
  markRead(messageIds: string | string[]): void {
    const ids = Array.isArray(messageIds) ? messageIds : [messageIds];
    if (!ids.length || !this.socket?.connected) return;
    this.socket.emit("mark_read", { message_ids: ids });
  }

  /**
   * Fetch the member roster for a group chat (token-authenticated mirror of
   * the web endpoint). Used by the channel to resolve display-name ↔ user-id
   * pairs for the @mention protocol. Returns empty list on any failure so
   * callers can degrade gracefully (no mention autocomplete is strictly
   * better than a crash).
   */
  async listGroupMembers(groupId: string): Promise<
    Array<{
      id: string;
      display_name: string;
      is_agent: boolean;
      role: string;
    }>
  > {
    try {
      const resp = await fetch(
        `${this.serverUrl}/api/agent/groups/${encodeURIComponent(groupId)}/members`,
        { headers: { Authorization: `Bearer ${this.agentToken}` } },
      );
      if (!resp.ok) {
        this.logger.warn(
          `listGroupMembers(${groupId}) → HTTP ${resp.status}`,
        );
        return [];
      }
      return (await resp.json()) as Array<{
        id: string;
        display_name: string;
        is_agent: boolean;
        role: string;
      }>;
    } catch (err) {
      this.logger.warn(`listGroupMembers(${groupId}) failed: ${err}`);
      return [];
    }
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
