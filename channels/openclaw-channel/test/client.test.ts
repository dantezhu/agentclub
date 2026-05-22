import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// socket.io-client is a heavyweight import that `AgentClubClient` pulls
// in transitively — stubbing it keeps the test hermetic (no DNS lookups
// or native module loading at import time).
const { ioMock } = vi.hoisted(() => ({
  ioMock: vi.fn(() => ({
    on: vi.fn(),
    emit: vi.fn((_event: string, _payload?: unknown, ack?: Function) => {
      if (typeof ack === "function") ack({ ok: true, message_id: "msg-out" });
    }),
    disconnect: vi.fn(),
    connected: false,
  })),
}));

vi.mock("socket.io-client", () => ({
  io: ioMock,
}));

import { AgentClubClient } from "../src/client.js";
import {
  INITIAL_RETRY_DELAY_MS,
  MAX_RETRY_DELAY_MS,
  SERVER_RESPONSE_TIMEOUT_MS,
  SOCKETIO_INFINITE_RECONNECT_ATTEMPTS,
} from "../src/constants.js";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

beforeEach(() => {
  fetchMock.mockReset();
  ioMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

function makeClient() {
  return new AgentClubClient({
    serverUrl: "http://localhost:5555",
    agentToken: "tok-123",
    onMessage: () => {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
}

describe("AgentClubClient.connect", () => {
  it("enables infinite socket.io reconnect with a 30s cap", async () => {
    const client = makeClient();
    const connectPromise = client.connect();

    expect(ioMock).toHaveBeenCalledWith(
      "http://localhost:5555",
      expect.objectContaining({
        auth: { agent_token: "tok-123" },
        transports: ["websocket", "polling"],
        reconnection: true,
        reconnectionDelay: INITIAL_RETRY_DELAY_MS,
        reconnectionDelayMax: MAX_RETRY_DELAY_MS,
        reconnectionAttempts: SOCKETIO_INFINITE_RECONNECT_ATTEMPTS,
      }),
    );

    const socket = ioMock.mock.results[0]?.value;
    const authOkHandler = socket.on.mock.calls.find(
      ([event]: [string, unknown]) => event === "auth_ok",
    )?.[1] as ((payload: unknown) => void) | undefined;
    authOkHandler?.({
      user_id: "agent-1",
      display_name: "Bot",
      heartbeat_interval: 30,
    });

    await expect(connectPromise).resolves.toMatchObject({
      user_id: "agent-1",
      display_name: "Bot",
    });
  });

  it("rejects when auth_ok does not arrive before the response timeout", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    const connectPromise = client.connect();
    const assertion = expect(connectPromise).rejects.toThrow(
      "auth_ok acknowledgement timed out",
    );

    await vi.advanceTimersByTimeAsync(SERVER_RESPONSE_TIMEOUT_MS);

    await assertion;
    const socket = ioMock.mock.results[0]?.value;
    expect(socket.disconnect).toHaveBeenCalled();
    expect(client.connected).toBe(false);
  });

  it("logs and reauthenticates after socket reconnect", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const client = new AgentClubClient({
      serverUrl: "http://localhost:5555",
      agentToken: "tok-123",
      onMessage: () => {},
      logger,
    });
    const connectPromise = client.connect();
    const socket = ioMock.mock.results[0]?.value;
    const authOkHandler = socket.on.mock.calls.find(
      ([event]: [string, unknown]) => event === "auth_ok",
    )?.[1] as ((payload: unknown) => void) | undefined;
    const connectHandler = socket.on.mock.calls.find(
      ([event]: [string, unknown]) => event === "connect",
    )?.[1] as (() => void) | undefined;
    const disconnectHandler = socket.on.mock.calls.find(
      ([event]: [string, unknown]) => event === "disconnect",
    )?.[1] as ((reason: string) => void) | undefined;

    connectHandler?.();
    authOkHandler?.({
      user_id: "agent-1",
      display_name: "Bot",
      heartbeat_interval: 30,
    });
    await connectPromise;
    disconnectHandler?.("transport close");
    connectHandler?.();
    authOkHandler?.({
      user_id: "agent-2",
      display_name: "Bot Two",
      heartbeat_interval: 15,
    });

    expect(client.agentUserId).toBe("agent-2");
    expect(client.displayName).toBe("Bot Two");
    expect(client.connected).toBe(true);
    expect(
      logger.info.mock.calls.filter(([message]) => message === "Socket connected"),
    ).toHaveLength(2);
    expect(logger.info).toHaveBeenCalledWith("Authenticated as Bot Two (agent-2)");
    expect(logger.warn).toHaveBeenCalledWith("Disconnected:", "transport close");
    client.disconnect();
  });
});

describe("AgentClubClient.listChats", () => {
  it("returns the server payload on a 200 response and forwards the bearer token", async () => {
    // Shape matches what the IM server's `/api/agent/chats` returns —
    // if the server contract changes we want this test to fail.
    const payload = {
      groups: [
        { id: "g1", name: "General", avatar: null, description: null, created_at: 1 },
      ],
      directs: [
        {
          id: "dc-abc",
          peer_id: "u-bob",
          peer_name: "Bob",
          peer_avatar: null,
          peer_description: "the human",
          peer_is_agent: 0,
        },
      ],
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(payload), { status: 200 }),
    );

    const client = makeClient();
    const result = await client.listChats();

    expect(result).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:5555/api/agent/chats");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer tok-123",
    });
  });

  it("degrades to an empty shape when the server returns non-2xx", async () => {
    // Goal: an agent loop must not crash when the chat-list endpoint is
    // temporarily unavailable — it just can't do name resolution for a
    // moment, which is strictly better than taking down the whole channel.
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));

    const client = makeClient();
    const result = await client.listChats();

    expect(result).toEqual({ groups: [], directs: [] });
  });

  it("degrades to an empty shape when fetch itself throws", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));

    const client = makeClient();
    const result = await client.listChats();

    expect(result).toEqual({ groups: [], directs: [] });
  });
});

describe("AgentClubClient.sendMessage", () => {
  it("waits for the server acknowledgement and returns the real message id", async () => {
    const client = makeClient();
    const connectPromise = client.connect();
    const socket = ioMock.mock.results[0]?.value;
    socket.connected = true;
    const authOkHandler = socket.on.mock.calls.find(
      ([event]: [string, unknown]) => event === "auth_ok",
    )?.[1] as ((payload: unknown) => void) | undefined;
    authOkHandler?.({ user_id: "agent-1", display_name: "Bot" });
    await connectPromise;

    const ack = await client.sendMessage({
      chat_type: "direct",
      chat_id: "dc-1",
      content: "hi",
      content_type: "text",
    });

    expect(ack.message_id).toBe("msg-out");
    expect(socket.emit).toHaveBeenCalledWith(
      "send_message",
      {
        chat_type: "direct",
        chat_id: "dc-1",
        content: "hi",
        content_type: "text",
      },
      expect.any(Function),
    );
  });

  it("logs and rejects when the server acknowledgement is a failure", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const client = new AgentClubClient({
      serverUrl: "http://localhost:5555",
      agentToken: "tok-123",
      onMessage: () => {},
      logger,
    });
    const connectPromise = client.connect();
    const socket = ioMock.mock.results[0]?.value;
    socket.connected = true;
    const authOkHandler = socket.on.mock.calls.find(
      ([event]: [string, unknown]) => event === "auth_ok",
    )?.[1] as ((payload: unknown) => void) | undefined;
    authOkHandler?.({ user_id: "agent-1", display_name: "Bot" });
    await connectPromise;
    socket.emit.mockImplementationOnce(
      (_event: string, _payload: unknown, ack?: Function) => {
        if (typeof ack === "function") ack({ ok: false, error: "denied" });
      },
    );

    await expect(
      client.sendMessage({
        chat_type: "direct",
        chat_id: "dc-1",
        content: "hi",
        content_type: "text",
      }),
    ).rejects.toThrow("denied");
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("send_message failed:"),
    );
  });
});
