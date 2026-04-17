import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import type { PluginLogger, OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { ResolvedAccount, EmbeddedRunResult, NewMessagePayload } from "./types.js";
import { AgentClubClient } from "./client.js";
import { createInboundGateway, type InboundMessage } from "./gateway.js";
import { setActiveClient, getRuntime } from "./runtime.js";

const DEFAULT_AGENT_ID = "main";

/**
 * OpenClaw's plugin logger appears to treat only the first argument as the
 * log message (additional args are silently dropped or interpreted as
 * structured metadata). It also already prefixes each line with the plugin
 * namespace (e.g. `[agent-club]`), so we must NOT add our own prefix or pass
 * multiple positional args — otherwise the visible message collapses to just
 * the namespace tag with an empty body.
 *
 * This helper normalizes any (...args) call to a single joined string so
 * downstream subcomponents (Socket.IO client, gateway, etc.) can keep using
 * console-style variadic logging without losing data.
 */
function formatLogArg(arg: unknown): string {
  if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function joinArgs(args: unknown[]): string {
  return args.map(formatLogArg).join(" ");
}

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
      info: (...args: unknown[]) => log.info(joinArgs(args)),
      warn: (...args: unknown[]) => log.warn(joinArgs(args)),
      error: (...args: unknown[]) => log.error(joinArgs(args)),
    },
  });

  const authResult = await client.connect();
  setActiveClient(client);

  log.info(
    `Connected as ${authResult.display_name} (${authResult.user_id})`,
  );

  gateway = createInboundGateway({
    agentUserId: authResult.user_id,
    account,
    onInbound: (msg) => processInbound(msg, client, cfg, log, account),
    onAck: (id) => client.markRead(id),
    logger: {
      info: (...args: unknown[]) => log.info(joinArgs(args)),
      warn: (...args: unknown[]) => log.warn(joinArgs(args)),
    },
  });

  for (const msg of pendingMessages) gateway(msg);
  pendingMessages.length = 0;

  return new Promise<void>((resolve) => {
    const cleanup = () => {
      client.disconnect();
      setActiveClient(null);
      log.info("Monitor stopped");
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

/**
 * Sanitize an arbitrary inbound filename so it is safe to write into the
 * agent workspace. We strip path separators and known-nasty characters but
 * keep the original extension so downstream tools (image/file) can detect
 * type by suffix.
 */
function sanitizeFilename(raw: string, fallback: string): string {
  const base = (raw || "").replace(/[\\/]/g, "").replace(/[\x00-\x1f]/g, "").trim();
  if (!base) return fallback;
  return base.length > 200 ? base.slice(-200) : base;
}

/**
 * Download an inbound attachment from the IM server and write it into the
 * agent workspace. Returns the absolute on-disk path when successful.
 *
 * We intentionally preserve the filename the sender used (when possible) so
 * the agent's `[image: foo.jpg]` / `[file: foo.pdf]` prompt references
 * resolve via the image / file tool's default workspace-relative lookup.
 */
async function downloadAttachmentToWorkspace(params: {
  serverUrl: string;
  fileUrl: string;
  fileName?: string;
  workspaceDir: string;
  log: PluginLogger;
}): Promise<{ filePath: string; fileName: string } | null> {
  const { serverUrl, fileUrl, fileName, workspaceDir, log } = params;
  if (!fileUrl) return null;

  const absoluteUrl = /^https?:\/\//i.test(fileUrl)
    ? fileUrl
    : new URL(fileUrl, serverUrl).toString();

  try {
    const res = await fetch(absoluteUrl);
    if (!res.ok) {
      log.warn(`Failed to download attachment ${absoluteUrl}: HTTP ${res.status}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());

    await fs.mkdir(workspaceDir, { recursive: true });

    // Prefer sender-supplied name; fall back to URL basename, then random hex.
    const urlBasename = path.basename(new URL(absoluteUrl).pathname) || "";
    const finalName = sanitizeFilename(
      fileName || urlBasename,
      `inbound-${crypto.randomBytes(4).toString("hex")}.bin`,
    );

    const filePath = path.join(workspaceDir, finalName);
    await fs.writeFile(filePath, buf);
    log.info(`Saved inbound attachment to ${filePath} (${buf.length} bytes)`);
    return { filePath, fileName: finalName };
  } catch (err) {
    log.error(`Attachment download failed (${absoluteUrl}): ${formatLogArg(err)}`);
    return null;
  }
}

async function processInbound(
  msg: InboundMessage,
  client: AgentClubClient,
  cfg: OpenClawConfig,
  log: PluginLogger,
  account: ResolvedAccount,
): Promise<void> {
  const runtime = getRuntime();
  const agentDir = runtime.agent.resolveAgentDir(cfg);
  const workspaceDir = runtime.agent.resolveAgentWorkspaceDir(cfg);
  const timeoutMs = runtime.agent.resolveAgentTimeoutMs(cfg);

  const safeSessionId = msg.sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  const agentId = DEFAULT_AGENT_ID;
  const primary = resolvePrimaryModel(cfg, agentId);

  // If the inbound message carries a file, download it into the workspace so
  // the agent's built-in image/file tools can resolve the filename referenced
  // in the prompt (e.g. "[image: photo.jpg]").
  let prompt = msg.text;
  if (msg.attachmentUrl) {
    const saved = await downloadAttachmentToWorkspace({
      serverUrl: account.serverUrl,
      fileUrl: msg.attachmentUrl,
      fileName: msg.attachmentName,
      workspaceDir,
      log,
    });
    if (saved && saved.fileName !== msg.attachmentName) {
      // Keep the prompt in sync with the actual on-disk filename so the
      // agent can reference it verbatim.
      prompt = prompt.replace(msg.attachmentName ?? "", saved.fileName);
    }
  }

  if (!primary) {
    log.warn(
      `No primary model configured in agents.defaults.model.primary; embedded run will fall back to built-in defaults`,
    );
  } else {
    log.debug?.(
      `Using primary model ${primary.provider}/${primary.model} for ${msg.sessionKey}`,
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
      prompt,
      timeoutMs,
      ...(primary ? { provider: primary.provider, model: primary.model } : {}),
    } as Parameters<typeof runtime.agent.runEmbeddedAgent>[0]);

    const result = raw as EmbeddedRunResult | undefined;

    if (result?.didSendViaMessagingTool) {
      log.info(
        `Agent reply dispatched via messaging tool for ${msg.sessionKey}`,
      );
      return;
    }

    if (result?.payloads?.length) {
      for (const payload of result.payloads) {
        if (payload.isError) {
          log.warn(`Agent returned error payload: ${payload.text}`);
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

    log.warn(`Agent produced no payloads for ${msg.sessionKey}`);
  } catch (err) {
    log.error(`Agent run failed: ${formatLogArg(err)}`);
  }
}
