import { describe, it, expect, vi, beforeEach } from "vitest";

// socket.io-client is a heavyweight import that `AgentClubClient` pulls
// in transitively — stubbing it keeps the test hermetic (no DNS lookups
// or native module loading at import time).
vi.mock("socket.io-client", () => ({
  io: vi.fn(() => ({
    on: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
    connected: false,
  })),
}));

import { AgentClubClient } from "../src/client.js";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

beforeEach(() => {
  fetchMock.mockReset();
});

function makeClient() {
  return new AgentClubClient({
    serverUrl: "http://localhost:5555",
    agentToken: "tok-123",
    onMessage: () => {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
}

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
