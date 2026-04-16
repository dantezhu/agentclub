/**
 * Type stubs for openclaw SDK — allows building the plugin standalone
 * without having openclaw installed as a dev dependency.
 * At runtime, the real openclaw package provides these APIs.
 */
declare module "openclaw/plugin-sdk/channel-core" {
  export interface ChannelPluginBase<TAccount> {
    id: string;
    setup: {
      resolveAccount: (cfg: Record<string, unknown>, accountId?: string | null) => TAccount;
      inspectAccount: (cfg: Record<string, unknown>, accountId?: string | null) => {
        enabled: boolean;
        configured: boolean;
        tokenStatus: string;
      };
    };
  }

  export interface ChatChannelPluginOptions<TAccount> {
    base: ChannelPluginBase<TAccount>;
    outbound?: {
      attachedResults?: {
        sendText: (params: { to: string; text: string }) => Promise<{ messageId?: string }>;
      };
      base?: {
        sendMedia: (params: { to: string; filePath: string; caption?: string }) => Promise<void>;
      };
    };
    security?: unknown;
    pairing?: unknown;
    threading?: unknown;
  }

  export interface PluginApi {
    config: unknown;
    pluginConfig?: Record<string, unknown>;
    logger: {
      debug: (...args: unknown[]) => void;
      info: (...args: unknown[]) => void;
      warn: (...args: unknown[]) => void;
      error: (...args: unknown[]) => void;
    };
    registrationMode: string;
    resolvePath: (input: string) => string;
    runtime: PluginRuntime;
  }

  export interface PluginRuntime {
    agent: {
      resolveAgentDir: (cfg: unknown) => string;
      resolveAgentWorkspaceDir: (cfg: unknown) => string;
      resolveAgentTimeoutMs: (cfg: unknown) => number;
      runEmbeddedAgent: (params: {
        sessionId: string;
        runId: string;
        sessionFile: string;
        workspaceDir: string;
        prompt: string;
        timeoutMs: number;
      }) => Promise<unknown>;
    };
    channel: {
      routing: {
        resolveAgentRoute: (params: {
          cfg: unknown;
          channel: string;
          accountId: string;
          peer: { kind: string; id: string };
        }) => { sessionKey: string; accountId: string };
      };
    };
  }

  export interface ChannelPluginEntry {
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
    setup: ChannelPluginBase<TAccount>["setup"];
  }): ChannelPluginBase<TAccount>;

  export function createChatChannelPlugin<TAccount>(
    opts: ChatChannelPluginOptions<TAccount>,
  ): unknown;

  export function defineChannelPluginEntry(opts: ChannelPluginEntry): unknown;

  export function defineSetupPluginEntry(plugin: unknown): unknown;
}

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
    key?: string;
  }): RuntimeStore<T>;
}
