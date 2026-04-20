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

  it("infers content_type for remote media URLs so images/audio render as previews, not file icons", async () => {
    // Regression test for the bug where every media URL was sent with
    // `content_type: "file"`, which made the Web UI render images as
    // non-clickable file attachments instead of inline previews.
    const runtime = makeRuntime({
      replyPayload: {
        text: "Here you go:",
        mediaUrls: [
          "https://cdn.example.com/cat.jpg?v=2",
          "https://cdn.example.com/voice.mp3",
          "https://cdn.example.com/scroll.mov#t=5",
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

    const sendCalls = mockSocket.emit.mock.calls.filter(
      (c: unknown[]) => c[0] === "send_message",
    );
    // One text bubble + three media bubbles.
    expect(sendCalls).toHaveLength(4);

    const mediaPayloads = sendCalls.slice(1).map((c) => c[1]);
    expect(mediaPayloads[0]).toMatchObject({
      content_type: "image",
      file_url: "https://cdn.example.com/cat.jpg?v=2",
      file_name: "cat.jpg",
    });
    expect(mediaPayloads[1]).toMatchObject({
      content_type: "audio",
      file_url: "https://cdn.example.com/voice.mp3",
      file_name: "voice.mp3",
    });
    expect(mediaPayloads[2]).toMatchObject({
      content_type: "video",
      file_url: "https://cdn.example.com/scroll.mov#t=5",
      file_name: "scroll.mov",
    });

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
