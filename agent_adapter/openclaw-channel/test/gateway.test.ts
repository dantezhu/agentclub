import { describe, it, expect } from "vitest";
import { createInboundGateway, type InboundMessage } from "../src/gateway.js";
import type { NewMessagePayload, ResolvedAccount } from "../src/types.js";

function makeMsg(overrides: Partial<NewMessagePayload> = {}): NewMessagePayload {
  return {
    id: "msg-1",
    chat_type: "direct",
    chat_id: "chat-1",
    sender_id: "user-1",
    sender_name: "Alice",
    sender_avatar: "",
    sender_is_agent: false,
    content: "Hello",
    content_type: "text",
    file_url: "",
    file_name: "",
    mentions: [],
    created_at: Date.now() / 1000,
    ...overrides,
  };
}

function makeAccount(overrides: Partial<ResolvedAccount> = {}): ResolvedAccount {
  return {
    accountId: null,
    serverUrl: "http://localhost:5555",
    agentToken: "test-token",
    requireMention: true,
    allowFrom: [],
    dmPolicy: undefined,
    ...overrides,
  };
}

const AGENT_ID = "agent-42";

describe("createInboundGateway", () => {
  it("forwards direct messages to onInbound", () => {
    const received: InboundMessage[] = [];
    const handle = createInboundGateway({
      agentUserId: AGENT_ID,
      account: makeAccount(),
      onInbound: (msg) => received.push(msg),
    });

    handle(makeMsg());

    expect(received).toHaveLength(1);
    expect(received[0].text).toBe("Hello");
    expect(received[0].sessionKey).toBe("agent-club:direct:chat-1");
    expect(received[0].chatType).toBe("direct");
    expect(received[0].chatId).toBe("chat-1");
  });

  it("skips messages from the agent itself", () => {
    const received: InboundMessage[] = [];
    const handle = createInboundGateway({
      agentUserId: AGENT_ID,
      account: makeAccount(),
      onInbound: (msg) => received.push(msg),
    });

    handle(makeMsg({ sender_id: AGENT_ID }));
    expect(received).toHaveLength(0);
  });

  it("skips group messages without @mention when requireMention is true", () => {
    const received: InboundMessage[] = [];
    const handle = createInboundGateway({
      agentUserId: AGENT_ID,
      account: makeAccount({ requireMention: true }),
      onInbound: (msg) => received.push(msg),
    });

    handle(makeMsg({ chat_type: "group", mentions: [] }));
    expect(received).toHaveLength(0);
  });

  it("forwards group messages with @mention", () => {
    const received: InboundMessage[] = [];
    const handle = createInboundGateway({
      agentUserId: AGENT_ID,
      account: makeAccount({ requireMention: true }),
      onInbound: (msg) => received.push(msg),
    });

    handle(makeMsg({ chat_type: "group", mentions: [AGENT_ID] }));
    expect(received).toHaveLength(1);
  });

  it("forwards group messages without mention when requireMention is false", () => {
    const received: InboundMessage[] = [];
    const handle = createInboundGateway({
      agentUserId: AGENT_ID,
      account: makeAccount({ requireMention: false }),
      onInbound: (msg) => received.push(msg),
    });

    handle(makeMsg({ chat_type: "group", mentions: [] }));
    expect(received).toHaveLength(1);
  });

  it("filters by allowFrom when configured", () => {
    const received: InboundMessage[] = [];
    const handle = createInboundGateway({
      agentUserId: AGENT_ID,
      account: makeAccount({ allowFrom: ["user-99"] }),
      onInbound: (msg) => received.push(msg),
    });

    handle(makeMsg({ sender_id: "user-1" }));
    expect(received).toHaveLength(0);

    handle(makeMsg({ sender_id: "user-99" }));
    expect(received).toHaveLength(1);
  });

  it("includes attachment info for media messages", () => {
    const received: InboundMessage[] = [];
    const handle = createInboundGateway({
      agentUserId: AGENT_ID,
      account: makeAccount(),
      onInbound: (msg) => received.push(msg),
    });

    handle(
      makeMsg({
        content: "",
        content_type: "image",
        file_url: "/static/uploads/photo.png",
        file_name: "photo.png",
      }),
    );

    expect(received).toHaveLength(1);
    expect(received[0].text).toBe("[image: photo.png]");
    expect(received[0].attachmentUrl).toBe("/static/uploads/photo.png");
  });

  it("skips empty messages", () => {
    const received: InboundMessage[] = [];
    const handle = createInboundGateway({
      agentUserId: AGENT_ID,
      account: makeAccount(),
      onInbound: (msg) => received.push(msg),
    });

    handle(makeMsg({ content: "", content_type: "text", file_url: "" }));
    expect(received).toHaveLength(0);
  });
});
