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

function makeRuntime() {
  return {
    agent: {
      resolveAgentDir: vi.fn(() => "/tmp/agent"),
      resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
      resolveAgentTimeoutMs: vi.fn(() => 60000),
      runEmbeddedAgent: vi.fn(async () => ({
        payloads: [{ text: "Agent reply" }],
        meta: { durationMs: 100 },
      })),
      session: { resolveStorePath: vi.fn(() => "/tmp/sessions") },
    },
    config: {
      loadConfig: vi.fn(async () => ({})),
      writeConfigFile: vi.fn(async () => {}),
    },
    logging: { shouldLogVerbose: vi.fn(() => false) },
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

  it("processes inbound messages via runEmbeddedAgent", async () => {
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

    expect(runtime.agent.runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Hello agent",
        sessionId: "agent-club:direct:chat-42",
      }),
    );

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

    expect(runtime.agent.runEmbeddedAgent).not.toHaveBeenCalled();

    abortController.abort();
    await monitorPromise;
  });

  it("does not send reply when didSendViaMessagingTool is true", async () => {
    const runtime = makeRuntime();
    runtime.agent.runEmbeddedAgent.mockResolvedValue({
      payloads: [{ text: "Already sent" }],
      meta: { durationMs: 100 },
      didSendViaMessagingTool: true,
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

    expect(runtime.agent.runEmbeddedAgent).toHaveBeenCalled();

    const sendCalls = mockSocket.emit.mock.calls.filter(
      (c: unknown[]) => c[0] === "send_message",
    );
    expect(sendCalls).toHaveLength(0);

    abortController.abort();
    await monitorPromise;
  });

  it("handles runEmbeddedAgent errors gracefully", async () => {
    const runtime = makeRuntime();
    runtime.agent.runEmbeddedAgent.mockRejectedValue(new Error("Provider error"));

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

    expect(runtime.agent.runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Offline message" }),
    );

    abortController.abort();
    await monitorPromise;
  });
});
