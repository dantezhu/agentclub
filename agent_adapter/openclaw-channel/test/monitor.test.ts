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

function makeAccount(overrides: Partial<ResolvedAccount> = {}): ResolvedAccount {
  return {
    accountId: null,
    serverUrl: "http://localhost:5555",
    agentToken: "test-token",
    requireMention: false,
    allowFrom: [],
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
          sessionKey: `agent-club:${params.accountId}:${params.peer.kind}:${params.peer.id}`,
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
        channel: "agent-club",
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
        From: "agent-club:user-1",
        To: "user:user-1",
        Provider: "agent-club",
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
