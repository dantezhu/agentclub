import {
  createChatChannelPlugin,
  createChannelPluginBase,
} from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { AgentClubConfig, ResolvedAccount, ContentType } from "./types.js";
import { resolveAccount, inspectAccount } from "./setup.js";
import { parseSessionKey } from "./session.js";
import { getActiveClient } from "./runtime.js";
import { startAgentClubMonitor } from "./monitor.js";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

export { resolveAccount, inspectAccount } from "./setup.js";

/** Single-account plugin uses this constant for the only account id. */
const DEFAULT_ACCOUNT_ID = "default";

function inferContentType(mime: string): ContentType {
  const lower = mime.toLowerCase();
  if (lower === "image" || lower.startsWith("image/")) return "image";
  if (lower === "audio" || lower.startsWith("audio/")) return "audio";
  if (lower === "video" || lower.startsWith("video/")) return "video";
  return "file";
}

function getAgentClubSection(cfg: OpenClawConfig | Record<string, unknown>): AgentClubConfig | null {
  const channels = (cfg as Record<string, unknown>).channels as
    | Record<string, unknown>
    | undefined;
  const section = channels?.["agent-club"] as AgentClubConfig | undefined;
  return section ?? null;
}

/**
 * Minimal single-account config adapter.
 *
 * OpenClaw's gateway manager calls plugin.config.listAccountIds(cfg) and
 * plugin.config.resolveAccount(cfg, id) during channel lifecycle, so we
 * must expose these even in a single-account plugin.
 */
const agentClubConfigAdapter = {
  listAccountIds: (cfg: OpenClawConfig): string[] => {
    const section = getAgentClubSection(cfg);
    return section?.serverUrl && section?.agentToken ? [DEFAULT_ACCOUNT_ID] : [];
  },

  resolveAccount: (cfg: OpenClawConfig, accountId?: string | null): ResolvedAccount => {
    return resolveAccount(cfg, accountId ?? DEFAULT_ACCOUNT_ID);
  },

  defaultAccountId: (_cfg: OpenClawConfig): string => DEFAULT_ACCOUNT_ID,

  isConfigured: (account: ResolvedAccount, _cfg: OpenClawConfig): boolean => {
    return Boolean(account.serverUrl && account.agentToken);
  },

  isEnabled: (_account: ResolvedAccount, _cfg: OpenClawConfig): boolean => true,

  describeAccount: (account: ResolvedAccount, _cfg: OpenClawConfig) => ({
    accountId: account.accountId ?? DEFAULT_ACCOUNT_ID,
    enabled: true,
    configured: Boolean(account.serverUrl && account.agentToken),
  }),

  unconfiguredReason: (_account: ResolvedAccount, _cfg: OpenClawConfig): string =>
    "agent-club: serverUrl and agentToken are required",
};

export const agentClubPlugin = createChatChannelPlugin<ResolvedAccount>({
  base: {
    ...createChannelPluginBase({
      id: "agent-club",
      setup: { resolveAccount, inspectAccount },
    }),

    config: agentClubConfigAdapter,

    gateway: {
      startAccount: async (ctx) => {
        const account = resolveAccount(ctx.cfg, ctx.account?.accountId);
        return startAgentClubMonitor({
          account,
          cfg: ctx.cfg,
          abortSignal: ctx.abortSignal,
          log: ctx.log,
        });
      },
    },

    messaging: {
      resolveInboundConversation: ({ to, conversationId }) => {
        const raw = to || conversationId || "";
        if (!raw) return null;
        return { conversationId: raw, parentConversationId: raw };
      },

      resolveDeliveryTarget: ({ conversationId }) => {
        const parsed = parseSessionKey(conversationId);
        if (!parsed) return null;
        return { to: conversationId };
      },

      inferTargetChatType: ({ to }) => {
        const parsed = parseSessionKey(to);
        return parsed?.chatType;
      },

      targetResolver: {
        looksLikeId: (raw: string) => raw.startsWith("agent-club:"),
        hint: "agent-club:direct:<id> or agent-club:group:<id>",
      },
    },
  },

  security: {
    dm: {
      channelKey: "agent-club",
      resolvePolicy: (account) => account.dmPolicy,
      resolveAllowFrom: (account) => account.allowFrom,
      defaultPolicy: "open",
    },
  },

  threading: { topLevelReplyToMode: "reply" },

  outbound: {
    attachedResults: {
      channel: "agent-club",

      async sendText(params) {
        const parsed = parseSessionKey(params.to);
        if (!parsed) throw new Error(`Invalid target: ${params.to}`);

        getActiveClient().sendMessage({
          chat_type: parsed.chatType,
          chat_id: parsed.chatId,
          content: params.text,
          content_type: "text",
        });

        return {};
      },

      async sendMedia(params) {
        const parsed = parseSessionKey(params.to);
        if (!parsed) throw new Error(`Invalid target: ${params.to}`);

        const client = getActiveClient();

        if (params.mediaUrl) {
          client.sendMessage({
            chat_type: parsed.chatType,
            chat_id: parsed.chatId,
            content: params.text || "",
            content_type: "file",
            file_url: params.mediaUrl,
          });
          return {};
        }

        if (params.mediaLocalRoots?.length) {
          const filePath = params.mediaLocalRoots[0] as string;
          const fileBuffer = await readFile(filePath);
          const fileName = basename(filePath);
          const upload = await client.uploadFile(new Uint8Array(fileBuffer), fileName);

          client.sendMessage({
            chat_type: parsed.chatType,
            chat_id: parsed.chatId,
            content: params.text || "",
            content_type: inferContentType(upload.content_type),
            file_url: upload.url,
            file_name: upload.filename,
          });
        }

        return {};
      },
    },
  },
});
