/**
 * OpenClaw channel plugin entry point for Agent Club IM.
 *
 * Uses defineChannelPluginEntry so OpenClaw can discover this plugin
 * at startup and wire it into the gateway lifecycle.
 */
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import {
  agentClubPlugin,
  resolveAccount,
  connectRuntime,
  disconnectRuntime,
} from "./src/channel.js";
import * as path from "node:path";
import * as crypto from "node:crypto";

const runtimeStore = createPluginRuntimeStore({
  pluginId: "agent-club",
  errorMessage: "agent-club runtime not initialized",
});

export default defineChannelPluginEntry({
  id: "agent-club",
  name: "Agent Club",
  description: "Connect OpenClaw to an Agent Club IM server via Socket.IO",
  plugin: agentClubPlugin,
  setRuntime: runtimeStore.setRuntime,

  registerFull(api) {
    const account = resolveAccount(api.config as Record<string, unknown>);
    const logger = api.logger ?? console;
    const cfg = api.config;

    connectRuntime({
      account,
      onInbound(msg) {
        const runtime = runtimeStore.getRuntime();
        const agentDir = runtime.agent.resolveAgentDir(cfg);
        const workspaceDir = runtime.agent.resolveAgentWorkspaceDir(cfg);
        const timeoutMs = runtime.agent.resolveAgentTimeoutMs(cfg);

        const safeSessionId = msg.sessionKey.replace(/:/g, "_");

        runtime.agent
          .runEmbeddedAgent({
            sessionId: msg.sessionKey,
            runId: crypto.randomUUID(),
            sessionFile: path.join(agentDir, "sessions", `${safeSessionId}.jsonl`),
            workspaceDir,
            prompt: msg.text,
            timeoutMs,
          })
          .catch((err: unknown) => {
            logger.error("[agent-club] Agent run failed:", err);
          });
      },
      logger: {
        info: (...args: unknown[]) => logger.info("[agent-club]", ...args),
        warn: (...args: unknown[]) => logger.warn("[agent-club]", ...args),
        error: (...args: unknown[]) => logger.error("[agent-club]", ...args),
      },
    }).catch((err) => {
      logger.error("[agent-club] Failed to connect:", err);
    });
  },
});

export {
  agentClubPlugin,
  resolveAccount,
  connectRuntime,
  disconnectRuntime,
} from "./src/channel.js";
export type { InboundMessage } from "./src/gateway.js";
export type { AgentClubClient } from "./src/client.js";
export type {
  AgentClubConfig,
  ResolvedAccount,
  NewMessagePayload,
  SendMessagePayload,
  AuthOkPayload,
  ChatType,
  ContentType,
} from "./src/types.js";
export { toSessionKey, parseSessionKey } from "./src/session.js";
