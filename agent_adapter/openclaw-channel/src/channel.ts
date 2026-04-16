import {
  createChatChannelPlugin,
  createChannelPluginBase,
} from "openclaw/plugin-sdk/channel-core";
import type { ResolvedAccount } from "./types.js";
import { AgentClubClient } from "./client.js";
import { createInboundGateway } from "./gateway.js";
import { resolveAccount, inspectAccount } from "./setup.js";
import { parseSessionKey } from "./session.js";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { ContentType } from "./types.js";

export { resolveAccount, inspectAccount } from "./setup.js";

// ---------------------------------------------------------------------------
// Runtime state — module-level client holder
// ---------------------------------------------------------------------------

let _client: AgentClubClient | null = null;

export function getClient(): AgentClubClient {
  if (!_client) throw new Error("Agent Club client not connected");
  return _client;
}

export function setClient(client: AgentClubClient | null): void {
  _client = client;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inferContentType(mimeOrCategory: string): ContentType {
  const lower = mimeOrCategory.toLowerCase();
  if (lower === "image" || lower.startsWith("image/")) return "image";
  if (lower === "audio" || lower.startsWith("audio/")) return "audio";
  if (lower === "video" || lower.startsWith("video/")) return "video";
  return "file";
}

// ---------------------------------------------------------------------------
// Plugin object — SDK-compatible ChannelPlugin
// ---------------------------------------------------------------------------

export const agentClubPlugin = createChatChannelPlugin<ResolvedAccount>({
  base: createChannelPluginBase({
    id: "agent-club",
    setup: {
      resolveAccount,
      inspectAccount,
    },
  }),

  outbound: {
    attachedResults: {
      async sendText(params: { to: string; text: string }) {
        const parsed = parseSessionKey(params.to);
        if (!parsed) throw new Error(`Invalid session key: ${params.to}`);

        getClient().sendMessage({
          chat_type: parsed.chatType,
          chat_id: parsed.chatId,
          content: params.text,
          content_type: "text",
        });

        return {};
      },
    },
    base: {
      async sendMedia(params: { to: string; filePath: string; caption?: string }) {
        const parsed = parseSessionKey(params.to);
        if (!parsed) throw new Error(`Invalid session key: ${params.to}`);

        const fileBuffer = await readFile(params.filePath);
        const fileName = basename(params.filePath);
        const upload = await getClient().uploadFile(fileBuffer, fileName);

        getClient().sendMessage({
          chat_type: parsed.chatType,
          chat_id: parsed.chatId,
          content: params.caption || "",
          content_type: inferContentType(upload.content_type),
          file_url: upload.url,
          file_name: upload.filename,
        });
      },
    },
  },
});

// ---------------------------------------------------------------------------
// Runtime lifecycle — connect / disconnect the Socket.IO client
// ---------------------------------------------------------------------------

export interface ConnectOptions {
  account: ResolvedAccount;
  onInbound: (msg: import("./gateway.js").InboundMessage) => void;
  logger?: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

export async function connectRuntime(opts: ConnectOptions): Promise<void> {
  const { account, onInbound, logger } = opts;

  let gateway: ((msg: import("./types.js").NewMessagePayload) => void) | null = null;
  const pendingMessages: import("./types.js").NewMessagePayload[] = [];

  const client = new AgentClubClient({
    config: {
      serverUrl: account.serverUrl,
      agentToken: account.agentToken,
      requireMention: account.requireMention,
      allowFrom: account.allowFrom,
    },
    onMessage: (msg) => {
      if (gateway) gateway(msg);
      else pendingMessages.push(msg);
    },
    onOfflineMessages: (msgs) => {
      for (const msg of msgs) {
        if (gateway) gateway(msg);
        else pendingMessages.push(msg);
      }
    },
    logger,
  });

  const authResult = await client.connect();

  gateway = createInboundGateway({
    agentUserId: authResult.user_id,
    account,
    onInbound,
    logger,
  });

  for (const msg of pendingMessages) gateway(msg);

  setClient(client);
}

export function disconnectRuntime(): void {
  _client?.disconnect();
  setClient(null);
}
