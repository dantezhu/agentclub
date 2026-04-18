/**
 * Type stubs for the OpenClaw plugin SDK.
 *
 * These allow standalone TypeScript compilation without having openclaw
 * installed as a dev dependency. At runtime the real openclaw package
 * provides these APIs.
 */

// ---------------------------------------------------------------------------
// openclaw/plugin-sdk/channel-core
// ---------------------------------------------------------------------------
declare module "openclaw/plugin-sdk/channel-core" {
  export type OpenClawConfig = Record<string, unknown>;

  export interface PluginLogger {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  }

  /**
   * Minimal type for the route returned by
   * `runtime.channel.routing.resolveAgentRoute`. The real value carries more
   * fields than we consume, but `sessionKey` + `accountId` + `agentId` are
   * the stable ones we rely on here.
   */
  export interface AgentRoute {
    sessionKey: string;
    accountId: string;
    agentId: string;
    [key: string]: unknown;
  }

  /**
   * Shape passed to the buffered dispatcher's `deliver` callback whenever
   * the agent emits a user-facing chunk (final reply, tool event, media,
   * etc.). We only need text + optional media URL(s) for outbound handling.
   */
  export interface ReplyPayload {
    text?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    [key: string]: unknown;
  }

  export interface PluginRuntime {
    agent: {
      resolveAgentDir: (cfg: OpenClawConfig) => string;
      resolveAgentWorkspaceDir: (cfg: OpenClawConfig) => string;
      resolveAgentTimeoutMs: (cfg: OpenClawConfig) => number;
      runEmbeddedAgent: (params: {
        sessionId: string;
        sessionKey?: string;
        agentId?: string;
        agentDir?: string;
        config?: OpenClawConfig;
        messageChannel?: string;
        messageProvider?: string;
        provider?: string;
        model?: string;
        runId: string;
        sessionFile: string;
        workspaceDir: string;
        prompt: string;
        timeoutMs: number;
        [key: string]: unknown;
      }) => Promise<unknown>;
      session: {
        resolveStorePath: (cfg: OpenClawConfig) => string;
      };
    };
    /**
     * Channel-facing APIs. This is the canonical path for a channel plugin
     * to invoke the agent: `channel.reply.dispatchReplyWithBufferedBlockDispatcher`
     * runs the configured primary model AND applies auto media routing (e.g.
     * routes image understanding to MiniMax-VL-01 via the image tool),
     * which the lower-level `runtime.agent.runEmbeddedAgent` escape hatch
     * does NOT do.
     */
    channel: {
      routing: {
        resolveAgentRoute: (params: {
          cfg: OpenClawConfig;
          channel: string;
          accountId: string;
          peer: { kind: "direct" | "group"; id: string };
        }) => AgentRoute;
      };
      reply: {
        finalizeInboundContext: (params: Record<string, unknown>) => unknown;
        dispatchReplyWithBufferedBlockDispatcher: (params: {
          ctx: unknown;
          cfg: OpenClawConfig;
          dispatcherOptions: {
            deliver: (
              payload: ReplyPayload,
              info: { kind?: string; [key: string]: unknown },
            ) => void | Promise<void>;
            onSkip?: (
              payload: ReplyPayload,
              info: { reason?: string; [key: string]: unknown },
            ) => void;
            onError?: (err: unknown, info: { kind?: string }) => void;
          };
          replyOptions?: Record<string, unknown>;
        }) => Promise<unknown>;
      };
      /**
       * Shared media store used by the bundled channels (feishu / telegram /
       * matrix / ...). `saveMediaBuffer` writes to
       * `<openclawConfigDir>/media/<subdir>/<name>---<uuid>.<ext>` and
       * returns the absolute on-disk path plus the detected mime.
       */
      media: {
        saveMediaBuffer: (
          buffer: Buffer,
          contentType?: string,
          subdir?: string,
          maxBytes?: number,
          originalFilename?: string,
        ) => Promise<{
          id: string;
          path: string;
          size: number;
          contentType?: string;
        }>;
      };
    };
    config: {
      loadConfig: () => Promise<OpenClawConfig>;
      writeConfigFile: (cfg: OpenClawConfig) => Promise<void>;
    };
    logging: {
      shouldLogVerbose: () => boolean;
    };
  }

  export interface PluginApi {
    id: string;
    name: string;
    config: OpenClawConfig;
    pluginConfig?: Record<string, unknown>;
    logger: PluginLogger;
    registrationMode: "full" | "setup-only" | "setup-runtime" | "cli-metadata";
    resolvePath: (input: string) => string;
    runtime: PluginRuntime;
    registerChannel: (opts: { plugin: unknown }) => void;
    registerCli: (fn: unknown, opts?: unknown) => void;
    registerGatewayMethod: (opts: unknown) => void;
    registerHttpRoute: (opts: unknown) => void;
  }

  // -- Gateway context types --------------------------------------------------

  export interface GatewayAccountContext<TAccount> {
    account: TAccount;
    cfg: OpenClawConfig;
    runtime: PluginRuntime;
    channelRuntime: unknown;
    abortSignal: AbortSignal;
    log: PluginLogger;
  }

  // -- Channel plugin builder types -------------------------------------------

  export interface ChannelSetup<TAccount> {
    resolveAccount: (
      cfg: OpenClawConfig | Record<string, unknown>,
      accountId?: string | null,
    ) => TAccount;
    inspectAccount: (
      cfg: OpenClawConfig | Record<string, unknown>,
      accountId?: string | null,
    ) => { enabled: boolean; configured: boolean; tokenStatus: string };
  }

  export interface ChannelPluginBase<TAccount> {
    id: string;
    setup: ChannelSetup<TAccount>;
  }

  export interface OutboundSendTextParams {
    cfg: OpenClawConfig;
    to: string;
    text: string;
    accountId?: string | null;
    deps?: unknown;
    replyToId?: string | null;
    threadId?: string | number | null;
    silent?: boolean | null;
    gatewayClientScopes?: readonly string[] | null;
  }

  export interface OutboundSendMediaParams {
    cfg: OpenClawConfig;
    to: string;
    text: string;
    mediaUrl?: string | null;
    mediaLocalRoots?: readonly string[] | null;
    accountId?: string | null;
    deps?: unknown;
    replyToId?: string | null;
    threadId?: string | number | null;
    silent?: boolean | null;
    gatewayClientScopes?: readonly string[] | null;
  }

  export interface ChatChannelPluginOptions<TAccount> {
    base: ChannelPluginBase<TAccount> & {
      config?: {
        listAccountIds: (cfg: OpenClawConfig) => string[];
        resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => TAccount;
        defaultAccountId?: (cfg: OpenClawConfig) => string;
        isEnabled?: (account: TAccount, cfg: OpenClawConfig) => boolean;
        isConfigured?: (
          account: TAccount,
          cfg: OpenClawConfig,
        ) => boolean | Promise<boolean>;
        describeAccount?: (account: TAccount, cfg: OpenClawConfig) => unknown;
        disabledReason?: (account: TAccount, cfg: OpenClawConfig) => string;
        unconfiguredReason?: (account: TAccount, cfg: OpenClawConfig) => string;
      };
      gateway?: {
        startAccount: (ctx: GatewayAccountContext<TAccount>) => Promise<unknown>;
        stopAccount?: (params: {
          cfg: OpenClawConfig;
          accountId: string;
        }) => Promise<unknown>;
        logoutAccount?: (params: {
          accountId: string;
          cfg: OpenClawConfig;
        }) => Promise<unknown>;
      };
      messaging?: {
        resolveInboundConversation?: (params: {
          to?: string;
          conversationId?: string;
          threadId?: string | number;
        }) => { conversationId: string; parentConversationId: string } | null;
        resolveDeliveryTarget?: (params: {
          conversationId: string;
          parentConversationId?: string;
        }) => { to: string; threadId?: string } | null;
        inferTargetChatType?: (params: { to: string }) => string | undefined;
        normalizeTarget?: (raw: string) => string;
        targetResolver?: {
          looksLikeId: (raw: string) => boolean;
          hint: string;
        };
      };
    };
    security?: {
      dm?: {
        channelKey: string;
        resolvePolicy: (account: TAccount) => string | undefined;
        resolveAllowFrom: (account: TAccount) => string[];
        defaultPolicy?: string;
      };
    };
    pairing?: unknown;
    threading?: { topLevelReplyToMode?: string };
    outbound?: {
      attachedResults?: {
        channel?: string;
        sendText: (params: OutboundSendTextParams) => Promise<{ messageId?: string } | object>;
        sendMedia?: (params: OutboundSendMediaParams) => Promise<{ messageId?: string } | object>;
      };
      base?: {
        sendMedia?: (params: OutboundSendMediaParams) => Promise<void>;
      };
    };
  }

  export interface ChannelPluginEntryOptions {
    id: string;
    name: string;
    description: string;
    plugin: unknown;
    setRuntime?: (runtime: PluginRuntime) => void;
    registerCliMetadata?: (api: PluginApi) => void;
    registerFull?: (api: PluginApi) => void;
  }

  export function createChannelPluginBase<TAccount>(opts: {
    id: string;
    setup: ChannelSetup<TAccount>;
  }): ChannelPluginBase<TAccount>;

  export function createChatChannelPlugin<TAccount>(
    opts: ChatChannelPluginOptions<TAccount>,
  ): unknown;

  export function defineChannelPluginEntry(opts: ChannelPluginEntryOptions): unknown;
  export function defineSetupPluginEntry(plugin: unknown): unknown;
}

// ---------------------------------------------------------------------------
// openclaw/plugin-sdk/runtime-store
// ---------------------------------------------------------------------------
declare module "openclaw/plugin-sdk/runtime-store" {
  import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";

  export interface RuntimeStore<T = PluginRuntime> {
    setRuntime: (runtime: T) => void;
    getRuntime: () => T;
    tryGetRuntime: () => T | null;
  }

  export function createPluginRuntimeStore<T = PluginRuntime>(opts: {
    pluginId: string;
    errorMessage?: string;
  }): RuntimeStore<T>;
}
