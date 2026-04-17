import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import type { PluginLogger, OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { ResolvedAccount, NewMessagePayload } from "./types.js";
import { AgentClubClient } from "./client.js";
import { createInboundGateway, type InboundMessage } from "./gateway.js";
import { setActiveClient, getRuntime } from "./runtime.js";

const CHANNEL_ID = "agent-club";
const MEDIA_SUBDIR = "media";

/**
 * Map a workspace-local filename to a best-effort MIME type, used to populate
 * `MediaType` / `MediaTypes` on the inbound context. OpenClaw's media
 * autorouter reads this to decide whether to dispatch the attachment through
 * a vision / audio / video tool — getting it wrong means the attachment
 * degrades to "opaque file" rather than being understood.
 *
 * We fall back to a coarse guess from the content_type bucket in our own
 * protocol ("image" → image/*, etc.) when the extension is unknown.
 */
const EXT_TO_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  heic: "image/heic",
  heif: "image/heif",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  pdf: "application/pdf",
  txt: "text/plain",
  json: "application/json",
  csv: "text/csv",
};

function inferMimeType(filename: string, bucket: string | undefined): string | undefined {
  const ext = filename.toLowerCase().split(".").pop() || "";
  if (ext && EXT_TO_MIME[ext]) return EXT_TO_MIME[ext];
  switch (bucket) {
    case "image":
      return "image/*";
    case "audio":
      return "audio/*";
    case "video":
      return "video/*";
    default:
      return undefined;
  }
}

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
 * Download an inbound attachment from the IM server into
 * `<workspaceDir>/media/`.
 *
 * Keeping attachments inside a dedicated `media/` subdir avoids polluting the
 * workspace root (where the agent may keep its own working files) while still
 * being resolvable by the built-in `image` / `file` tools via a relative
 * path like `media/photo.jpg`.
 *
 * Returns both the absolute on-disk path and the workspace-relative path
 * (`media/<filename>`), plus the final filename after sanitization. If the
 * sender-supplied filename had to be sanitized, callers should replace the
 * original filename in the prompt with the workspace-relative path so the
 * agent's tool lookups still resolve.
 */
async function downloadAttachmentToWorkspace(params: {
  serverUrl: string;
  fileUrl: string;
  fileName?: string;
  workspaceDir: string;
  log: PluginLogger;
}): Promise<{
  filePath: string;
  fileName: string;
  relativePath: string;
} | null> {
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

    const mediaDir = path.join(workspaceDir, MEDIA_SUBDIR);
    await fs.mkdir(mediaDir, { recursive: true });

    // Prefer sender-supplied name; fall back to URL basename, then random hex.
    const urlBasename = path.basename(new URL(absoluteUrl).pathname) || "";
    const finalName = sanitizeFilename(
      fileName || urlBasename,
      `inbound-${crypto.randomBytes(4).toString("hex")}.bin`,
    );

    const filePath = path.join(mediaDir, finalName);
    const relativePath = `${MEDIA_SUBDIR}/${finalName}`;
    await fs.writeFile(filePath, buf);
    log.info(`Saved inbound attachment to ${filePath} (${buf.length} bytes)`);
    return { filePath, fileName: finalName, relativePath };
  } catch (err) {
    log.error(`Attachment download failed (${absoluteUrl}): ${formatLogArg(err)}`);
    return null;
  }
}

/**
 * Dispatch an inbound message to the agent via OpenClaw's channel reply
 * pipeline.
 *
 * We deliberately go through `runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher`
 * (the same high-level API used by the official Feishu/Lark channel) rather
 * than `runtime.agent.runEmbeddedAgent`. `runEmbeddedAgent` is a low-level
 * escape hatch that:
 *   - does not read `agents.<id>.model.primary` without being told the exact
 *     provider/model, and
 *   - when you DO force provider/model, it bypasses the SDK's media
 *     autorouter (e.g. the `image` tool refuses to run on a text-only chat
 *     model like `minimax/MiniMax-M2.7` even though MiniMax's own vision
 *     model `MiniMax-VL-01` would have handled it transparently).
 *
 * The buffered-block dispatcher, in contrast, honors the agent's configured
 * primary model, applies media autorouting, and surfaces each reply chunk
 * back to us via the `deliver` callback so we can relay it into the IM
 * server as a regular chat message.
 */
async function processInbound(
  msg: InboundMessage,
  client: AgentClubClient,
  cfg: OpenClawConfig,
  log: PluginLogger,
  account: ResolvedAccount,
): Promise<void> {
  const runtime = getRuntime();
  const workspaceDir = runtime.agent.resolveAgentWorkspaceDir(cfg);

  // 1. If the user attached a file, download it to the agent workspace.
  //    Keep the on-disk absolute path — that's what the SDK's media
  //    autorouter passes to the model provider (MiniMax vision, Gemini
  //    vision, etc.) via MediaPath/MediaPaths. Relative paths like
  //    `media/foo.jpg` are what the built-in `image` tool scans for
  //    inside the prompt text, so we also substitute those in.
  let prompt = msg.text;
  let mediaPayload: Record<string, unknown> = {};
  if (msg.attachmentUrl) {
    const saved = await downloadAttachmentToWorkspace({
      serverUrl: account.serverUrl,
      fileUrl: msg.attachmentUrl,
      fileName: msg.attachmentName,
      workspaceDir,
      log,
    });
    if (saved) {
      const originalRef = msg.attachmentName || saved.fileName;
      if (prompt.includes(originalRef)) {
        prompt = prompt.replace(originalRef, saved.relativePath);
      } else {
        prompt = `${prompt}\n(attachment saved at ${saved.relativePath})`;
      }
      const mime = inferMimeType(saved.fileName, msg.contentType);
      mediaPayload = {
        MediaPath: saved.filePath,
        MediaPaths: [saved.filePath],
        ...(mime ? { MediaType: mime, MediaTypes: [mime] } : {}),
      };
    }
  }

  // 2. Resolve the agent route (session key, agent id) from the user's
  //    config, keyed by channel + accountId + peer. This mirrors the
  //    feishu-lark plugin's `dispatch-context.ts`.
  const peerKind: "direct" | "group" = msg.chatType === "group" ? "group" : "direct";
  const peerId = msg.chatType === "group" ? msg.chatId : msg.senderId;
  const accountId = account.accountId || "default";
  let route: { sessionKey: string; accountId: string; agentId: string };
  try {
    route = runtime.channel.routing.resolveAgentRoute({
      cfg,
      channel: CHANNEL_ID,
      accountId,
      peer: { kind: peerKind, id: peerId },
    });
  } catch (err) {
    log.error(`Route resolution failed for ${msg.sessionKey}: ${formatLogArg(err)}`);
    return;
  }

  const toField = msg.chatType === "group" ? `chat:${msg.chatId}` : `user:${msg.senderId}`;

  // 3. Build the inbound context payload. The SDK reads these fields to
  //    construct the agent envelope, so they must follow the convention
  //    established by existing channel plugins (feishu, slack, etc.).
  //    `WasMentioned` is true for DMs (always engaged) and for groups it
  //    is true by the time we reach here — the gateway already filtered
  //    out group messages that did not mention us when `requireMention`
  //    is on.
  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    ...mediaPayload,
    Body: prompt,
    BodyForAgent: prompt,
    RawBody: msg.text,
    CommandBody: msg.text,
    From: `${CHANNEL_ID}:${msg.senderId}`,
    To: toField,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: msg.chatType,
    GroupSubject: msg.chatType === "group" ? msg.chatId : undefined,
    SenderName: msg.senderName || msg.senderId,
    SenderId: msg.senderId,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: msg.rawPayload.id,
    Timestamp: msg.rawPayload.created_at
      ? msg.rawPayload.created_at * 1000
      : Date.now(),
    WasMentioned: true,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: toField,
  });

  // 4. Fire the buffered-block dispatcher. Each `deliver` call corresponds
  //    to one chunk the SDK wants the channel to surface — for the
  //    buffered dispatcher this is typically one "final" reply + zero or
  //    more tool-use info blocks. We suppress tool events (the user
  //    doesn't need to see internal tool chatter) and skip the sentinel
  //    `NO_REPLY` response the agent uses when it intentionally says
  //    nothing.
  log.info(`Dispatching to agent (session=${route.sessionKey}, agent=${route.agentId})`);
  try {
    await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        deliver: async (payload, info) => {
          if (info?.kind === "tool") return;

          const text = payload.text?.trim() ?? "";
          const mediaUrls = payload.mediaUrls?.length
            ? payload.mediaUrls
            : payload.mediaUrl
              ? [payload.mediaUrl]
              : [];

          if (!text && mediaUrls.length === 0) return;
          if (text === "NO_REPLY" && mediaUrls.length === 0) return;

          if (text && text !== "NO_REPLY") {
            client.sendMessage({
              chat_type: msg.chatType as "group" | "direct",
              chat_id: msg.chatId,
              content: text,
              content_type: "text",
            });
          }
          for (const url of mediaUrls) {
            client.sendMessage({
              chat_type: msg.chatType as "group" | "direct",
              chat_id: msg.chatId,
              content: "",
              content_type: "file",
              file_url: url,
            });
          }
        },
        onSkip: (_payload, info) => {
          if (info?.reason && info.reason !== "silent") {
            log.info(`Agent reply skipped (reason=${String(info.reason)})`);
          }
        },
        onError: (err, info) => {
          log.error(
            `Agent reply (${info?.kind ?? "?"}) failed: ${formatLogArg(err)}`,
          );
        },
      },
      replyOptions: {},
    });
  } catch (err) {
    log.error(`Agent dispatch failed for ${msg.sessionKey}: ${formatLogArg(err)}`);
  }
}
