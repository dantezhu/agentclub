import type { PluginLogger, OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/agent-media-payload";
import type { ResolvedAccount, NewMessagePayload } from "./types.js";
import { AgentClubClient } from "./client.js";
import { createInboundGateway, type InboundMessage } from "./gateway.js";
import { setActiveClient, getRuntime } from "./runtime.js";
import { inferContentTypeFromUploadType } from "./mime.js";
import { basename } from "node:path";

const CHANNEL_ID = "agentclub";

// Matches the upload limit of the Agent Club IM server (see backend
// `config.py` MAX_CONTENT_LENGTH). `saveMediaBuffer` defaults to 5MB which
// would truncate large attachments; we raise it to the IM server's own cap.
const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Wire format for @mentions, mirrored from the feishu channel:
 *   <at user_id="uuid-or-all">display name</at>
 *
 * - `user_id` is authoritative (a uuid, or the literal "all" for @everyone).
 * - The display name is for human rendering only.
 *
 * The agent sees the tags verbatim in its prompt; we additionally supply a
 * system hint listing the group roster so the LLM knows whose user_id maps
 * to which name. When the agent wants to @ someone back, it emits the tag
 * itself in its reply text, and we parse it out (see `extractMentionsFromReply`).
 */
const AT_TAG_RE = /<at user_id="([^"]+)">([^<]*)<\/at>/g;

function hasAtTag(text: string): boolean {
  AT_TAG_RE.lastIndex = 0;
  return AT_TAG_RE.test(text);
}

/**
 * Pull unique user_ids out of agent-emitted `<at user_id="...">` tags so we
 * can forward them in the outbound `mentions` field. The tags themselves
 * stay embedded in the content — the web frontend renders them as pills,
 * and other agents/channels can pattern-match off the same literal.
 */
function extractMentionsFromReply(text: string): string[] {
  if (!text) return [];
  AT_TAG_RE.lastIndex = 0;
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = AT_TAG_RE.exec(text)) !== null) {
    const uid = (m[1] || "").trim();
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    out.push(uid);
  }
  return out;
}

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
 * namespace (e.g. `[agentclub]`), so we must NOT add our own prefix or pass
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
 * Returns the agent's workspace dir so `loadWebMedia` can resolve
 * relative paths (`MEDIA:./image.png`) consistently. Returns undefined on
 * any failure — `loadWebMedia` then falls back to its default roots,
 * which on a real host already include the canonical workspace.
 *
 * The `agentId` argument matters for non-default agents: without it the
 * SDK resolves to the default agent's workspace, and relative paths from
 * a non-default agent would anchor to the wrong directory.
 */
function resolveAgentWorkspace(
  cfg: OpenClawConfig,
  agentId?: string,
): string | undefined {
  try {
    return getRuntime().agent.resolveAgentWorkspaceDir(cfg, agentId);
  } catch {
    return undefined;
  }
}

/**
 * Mirrors OpenClaw core's own `resolveAgentScopedOutboundMediaAccess` by
 * returning the agent-scoped `localRoots` allowlist (default roots PLUS
 * the agent's workspace). The core injects this into outbound adapters'
 * contexts automatically, but `dispatchReplyWithBufferedBlockDispatcher`
 * hands us raw payloads instead — so without this helper, `loadWebMedia`
 * falls back to `getDefaultLocalRoots()` and rejects absolute paths
 * under a non-default agent's workspace as `path-not-allowed`.
 */
function resolveMediaLocalRoots(
  cfg: OpenClawConfig,
  agentId?: string,
): readonly string[] | undefined {
  try {
    return getAgentScopedMediaLocalRoots(cfg, agentId);
  } catch {
    return undefined;
  }
}

/**
 * `loadWebMedia` throws a `LocalMediaAccessError` with a machine-readable
 * `.code` (e.g. `not-found`, `path-not-allowed`, `invalid-file-url`). We
 * surface that code in the error log so "the agent's MEDIA: got silently
 * dropped" bug reports can be triaged without attaching a debugger. We
 * duck-type on `.code` rather than `instanceof` because the SDK's error
 * class isn't exported as a stable type.
 */
function extractMediaErrorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
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
 * Download an inbound attachment from the IM server and hand it off to
 * OpenClaw's shared media store (`~/.openclaw/media/inbound/`), matching the
 * convention used by the bundled Feishu / Telegram / Matrix channels.
 *
 * Using `runtime.channel.media.saveMediaBuffer` instead of rolling our own
 * write gets us for free:
 *   - a unified on-disk layout that ops/TTL cleanup already know about,
 *   - UUID-suffixed filenames (`<name>---<uuid>.<ext>`) so collisions are
 *     impossible without overwriting anyone else's file, and
 *   - the original filename preserved in the sanitized prefix, which is
 *     what `extractOriginalFilename` gives back when the agent refers to
 *     the file by name.
 *
 * We return the absolute on-disk path; callers pass that to the SDK as
 * `MediaPath`/`MediaPaths` so the media autorouter can feed the file into
 * vision / file-understanding models without the agent having to locate it.
 */
async function downloadInboundAttachment(params: {
  serverUrl: string;
  fileUrl: string;
  fileName?: string;
  contentType?: string;
  log: PluginLogger;
}): Promise<{
  filePath: string;
  fileName: string;
  contentType?: string;
} | null> {
  const { serverUrl, fileUrl, fileName, contentType, log } = params;
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

    const runtime = getRuntime();
    // `saveMediaBuffer(buffer, contentType, subdir, maxBytes, originalFilename)`
    // writes to `<configDir>/media/<subdir>/<name>---<uuid>.<ext>` and returns
    // the absolute path + final id. `subdir="inbound"` is what every bundled
    // channel uses for user-originated media.
    const saved = await runtime.channel.media.saveMediaBuffer(
      buf,
      contentType,
      "inbound",
      ATTACHMENT_MAX_BYTES,
      fileName,
    );
    log.info(`Saved inbound attachment to ${saved.path} (${saved.size} bytes)`);
    return {
      filePath: saved.path,
      fileName: fileName || saved.id,
      contentType: saved.contentType,
    };
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
  const agentUserId = client.agentUserId || "";

  // 1. If the user attached a file, stash it in OpenClaw's shared media
  //    store (`~/.openclaw/media/inbound/`) via the official SDK helper.
  //    That's where Feishu/Telegram/Matrix put their inbound files too,
  //    so ops tooling and TTL cleanup already cover it. The absolute
  //    path we get back is handed to the SDK via MediaPath/MediaPaths;
  //    the media autorouter then feeds the file into whichever vision /
  //    file-understanding model fits (e.g. MiniMax-VL-01 for images on
  //    a MiniMax text primary).
  let prompt = msg.text;
  let mediaPayload: Record<string, unknown> = {};
  if (msg.attachmentUrl) {
    const saved = await downloadInboundAttachment({
      serverUrl: account.serverUrl,
      fileUrl: msg.attachmentUrl,
      fileName: msg.attachmentName,
      contentType: msg.contentType,
      log,
    });
    if (saved) {
      // If the gateway baked the original filename into the prompt
      // (e.g. `[image: photo.jpg]`), swap it for the absolute path so a
      // naive `image({"image": ...})` tool call from the agent still
      // resolves even when the SDK's autorouter hasn't kicked in yet.
      const originalRef = msg.attachmentName;
      if (originalRef && prompt.includes(originalRef)) {
        prompt = prompt.replace(originalRef, saved.filePath);
      } else {
        prompt = `${prompt}\n(attachment saved at ${saved.filePath})`;
      }
      const mime = inferMimeType(saved.fileName, saved.contentType || msg.contentType);
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

  // 3. For group chats, fetch the current roster so we can (a) teach the
  //    LLM whose user_id maps to which display name and (b) let it mention
  //    people back by emitting the same `<at user_id="...">name</at>` tag.
  //    Direct chats skip this — there's only one peer and `@` is moot.
  let roster: Array<{ id: string; display_name: string; is_agent: boolean }> = [];
  if (msg.chatType === "group") {
    roster = await client.listGroupMembers(msg.chatId);
  }

  // Append a system hint describing the mention protocol when either the
  // inbound message already contains `<at>` tags or we supplied a roster
  // the agent could reference. Mirrors feishu's hint injected in
  // `monitor-Bq9OdXVi.js:1381`.
  const inboundHasAtTags = hasAtTag(prompt);
  if (inboundHasAtTags || roster.length > 0) {
    const hints: string[] = [];
    hints.push(
      'The content may include mention tags of the form <at user_id="...">name</at>. ' +
        "Treat these as real mentions of Agent Club users (or bots).",
    );
    if (agentUserId) {
      hints.push(`If user_id is "${agentUserId}", that mention refers to you.`);
    }
    if (roster.length > 0) {
      const lines = roster.map(
        (m) =>
          `- ${m.display_name}: user_id="${m.id}"${
            m.id === agentUserId ? " (you)" : m.is_agent ? " (bot)" : ""
          }`,
      );
      hints.push(
        "To @mention someone in your reply, emit the same tag: " +
          '<at user_id="UUID">name</at>. Use user_id="all" for @everyone. ' +
          "Room roster:\n" +
          lines.join("\n"),
      );
    }
    prompt = `${prompt}\n\n[System: ${hints.join(" ")}]`;
  }

  // 4. Build the inbound context payload. The SDK reads these fields to
  //    construct the agent envelope, so they must follow the convention
  //    established by existing channel plugins (feishu, slack, etc.).
  //    `WasMentioned` tracks whether the human actually addressed us —
  //    feishu uses the same field to differentiate silent overhearing
  //    from a direct prompt.
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
    WasMentioned: msg.mentionedBot,
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
          // Only relay the `final` chunk to the IM. OpenClaw's buffered
          // dispatcher also surfaces interim `block` events that carry
          // the same rich-output payload (agent text + media) — acting
          // on both would double-send every attachment. `tool` chunks
          // are internal and also irrelevant to the user. `final` is
          // the single authoritative chunk per reply, so keying on it
          // is strictly correct and much simpler than trying to dedupe
          // by content hash across events.
          //
          // We log the skip at info level rather than dropping
          // silently: if the SDK ever renames "final" or stops emitting
          // it, the reply would just vanish and we'd have no trail.
          // This line lets operators notice "agent was chatty but
          // nothing went out" without attaching a debugger.
          if (info?.kind !== "final") {
            const mediaCount =
              payload.mediaUrls?.length ??
              (payload.mediaUrl ? 1 : 0);
            log.info(
              `Skipping non-final reply chunk (kind=${
                info?.kind ?? "<none>"
              }, text_len=${payload.text?.length ?? 0}, media=${mediaCount})`,
            );
            return;
          }

          const text = payload.text?.trim() ?? "";
          const mediaUrls = payload.mediaUrls?.length
            ? payload.mediaUrls
            : payload.mediaUrl
              ? [payload.mediaUrl]
              : [];

          if (!text && mediaUrls.length === 0) return;
          if (text === "NO_REPLY" && mediaUrls.length === 0) return;

          if (text && text !== "NO_REPLY") {
            // If the agent emitted `<at user_id="...">...</at>` tags, lift
            // the user_ids into the `mentions` field so the IM server can
            // push unread-badge updates to the mentioned users (and so
            // other channels that consume the message can treat them as
            // real mentions without re-parsing the text).
            const outboundMentions = extractMentionsFromReply(text);
            client.sendMessage({
              chat_type: msg.chatType as "group" | "direct",
              chat_id: msg.chatId,
              content: text,
              content_type: "text",
              ...(outboundMentions.length
                ? { mentions: outboundMentions }
                : {}),
            });
          }
          // Resolve media inputs through the SDK helper so remote URLs,
          // absolute paths (allowlist-checked), and relative paths
          // (workspace-anchored) all work out of the box — same contract
          // as feishu / telegram / matrix / discord / whatsapp. We pass
          // the agent-scoped roots explicitly because the buffered-block
          // dispatcher bypasses the outbound adapter, so core doesn't
          // inject `mediaLocalRoots` for us (canonical call site is
          // `deliver.ts` → `resolveAgentScopedOutboundMediaAccess` in
          // the SDK).
          const workspaceDir = resolveAgentWorkspace(cfg, route.agentId);
          const localRoots = resolveMediaLocalRoots(cfg, route.agentId);
          for (const path of mediaUrls) {
            try {
              const loaded = await loadWebMedia(path, {
                workspaceDir,
                localRoots,
              });
              const fileName =
                loaded.fileName ?? (basename(path) || "file");
              const upload = await client.uploadFile(
                new Uint8Array(loaded.buffer),
                fileName,
              );
              client.sendMessage({
                chat_type: msg.chatType as "group" | "direct",
                chat_id: msg.chatId,
                content: "",
                content_type: inferContentTypeFromUploadType(
                  loaded.contentType ?? upload.content_type,
                ),
                file_url: upload.url,
                file_name: upload.filename,
              });
            } catch (err) {
              // Tag the LocalMediaAccessError `.code` into the log so
              // `not-found` vs `path-not-allowed` vs `invalid-file-url`
              // is visible at a glance — that's usually enough to tell
              // "agent typo" from "need to configure mediaLocalRoots".
              const code = extractMediaErrorCode(err);
              log.error(
                `Failed to deliver media (path=${path}, code=${
                  code ?? "<unknown>"
                }): ${formatLogArg(err)}`,
              );
            }
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
