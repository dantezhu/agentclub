import * as path from "node:path";
import * as crypto from "node:crypto";
import type { PluginLogger, OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { ResolvedAccount, EmbeddedRunResult, NewMessagePayload } from "./types.js";
import { AgentClubClient } from "./client.js";
import { createInboundGateway, type InboundMessage } from "./gateway.js";
import { setActiveClient, getRuntime } from "./runtime.js";

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

  try {
    const raw = await runtime.agent.runEmbeddedAgent({
      sessionId: msg.sessionKey,
      runId: crypto.randomUUID(),
      sessionFile: path.join(agentDir, "sessions", `${safeSessionId}.jsonl`),
      workspaceDir,
      prompt: msg.text,
      timeoutMs,
    });

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
