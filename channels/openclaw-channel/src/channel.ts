import {
  createChatChannelPlugin,
  createChannelPluginBase,
} from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import type { AgentClubConfig, ResolvedAccount } from "./types.js";
import { resolveAccount, inspectAccount } from "./setup.js";
import { parseSessionKey } from "./session.js";
import { getActiveClient, tryGetRuntime } from "./runtime.js";
import { startAgentClubMonitor } from "./monitor.js";
import { inferContentTypeFromUploadType } from "./mime.js";
import { basename } from "node:path";

export { resolveAccount, inspectAccount } from "./setup.js";

/** Single-account plugin uses this constant for the only account id. */
const DEFAULT_ACCOUNT_ID = "default";

function getAgentClubSection(cfg: OpenClawConfig | Record<string, unknown>): AgentClubConfig | null {
  const channels = (cfg as Record<string, unknown>).channels as
    | Record<string, unknown>
    | undefined;
  const section = channels?.["agentclub"] as AgentClubConfig | undefined;
  return section ?? null;
}

/**
 * Best-effort resolver for the agent's workspace directory, used by
 * `loadWebMedia` to anchor relative paths (`MEDIA:./image.png`).
 *
 * The runtime store is populated by the plugin entry on startup, so this
 * only returns `undefined` in synthetic test contexts where we're calling
 * `sendMedia` without booting the full plugin. In that case `loadWebMedia`
 * falls back to `getDefaultLocalRoots()`, which already includes the
 * canonical agent workspace on a real host.
 */
function resolveWorkspaceDir(cfg: OpenClawConfig): string | undefined {
  const runtime = tryGetRuntime();
  if (!runtime) return undefined;
  try {
    return runtime.agent.resolveAgentWorkspaceDir(cfg);
  } catch {
    return undefined;
  }
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
    "agentclub: serverUrl and agentToken are required",
};

export const agentClubPlugin = createChatChannelPlugin<ResolvedAccount>({
  base: {
    ...createChannelPluginBase({
      id: "agentclub",
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
        looksLikeId: (raw: string) => raw.startsWith("agentclub:"),
        hint: "agentclub:direct:<id> or agentclub:group:<id>",
      },
    },
  },

  security: {
    dm: {
      channelKey: "agentclub",
      resolvePolicy: (account) => account.dmPolicy,
      resolveAllowFrom: (account) => account.allowFrom,
      defaultPolicy: "open",
    },
  },

  threading: { topLevelReplyToMode: "reply" },

  outbound: {
    attachedResults: {
      channel: "agentclub",

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
        if (!params.mediaUrl) return {};

        const client = getActiveClient();
        const caption = params.text || "";

        // Funnel every outbound media input through the SDK's
        // `loadWebMedia` — same helper feishu / telegram / matrix /
        // discord / whatsapp call. It accepts three shapes:
        //   * `https?://…`           — fetched with SSRF + byte cap
        //   * absolute path          — allowlisted against `localRoots`
        //   * relative path          — resolved against `workspaceDir`
        // so we don't have to replicate any of that (including the
        // post-CVE-2026-26321 allowlist check) in plugin code.
        //
        // `mediaLocalRoots` comes from the outbound context (core reads
        // it out of `channels.agentclub.mediaLocalRoots` if the operator
        // configured one) and is an allowlist, NOT a list of paths to
        // upload — older revisions of this plugin got that wrong.
        const workspaceDir = resolveWorkspaceDir(params.cfg);
        const loaded = await loadWebMedia(params.mediaUrl, {
          localRoots: params.mediaLocalRoots?.length
            ? params.mediaLocalRoots
            : undefined,
          workspaceDir,
        });

        const fileName =
          loaded.fileName ??
          (basename(params.mediaUrl) || "file");
        const upload = await client.uploadFile(
          new Uint8Array(loaded.buffer),
          fileName,
        );
        client.sendMessage({
          chat_type: parsed.chatType,
          chat_id: parsed.chatId,
          content: caption,
          content_type: inferContentTypeFromUploadType(
            loaded.contentType ?? upload.content_type,
          ),
          file_url: upload.url,
          file_name: upload.filename,
        });

        return {};
      },
    },
  },
});
