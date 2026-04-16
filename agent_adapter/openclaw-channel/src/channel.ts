import type { ResolvedAccount, AgentClubConfig } from "./types.js";
import { AgentClubClient } from "./client.js";
import { createInboundGateway, type InboundMessage } from "./gateway.js";
import { createOutboundHandlers } from "./outbound.js";

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/**
 * Extract and validate the agent-club channel config from the top-level
 * OpenClaw configuration object.
 */
export function resolveAccount(
  cfg: Record<string, unknown>,
  accountId?: string | null,
): ResolvedAccount {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const section = channels?.["agent-club"] as AgentClubConfig | undefined;

  if (!section?.serverUrl) throw new Error("agent-club: serverUrl is required");
  if (!section?.agentToken) throw new Error("agent-club: agentToken is required");

  return {
    accountId: accountId ?? null,
    serverUrl: section.serverUrl,
    agentToken: section.agentToken,
    requireMention: section.requireMention ?? true,
    allowFrom: section.allowFrom ?? [],
    dmPolicy: undefined,
  };
}

export function inspectAccount(
  cfg: Record<string, unknown>,
  _accountId?: string | null,
): { enabled: boolean; configured: boolean; tokenStatus: string } {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const section = channels?.["agent-club"] as AgentClubConfig | undefined;

  return {
    enabled: Boolean(section?.serverUrl && section?.agentToken),
    configured: Boolean(section?.serverUrl && section?.agentToken),
    tokenStatus: section?.agentToken ? "available" : "missing",
  };
}

// ---------------------------------------------------------------------------
// Channel plugin object
//
// This is the main export consumed by index.ts / setup-entry.ts.
// It wires config resolution, outbound messaging, and the gateway lifecycle.
// ---------------------------------------------------------------------------

export interface AgentClubChannelPlugin {
  id: string;
  setup: {
    resolveAccount: typeof resolveAccount;
    inspectAccount: typeof inspectAccount;
  };
  outbound: {
    sendText: (params: { to: string; text: string }) => Promise<{ messageId?: string }>;
    sendMedia: (params: { to: string; filePath: string; caption?: string }) => Promise<void>;
  } | null;
  gateway: {
    start: () => Promise<void>;
    stop: () => void;
  } | null;
  /** Called once the channel runtime is ready. Connects to the IM server. */
  activate: (opts: ActivateOptions) => Promise<void>;
  /** The underlying Socket.IO client (available after activate) */
  client: AgentClubClient | null;
}

export interface ActivateOptions {
  account: ResolvedAccount;
  /** Callback: OpenClaw should process this inbound message */
  onInbound: (msg: InboundMessage) => void;
  logger?: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

export function createAgentClubChannelPlugin(): AgentClubChannelPlugin {
  let client: AgentClubClient | null = null;
  let outbound: ReturnType<typeof createOutboundHandlers> | null = null;

  const plugin: AgentClubChannelPlugin = {
    id: "agent-club",

    setup: {
      resolveAccount,
      inspectAccount,
    },

    get outbound() {
      return outbound;
    },

    gateway: null,

    client: null,

    async activate(opts: ActivateOptions) {
      const { account, onInbound, logger } = opts;

      client = new AgentClubClient({
        config: {
          serverUrl: account.serverUrl,
          agentToken: account.agentToken,
          requireMention: account.requireMention,
          allowFrom: account.allowFrom,
        },
        onMessage: (msg) => gateway(msg),
        onOfflineMessages: (msgs) => {
          for (const msg of msgs) gateway(msg);
        },
        logger,
      });

      const authResult = await client.connect();

      const gateway = createInboundGateway({
        agentUserId: authResult.user_id,
        account,
        onInbound,
        logger,
      });

      outbound = createOutboundHandlers(client);

      plugin.client = client;

      plugin.gateway = {
        start: async () => {
          /* already connected via activate() */
        },
        stop: () => {
          client?.disconnect();
          client = null;
          outbound = null;
          plugin.client = null;
        },
      };
    },
  };

  return plugin;
}
