import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Shared runtime reference used by the mocked store
let _sharedRuntime: any = null;

// Mock the OpenClaw SDK modules
vi.mock("openclaw/plugin-sdk/runtime-store", () => ({
  createPluginRuntimeStore: vi.fn(() => ({
    setRuntime: vi.fn((r: unknown) => {
      _sharedRuntime = r;
    }),
    getRuntime: vi.fn(() => _sharedRuntime),
    tryGetRuntime: vi.fn(() => _sharedRuntime),
  })),
}));

vi.mock("openclaw/plugin-sdk/channel-core", () => ({
  createChannelPluginBase: vi.fn((opts: any) => opts),
  createChatChannelPlugin: vi.fn((opts: any) => opts),
  defineChannelPluginEntry: vi.fn((opts: any) => opts),
  defineSetupPluginEntry: vi.fn((opts: any) => opts),
}));

// Stub the SDK's web-media loader. Real implementation handles remote
// fetch + local allowlist + workspace-relative resolution; the tests only
// need to observe what we feed it and return a canned buffer so the
// downstream `uploadFile` / `send_message` path still exercises.
//
// `vi.hoisted` is needed because `vi.mock` factories run before top-level
// `const` declarations — without it the factory would close over an
// undefined reference.
const { loadWebMediaMock, getAgentScopedMediaLocalRootsMock } = vi.hoisted(
  () => ({
    loadWebMediaMock: vi.fn(async (mediaUrl: string) => ({
      buffer: Buffer.from(`bytes-for-${mediaUrl}`),
      contentType: "image/png",
      fileName: mediaUrl.split("/").pop() ?? "file",
      kind: "image",
    })),
    // Stubbed agent-scoped roots resolver. In production this returns the
    // default media roots plus the agent's workspace; the tests just need
    // a known array so we can assert it was threaded into `loadWebMedia`.
    getAgentScopedMediaLocalRootsMock: vi.fn(
      (_cfg: unknown, _agentId?: string) => [
        "/tmp/workspace",
        "/tmp/default-root",
      ],
    ),
  }),
);
vi.mock("openclaw/plugin-sdk/web-media", () => ({
  loadWebMedia: loadWebMediaMock,
}));
vi.mock("openclaw/plugin-sdk/agent-media-payload", () => ({
  getAgentScopedMediaLocalRoots: getAgentScopedMediaLocalRootsMock,
}));

// Mock socket.io-client
const _handlers: Record<string, Function[]> = {};
const mockSocket = {
  on: vi.fn((event: string, handler: Function) => {
    _handlers[event] = _handlers[event] || [];
    _handlers[event].push(handler);
  }),
  once: vi.fn((event: string, handler: Function) => {
    _handlers[event] = _handlers[event] || [];
    _handlers[event].push(handler);
  }),
  emit: vi.fn(),
  disconnect: vi.fn(),
  connected: true,
};

function triggerSocketEvent(event: string, ...args: unknown[]) {
  for (const h of _handlers[event] ?? []) h(...args);
}

function resetSocketHandlers() {
  for (const key of Object.keys(_handlers)) delete _handlers[key];
  mockSocket.on.mockClear();
  mockSocket.once.mockClear();
  mockSocket.emit.mockClear();
  mockSocket.disconnect.mockClear();
}

vi.mock("socket.io-client", () => ({
  io: vi.fn(() => mockSocket),
}));

import { startAgentClubMonitor } from "../src/monitor.js";
import { setRuntime } from "../src/runtime.js";
import type { ResolvedAccount } from "../src/types.js";

// Stub the global fetch used by client.listGroupMembers / attachment DL.
// Individual tests can override per-test by replacing the mock.
const fetchMock = vi.fn(async () => new Response("[]", { status: 200 }));
vi.stubGlobal("fetch", fetchMock);
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("[]", { status: 200 }));
  loadWebMediaMock.mockClear();
  loadWebMediaMock.mockImplementation(async (mediaUrl: string) => ({
    buffer: Buffer.from(`bytes-for-${mediaUrl}`),
    contentType: "image/png",
    fileName: mediaUrl.split("/").pop() ?? "file",
    kind: "image",
  }));
  getAgentScopedMediaLocalRootsMock.mockClear();
  getAgentScopedMediaLocalRootsMock.mockImplementation(() => [
    "/tmp/workspace",
    "/tmp/default-root",
  ]);
});

function makeAccount(overrides: Partial<ResolvedAccount> = {}): ResolvedAccount {
  return {
    accountId: null,
    serverUrl: "http://localhost:5555",
    agentToken: "test-token",
    requireMention: false,
    allowFrom: ["*"],
    allowFromKind: ["*"],
    dmPolicy: undefined,
    ...overrides,
  };
}

/**
 * Build a fake PluginRuntime. The monitor now goes through
 * `runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher`, so the
 * fake dispatcher simulates the SDK by:
 *  1. storing the `finalizeInboundContext` payload so tests can assert on
 *     the fields we forwarded (prompt, session key, media path, etc.), and
 *  2. invoking the caller-provided `deliver` callback with a canned agent
 *     reply so the outbound relay path is exercised end-to-end.
 *
 * `replyPayload` and `replyInfo` can be overridden per test to exercise
 * tool-event suppression, NO_REPLY, and media routing.
 */
function makeRuntime(options: {
  replyPayload?: { text?: string; mediaUrl?: string };
  replyInfo?: { kind?: string };
  dispatchError?: Error;
} = {}) {
  const finalizeCalls: unknown[] = [];
  const dispatcherCalls: unknown[] = [];
  const replyPayload = options.replyPayload ?? { text: "Agent reply" };
  const replyInfo = options.replyInfo ?? { kind: "final" };

  return {
    agent: {
      resolveAgentDir: vi.fn(() => "/tmp/agent"),
      resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
      resolveAgentTimeoutMs: vi.fn(() => 60000),
      runEmbeddedAgent: vi.fn(),
      session: { resolveStorePath: vi.fn(() => "/tmp/sessions") },
    },
    channel: {
      routing: {
        resolveAgentRoute: vi.fn((params: any) => ({
          sessionKey: `agentclub:${params.accountId}:${params.peer.kind}:${params.peer.id}`,
          accountId: params.accountId,
          agentId: "main",
        })),
      },
      reply: {
        finalizeInboundContext: vi.fn((payload: unknown) => {
          finalizeCalls.push(payload);
          return { __ctx: payload };
        }),
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(async (params: any) => {
          dispatcherCalls.push(params);
          if (options.dispatchError) throw options.dispatchError;
          await params.dispatcherOptions.deliver(replyPayload, replyInfo);
          return { queuedFinal: true };
        }),
      },
    },
    config: {
      loadConfig: vi.fn(async () => ({})),
      writeConfigFile: vi.fn(async () => {}),
    },
    logging: { shouldLogVerbose: vi.fn(() => false) },
    __finalizeCalls: finalizeCalls,
    __dispatcherCalls: dispatcherCalls,
  };
}

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

const AUTH_OK = {
  user_id: "agent-1",
  display_name: "TestBot",
  role: "agent",
  is_agent: true,
};

function makeInboundMsg(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg-1",
    chat_type: "direct",
    chat_id: "chat-42",
    sender_id: "user-1",
    sender_name: "Alice",
    sender_avatar: "",
    sender_is_agent: false,
    content: "Hello agent",
    content_type: "text",
    file_url: "",
    file_name: "",
    mentions: [],
    created_at: Date.now() / 1000,
    ...overrides,
  };
}

function lastFinalizeCtx(runtime: ReturnType<typeof makeRuntime>): any {
  const calls = (runtime as any).__finalizeCalls as unknown[];
  return calls[calls.length - 1];
}

function lastSendMessage(): any {
  const calls = mockSocket.emit.mock.calls.filter(
    (c: unknown[]) => c[0] === "send_message",
  );
  return calls.length ? calls[calls.length - 1][1] : null;
}

describe("startAgentClubMonitor", () => {
  let abortController: AbortController;

  beforeEach(() => {
    abortController = new AbortController();
    resetSocketHandlers();
  });

  afterEach(() => {
    abortController.abort();
  });

  it("connects and stays alive until abort", async () => {
    const runtime = makeRuntime();
    const log = makeLogger();

    setRuntime(runtime as any);
    const monitorPromise = startAgentClubMonitor({
      account: makeAccount(),
      cfg: {} as any,
      abortSignal: abortController.signal,
      log,
    });

    triggerSocketEvent("auth_ok", AUTH_OK);
    await new Promise((r) => setTimeout(r, 50));

    expect(log.info).toHaveBeenCalled();

    abortController.abort();
    await monitorPromise;
    expect(mockSocket.disconnect).toHaveBeenCalled();
  });

  it("dispatches inbound messages through channel.reply and relays agent reply", async () => {
    const runtime = makeRuntime();
    const log = makeLogger();

    setRuntime(runtime as any);
    const monitorPromise = startAgentClubMonitor({
      account: makeAccount(),
      cfg: {} as any,
      abortSignal: abortController.signal,
      log,
    });

    triggerSocketEvent("auth_ok", AUTH_OK);
    await new Promise((r) => setTimeout(r, 50));

    triggerSocketEvent("new_message", makeInboundMsg());
    await new Promise((r) => setTimeout(r, 150));

    // Route resolution forwarded the peer correctly.
    expect(runtime.channel.routing.resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "agentclub",
        peer: { kind: "direct", id: "user-1" },
      }),
    );

    // Inbound context carried the prompt + session key the SDK needs to
    // route the agent and pick the primary model.
    expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        Body: "Hello agent",
        BodyForAgent: "Hello agent",
        ChatType: "direct",
        SenderId: "user-1",
        From: "agentclub:user-1",
        To: "user:user-1",
        Provider: "agentclub",
      }),
    );

    // Agent's reply made it back into the IM via send_message.
    expect(mockSocket.emit).toHaveBeenCalledWith(
      "send_message",
      expect.objectContaining({
        chat_type: "direct",
        chat_id: "chat-42",
        content: "Agent reply",
        content_type: "text",
      }),
    );

    abortController.abort();
    await monitorPromise;
  });

  it("skips own messages", async () => {
    const runtime = makeRuntime();
    const log = makeLogger();

    setRuntime(runtime as any);
    const monitorPromise = startAgentClubMonitor({
      account: makeAccount(),
      cfg: {} as any,
      abortSignal: abortController.signal,
      log,
    });

    triggerSocketEvent("auth_ok", AUTH_OK);
    await new Promise((r) => setTimeout(r, 50));

    triggerSocketEvent("new_message", makeInboundMsg({ sender_id: "agent-1" }));
    await new Promise((r) => setTimeout(r, 100));

    expect(
      runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
    ).not.toHaveBeenCalled();

    abortController.abort();
    await monitorPromise;
  });

  it("suppresses tool-kind payloads so internal tool chatter does not leak to the user", async () => {
    const runtime = makeRuntime({
      replyPayload: { text: "tool output" },
      replyInfo: { kind: "tool" },
    });

    const log = makeLogger();

    setRuntime(runtime as any);
    const monitorPromise = startAgentClubMonitor({
      account: makeAccount(),
      cfg: {} as any,
      abortSignal: abortController.signal,
      log,
    });

    triggerSocketEvent("auth_ok", AUTH_OK);
    await new Promise((r) => setTimeout(r, 50));

    triggerSocketEvent("new_message", makeInboundMsg());
    await new Promise((r) => setTimeout(r, 150));

    const sendCalls = mockSocket.emit.mock.calls.filter(
      (c: unknown[]) => c[0] === "send_message",
    );
    expect(sendCalls).toHaveLength(0);

    abortController.abort();
    await monitorPromise;
  });

  it("suppresses interim `block` payloads to avoid double-sending media", async () => {
    // OpenClaw 2026.4.15+ emits both a `block` and a `final` event per
    // rich-output reply with the SAME media payload. Acting on both
    // would upload each attachment twice — we only relay `final`.
    const runtime = makeRuntime({
      replyPayload: {
        text: "interim",
        mediaUrls: ["./preview.png"] as unknown as string[],
      } as any,
      replyInfo: { kind: "block" },
    });

    const log = makeLogger();
    setRuntime(runtime as any);
    const monitorPromise = startAgentClubMonitor({
      account: makeAccount(),
      cfg: {} as any,
      abortSignal: abortController.signal,
      log,
    });

    triggerSocketEvent("auth_ok", AUTH_OK);
    await new Promise((r) => setTimeout(r, 50));

    triggerSocketEvent("new_message", makeInboundMsg());
    await new Promise((r) => setTimeout(r, 150));

    // Nothing was sent — text bubble skipped AND media upload skipped.
    const sendCalls = mockSocket.emit.mock.calls.filter(
      (c: unknown[]) => c[0] === "send_message",
    );
    expect(sendCalls).toHaveLength(0);
    expect(loadWebMediaMock).not.toHaveBeenCalled();

    abortController.abort();
    await monitorPromise;
  });

  it("handles dispatch errors gracefully", async () => {
    const runtime = makeRuntime({ dispatchError: new Error("Provider error") });

    const log = makeLogger();

    setRuntime(runtime as any);
    const monitorPromise = startAgentClubMonitor({
      account: makeAccount(),
      cfg: {} as any,
      abortSignal: abortController.signal,
      log,
    });

    triggerSocketEvent("auth_ok", AUTH_OK);
    await new Promise((r) => setTimeout(r, 50));

    triggerSocketEvent("new_message", makeInboundMsg());
    await new Promise((r) => setTimeout(r, 150));

    expect(log.error).toHaveBeenCalled();

    const sendCalls = mockSocket.emit.mock.calls.filter(
      (c: unknown[]) => c[0] === "send_message",
    );
    expect(sendCalls).toHaveLength(0);

    abortController.abort();
    await monitorPromise;
  });

  it("injects roster + mention hint for group messages so the LLM can @back", async () => {
    // Mock the group-members fetch to return a small roster.
    fetchMock.mockImplementation(async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/api/agent/groups/") && url.includes("/members")) {
        return new Response(
          JSON.stringify([
            { id: "agent-1", display_name: "ClawBot", is_agent: true, role: "agent" },
            { id: "user-1", display_name: "Alice", is_agent: false, role: "user" },
            { id: "user-2", display_name: "Bob", is_agent: false, role: "user" },
          ]),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    });

    const runtime = makeRuntime();
    const log = makeLogger();
    setRuntime(runtime as any);
    const monitorPromise = startAgentClubMonitor({
      account: makeAccount(),
      cfg: {} as any,
      abortSignal: abortController.signal,
      log,
    });

    triggerSocketEvent("auth_ok", AUTH_OK);
    await new Promise((r) => setTimeout(r, 50));

    triggerSocketEvent(
      "new_message",
      makeInboundMsg({
        chat_type: "group",
        chat_id: "group-7",
        content:
          'Hey <at user_id="agent-1">ClawBot</at> please help Bob',
        mentions: ["agent-1"],
      }),
    );
    await new Promise((r) => setTimeout(r, 150));

    const ctx = lastFinalizeCtx(runtime);
    expect(ctx.Body).toContain('<at user_id="agent-1">ClawBot</at>');
    expect(ctx.Body).toContain("[System:");
    // The roster line for each member should be present.
    expect(ctx.Body).toContain('user_id="agent-1"');
    expect(ctx.Body).toContain('user_id="user-1"');
    expect(ctx.Body).toContain('user_id="user-2"');
    // Self-reference hint.
    expect(ctx.Body).toMatch(/"agent-1".+refers to you/);
    // Mentioned flag propagates to the SDK.
    expect(ctx.WasMentioned).toBe(true);

    abortController.abort();
    await monitorPromise;
  });

  it("does not attach roster hint in direct chats", async () => {
    const runtime = makeRuntime();
    const log = makeLogger();
    setRuntime(runtime as any);
    const monitorPromise = startAgentClubMonitor({
      account: makeAccount(),
      cfg: {} as any,
      abortSignal: abortController.signal,
      log,
    });

    triggerSocketEvent("auth_ok", AUTH_OK);
    await new Promise((r) => setTimeout(r, 50));

    triggerSocketEvent("new_message", makeInboundMsg());
    await new Promise((r) => setTimeout(r, 150));

    const ctx = lastFinalizeCtx(runtime);
    expect(ctx.Body).toBe("Hello agent");
    expect(ctx.Body).not.toContain("[System:");
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/members"),
      expect.anything(),
    );

    abortController.abort();
    await monitorPromise;
  });

  it("extracts mentions from agent reply into outbound send payload", async () => {
    const runtime = makeRuntime({
      replyPayload: {
        text: 'Sure <at user_id="user-1">Alice</at>, here you go! <at user_id="all">所有人</at>',
      },
    });
    const log = makeLogger();
    setRuntime(runtime as any);
    const monitorPromise = startAgentClubMonitor({
      account: makeAccount(),
      cfg: {} as any,
      abortSignal: abortController.signal,
      log,
    });

    triggerSocketEvent("auth_ok", AUTH_OK);
    await new Promise((r) => setTimeout(r, 50));

    triggerSocketEvent(
      "new_message",
      makeInboundMsg({
        chat_type: "group",
        chat_id: "group-7",
        mentions: ["agent-1"],
      }),
    );
    await new Promise((r) => setTimeout(r, 150));

    const sent = lastSendMessage();
    expect(sent).toBeTruthy();
    expect(sent.content).toContain('<at user_id="user-1">Alice</at>');
    expect(sent.mentions).toEqual(["user-1", "all"]);

    abortController.abort();
    await monitorPromise;
  });

  it("omits mentions field when agent reply has no @tags", async () => {
    const runtime = makeRuntime({ replyPayload: { text: "Hello" } });
    const log = makeLogger();
    setRuntime(runtime as any);
    const monitorPromise = startAgentClubMonitor({
      account: makeAccount(),
      cfg: {} as any,
      abortSignal: abortController.signal,
      log,
    });

    triggerSocketEvent("auth_ok", AUTH_OK);
    await new Promise((r) => setTimeout(r, 50));

    triggerSocketEvent("new_message", makeInboundMsg());
    await new Promise((r) => setTimeout(r, 150));

    const sent = lastSendMessage();
    expect(sent).toBeTruthy();
    expect(sent.mentions).toBeUndefined();

    abortController.abort();
    await monitorPromise;
  });

  it("relays reply media via loadWebMedia → upload → send_message", async () => {
    // `loadWebMedia` is the single entrypoint for three input shapes —
    // https URLs, absolute paths (allowlisted), and relative paths
    // (resolved against the agent's workspace). The monitor must hand
    // each one to the SDK helper and wire the returned buffer through
    // `client.uploadFile` into a media-bearing `send_message`.
    fetchMock.mockImplementation(async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/api/agent/upload")) {
        return new Response(
          JSON.stringify({
            url: "/media/uploads/fake.png",
            filename: "fake.png",
            content_type: "image/png",
          }),
          { status: 200 },
        );
      }
      return new Response("[]", { status: 200 });
    });

    const runtime = makeRuntime({
      replyPayload: {
        text: "Here you go:",
        mediaUrls: [
          "https://cdn.example.com/cat.jpg",
          "./workspace-relative.png",
        ] as unknown as string[],
      } as any,
    });
    const log = makeLogger();
    setRuntime(runtime as any);
    const monitorPromise = startAgentClubMonitor({
      account: makeAccount(),
      cfg: {} as any,
      abortSignal: abortController.signal,
      log,
    });

    triggerSocketEvent("auth_ok", AUTH_OK);
    await new Promise((r) => setTimeout(r, 50));

    triggerSocketEvent("new_message", makeInboundMsg());
    await new Promise((r) => setTimeout(r, 150));

    // Both media inputs went through the SDK helper, with the workspace
    // dir AND the agent-scoped local-roots forwarded. Without the roots,
    // absolute paths under a non-default agent's workspace would be
    // rejected as "path-not-allowed" (the bug this helper plugs).
    expect(loadWebMediaMock).toHaveBeenCalledTimes(2);
    expect(loadWebMediaMock).toHaveBeenCalledWith(
      "https://cdn.example.com/cat.jpg",
      expect.objectContaining({
        workspaceDir: "/tmp/workspace",
        localRoots: ["/tmp/workspace", "/tmp/default-root"],
      }),
    );
    expect(loadWebMediaMock).toHaveBeenCalledWith(
      "./workspace-relative.png",
      expect.objectContaining({
        workspaceDir: "/tmp/workspace",
        localRoots: ["/tmp/workspace", "/tmp/default-root"],
      }),
    );
    // Roots must be computed per-agent; the helper receives the agent id
    // the route picked, not `undefined`.
    expect(getAgentScopedMediaLocalRootsMock).toHaveBeenCalledWith(
      expect.anything(),
      "main",
    );

    const sendCalls = mockSocket.emit.mock.calls.filter(
      (c: unknown[]) => c[0] === "send_message",
    );
    // One text bubble + two media bubbles.
    expect(sendCalls).toHaveLength(3);
    const mediaSends = sendCalls.slice(1).map((c) => c[1]);
    for (const sent of mediaSends) {
      expect(sent).toMatchObject({
        chat_type: "direct",
        chat_id: "chat-42",
        content: "",
        content_type: "image",
        file_url: "/media/uploads/fake.png",
      });
    }

    abortController.abort();
    await monitorPromise;
  });

  it("logs and skips a single media input on loadWebMedia failure without aborting the rest", async () => {
    // Bad path / SSRF reject / over-limit — any `loadWebMedia` reject
    // should be caught so one bad attachment doesn't block the others
    // or the text reply. The upstream prompt explicitly teaches agents
    // which path shapes are allowed, so an error here is usually an
    // agent-authoring issue we just want surfaced in the plugin log.
    loadWebMediaMock.mockImplementation(async (mediaUrl: string) => {
      if (mediaUrl.includes("bad")) {
        throw new Error("Path outside allowed file-read boundary");
      }
      return {
        buffer: Buffer.from("ok"),
        contentType: "image/png",
        fileName: "good.png",
        kind: "image",
      };
    });
    fetchMock.mockImplementation(async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/api/agent/upload")) {
        return new Response(
          JSON.stringify({
            url: "/media/uploads/good.png",
            filename: "good.png",
            content_type: "image/png",
          }),
          { status: 200 },
        );
      }
      return new Response("[]", { status: 200 });
    });

    const runtime = makeRuntime({
      replyPayload: {
        text: "Report:",
        mediaUrls: ["/bad/abs/path.png", "./good.png"] as unknown as string[],
      } as any,
    });
    const log = makeLogger();
    setRuntime(runtime as any);
    const monitorPromise = startAgentClubMonitor({
      account: makeAccount(),
      cfg: {} as any,
      abortSignal: abortController.signal,
      log,
    });

    triggerSocketEvent("auth_ok", AUTH_OK);
    await new Promise((r) => setTimeout(r, 50));

    triggerSocketEvent("new_message", makeInboundMsg());
    await new Promise((r) => setTimeout(r, 150));

    const sendCalls = mockSocket.emit.mock.calls.filter(
      (c: unknown[]) => c[0] === "send_message",
    );
    // Text + one successful media (the bad one was dropped).
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[1][1]).toMatchObject({ content_type: "image" });

    // Error surfaced with the offending path embedded for debuggability.
    const errorMessages = log.error.mock.calls.map((c: unknown[]) => c[0]);
    expect(
      errorMessages.some(
        (m: string) => m.includes("/bad/abs/path.png") && m.includes("Failed"),
      ),
    ).toBe(true);

    abortController.abort();
    await monitorPromise;
  });

  it("processes offline messages", async () => {
    const runtime = makeRuntime();
    const log = makeLogger();

    setRuntime(runtime as any);
    const monitorPromise = startAgentClubMonitor({
      account: makeAccount(),
      cfg: {} as any,
      abortSignal: abortController.signal,
      log,
    });

    triggerSocketEvent("auth_ok", AUTH_OK);
    await new Promise((r) => setTimeout(r, 50));

    triggerSocketEvent("offline_messages", [
      makeInboundMsg({ id: "offline-1", content: "Offline message" }),
    ]);
    await new Promise((r) => setTimeout(r, 150));

    expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({ Body: "Offline message" }),
    );

    abortController.abort();
    await monitorPromise;
  });
});
