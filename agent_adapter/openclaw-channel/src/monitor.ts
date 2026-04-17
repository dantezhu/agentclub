import * as path from "node:path";
import * as crypto from "node:crypto";
import type { PluginLogger, OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { ResolvedAccount, EmbeddedRunResult, NewMessagePayload } from "./types.js";
import { AgentClubClient } from "./client.js";
import { createInboundGateway, type InboundMessage } from "./gateway.js";
import { setActiveClient, getRuntime } from "./runtime.js";

const DEFAULT_AGENT_ID = "main";

/**
 * Resolve provider/model from the user's openclaw config.
 *
 * Honors `agents.<agentId>.model.primary` first, then falls back to
 * `agents.defaults.model.primary`. Accepts both "provider/model" strings
 * and aliases declared under `agents.defaults.models.<key>.alias`.
 *
 * Returns undefined when nothing is configured, so callers can decide
 * whether to let core fall back to its own hardcoded defaults.
 */
function resolvePrimaryModel(
  cfg: OpenClawConfig,
  agentId: string,
): { provider: string; model: string } | undefined {
  const anyCfg = cfg as any;
  const agentsCfg = anyCfg?.agents ?? {};
  const perAgent = agentsCfg?.[agentId]?.model?.primary;
  const fromDefaults = agentsCfg?.defaults?.model?.primary;
  const raw = typeof perAgent === "string" && perAgent.trim()
    ? perAgent.trim()
    : typeof fromDefaults === "string" && fromDefaults.trim()
      ? fromDefaults.trim()
      : "";
  if (!raw) return undefined;

  // Alias lookup (e.g. "Minimax" -> "minimax/MiniMax-M2.7")
  if (!raw.includes("/")) {
    const models = agentsCfg?.defaults?.models;
    if (models && typeof models === "object") {
      for (const [key, entry] of Object.entries(models as Record<string, any>)) {
        const alias = typeof entry?.alias === "string" ? entry.alias.trim() : "";
        if (alias.toLowerCase() === raw.toLowerCase() && typeof key === "string" && key.includes("/")) {
          const slash = key.indexOf("/");
          return {
            provider: key.slice(0, slash).trim(),
            model: key.slice(slash + 1).trim(),
          };
        }
      }
    }
    return undefined;
  }

  const slash = raw.indexOf("/");
  const provider = raw.slice(0, slash).trim();
  const model = raw.slice(slash + 1).trim();
  if (!provider || !model) return undefined;
  return { provider, model };
}

export interface MonitorContext {
  account: ResolvedAccount;
  cfg: OpenClawConfig;
  abortSignal: AbortSignal;
  log: PluginLogger;
}

/**
 * Long-running Socket.IO listener for the Agent Club IM server.
 *
 * Called from gateway.startAccount. Returns a promise that stays pending
 * until the abortSignal fires, matching the pattern required by the
 * OpenClaw gateway lifecycle to prevent unwanted restart loops.
 */
export async function startAgentClubMonitor(ctx: MonitorContext): Promise<void> {
  const { account, cfg, abortSignal, log } = ctx;

  if (abortSignal.aborted) return;

  let gateway: ((msg: NewMessagePayload) => void) | null = null;
  const pendingMessages: NewMessagePayload[] = [];

  const client = new AgentClubClient({
    serverUrl: account.serverUrl,
    agentToken: account.agentToken,
    onMessage: (msg) => {
      if (gateway) gateway(msg);
      else pendingMessages.push(msg);
    },
    onOfflineMessages: (msgs) => {
      for (const m of msgs) {
        if (gateway) gateway(m);
        else pendingMessages.push(m);
      }
    },
    logger: {
      info: (...args: unknown[]) => log.info("[agent-club]", ...args),
      warn: (...args: unknown[]) => log.warn("[agent-club]", ...args),
      error: (...args: unknown[]) => log.error("[agent-club]", ...args),
    },
  });

  const authResult = await client.connect();
  setActiveClient(client);

  log.info(
    `[agent-club] Connected as ${authResult.display_name} (${authResult.user_id})`,
  );

  gateway = createInboundGateway({
    agentUserId: authResult.user_id,
    account,
    onInbound: (msg) => processInbound(msg, client, cfg, log),
    logger: {
      info: (...args: unknown[]) => log.info(...args),
      warn: (...args: unknown[]) => log.warn(...args),
    },
  });

  for (const msg of pendingMessages) gateway(msg);
  pendingMessages.length = 0;

  return new Promise<void>((resolve) => {
    const cleanup = () => {
      client.disconnect();
      setActiveClient(null);
      log.info("[agent-club] Monitor stopped");
      resolve();
    };

    if (abortSignal.aborted) {
      cleanup();
      return;
    }
    abortSignal.addEventListener("abort", cleanup, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Inbound message processing
// ---------------------------------------------------------------------------

async function processInbound(
  msg: InboundMessage,
  client: AgentClubClient,
  cfg: OpenClawConfig,
  log: PluginLogger,
): Promise<void> {
  const runtime = getRuntime();
  const agentDir = runtime.agent.resolveAgentDir(cfg);
  const workspaceDir = runtime.agent.resolveAgentWorkspaceDir(cfg);
  const timeoutMs = runtime.agent.resolveAgentTimeoutMs(cfg);

  const safeSessionId = msg.sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  const agentId = DEFAULT_AGENT_ID;
  const primary = resolvePrimaryModel(cfg, agentId);

  if (!primary) {
    log.warn(
      `[agent-club] No primary model configured in agents.defaults.model.primary; embedded run will fall back to built-in defaults`,
    );
  } else {
    log.debug?.(
      `[agent-club] Using primary model ${primary.provider}/${primary.model} for ${msg.sessionKey}`,
    );
  }

  try {
    const raw = await runtime.agent.runEmbeddedAgent({
      sessionId: msg.sessionKey,
      sessionKey: `agent:${agentId}:${msg.sessionKey}`,
      agentId,
      agentDir,
      config: cfg,
      messageChannel: "agent-club",
      runId: crypto.randomUUID(),
      sessionFile: path.join(agentDir, "sessions", `${safeSessionId}.jsonl`),
      workspaceDir,
      prompt: msg.text,
      timeoutMs,
      ...(primary ? { provider: primary.provider, model: primary.model } : {}),
    } as Parameters<typeof runtime.agent.runEmbeddedAgent>[0]);

    const result = raw as EmbeddedRunResult | undefined;

    if (result?.didSendViaMessagingTool) {
      log.info(
        `[agent-club] Agent reply dispatched via messaging tool for ${msg.sessionKey}`,
      );
      return;
    }

    if (result?.payloads?.length) {
      for (const payload of result.payloads) {
        if (payload.isError) {
          log.warn(`[agent-club] Agent returned error payload: ${payload.text}`);
        }

        if (payload.text) {
          client.sendMessage({
            chat_type: msg.chatType as "group" | "direct",
            chat_id: msg.chatId,
            content: payload.text,
            content_type: "text",
          });
        }

        if (payload.mediaUrl) {
          client.sendMessage({
            chat_type: msg.chatType as "group" | "direct",
            chat_id: msg.chatId,
            content: payload.text || "",
            content_type: "file",
            file_url: payload.mediaUrl,
          });
        }
      }
      return;
    }

    log.warn(`[agent-club] Agent produced no payloads for ${msg.sessionKey}`);
  } catch (err) {
    log.error("[agent-club] Agent run failed:", err);
  }
}
