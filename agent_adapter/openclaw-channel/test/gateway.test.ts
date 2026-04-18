import { describe, it, expect } from "vitest";
import { createInboundGateway, type InboundMessage } from "../src/gateway.js";
import type { NewMessagePayload, ResolvedAccount } from "../src/types.js";

let _msgSeq = 0;
function makeMsg(overrides: Partial<NewMessagePayload> = {}): NewMessagePayload {
  return {
    id: `msg-${++_msgSeq}`,
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
    allowFrom: ["*"],
    allowFromKind: ["*"],
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
    expect(received[0].sessionKey).toBe("agentclub:direct:chat-1");
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
    expect(received[0].mentionedBot).toBe(true);
  });

  it("treats @all as a mention of the bot in requireMention groups", () => {
    const received: InboundMessage[] = [];
    const handle = createInboundGateway({
      agentUserId: AGENT_ID,
      account: makeAccount({ requireMention: true }),
      onInbound: (msg) => received.push(msg),
    });

    handle(makeMsg({ chat_type: "group", mentions: ["all"] }));
    expect(received).toHaveLength(1);
    expect(received[0].mentionedBot).toBe(true);
  });

  it("marks direct messages as always mentioned", () => {
    const received: InboundMessage[] = [];
    const handle = createInboundGateway({
      agentUserId: AGENT_ID,
      account: makeAccount({ requireMention: true }),
      onInbound: (msg) => received.push(msg),
    });

    handle(makeMsg({ chat_type: "direct", mentions: [] }));
    expect(received).toHaveLength(1);
    expect(received[0].mentionedBot).toBe(true);
  });

  it("marks group messages without mention as not mentioned (when requireMention off)", () => {
    const received: InboundMessage[] = [];
    const handle = createInboundGateway({
      agentUserId: AGENT_ID,
      account: makeAccount({ requireMention: false }),
      onInbound: (msg) => received.push(msg),
    });

    handle(makeMsg({ chat_type: "group", mentions: [] }));
    expect(received).toHaveLength(1);
    expect(received[0].mentionedBot).toBe(false);
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

  it("rejects all messages when allowFrom is empty (default-deny)", () => {
    const received: InboundMessage[] = [];
    const acked: string[] = [];
    const handle = createInboundGateway({
      agentUserId: AGENT_ID,
      account: makeAccount({ allowFrom: [] }),
      onInbound: (msg) => received.push(msg),
      onAck: (id) => acked.push(id),
    });

    handle(makeMsg({ id: "x1", sender_id: "user-1" }));
    expect(received).toHaveLength(0);
    expect(acked).toContain("x1");
  });

  it("allows all messages when allowFrom contains '*'", () => {
    const received: InboundMessage[] = [];
    const handle = createInboundGateway({
      agentUserId: AGENT_ID,
      account: makeAccount({ allowFrom: ["*"] }),
      onInbound: (msg) => received.push(msg),
    });

    handle(makeMsg({ sender_id: "user-1" }));
    handle(makeMsg({ sender_id: "user-2" }));
    expect(received).toHaveLength(2);
  });

  it("filters by allowFrom when configured with specific user IDs", () => {
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

  it("rejects all messages when allowFromKind is empty (default-deny)", () => {
    const received: InboundMessage[] = [];
    const acked: string[] = [];
    const handle = createInboundGateway({
      agentUserId: AGENT_ID,
      account: makeAccount({ allowFrom: ["*"], allowFromKind: [] }),
      onInbound: (msg) => received.push(msg),
      onAck: (id) => acked.push(id),
    });

    handle(makeMsg({ id: "k1", sender_id: "user-1", sender_is_agent: false }));
    handle(makeMsg({ id: "k2", sender_id: "bot-1", sender_is_agent: true }));
    expect(received).toHaveLength(0);
    expect(acked).toEqual(expect.arrayContaining(["k1", "k2"]));
  });

  it("allowFromKind='human' accepts only non-agent senders", () => {
    const received: InboundMessage[] = [];
    const handle = createInboundGateway({
      agentUserId: AGENT_ID,
      account: makeAccount({ allowFrom: ["*"], allowFromKind: ["human"] }),
      onInbound: (msg) => received.push(msg),
    });

    handle(makeMsg({ sender_id: "user-1", sender_is_agent: false }));
    handle(makeMsg({ sender_id: "bot-1", sender_is_agent: true }));
    expect(received).toHaveLength(1);
    expect(received[0].senderId).toBe("user-1");
  });

  it("allowFromKind='agent' accepts only agent senders", () => {
    const received: InboundMessage[] = [];
    const handle = createInboundGateway({
      agentUserId: AGENT_ID,
      account: makeAccount({ allowFrom: ["*"], allowFromKind: ["agent"] }),
      onInbound: (msg) => received.push(msg),
    });

    handle(makeMsg({ sender_id: "user-1", sender_is_agent: false }));
    handle(makeMsg({ sender_id: "bot-1", sender_is_agent: true }));
    expect(received).toHaveLength(1);
    expect(received[0].senderId).toBe("bot-1");
  });

  it("allowFrom and allowFromKind are intersected (both must pass)", () => {
    // Only bot-allowed is in allowFrom AND only agents pass allowFromKind.
    // → user-1 (human): fails kind filter.
    // → bot-other (agent but not in allowFrom): fails id filter.
    // → bot-allowed (agent in allowFrom): passes both.
    const received: InboundMessage[] = [];
    const handle = createInboundGateway({
      agentUserId: AGENT_ID,
      account: makeAccount({
        allowFrom: ["user-1", "bot-allowed"],
        allowFromKind: ["agent"],
      }),
      onInbound: (msg) => received.push(msg),
    });

    handle(makeMsg({ sender_id: "user-1", sender_is_agent: false }));
    handle(makeMsg({ sender_id: "bot-other", sender_is_agent: true }));
    handle(makeMsg({ sender_id: "bot-allowed", sender_is_agent: true }));
    expect(received.map((m) => m.senderId)).toEqual(["bot-allowed"]);
  });

  it("invokes onAck for accepted, filtered, and duplicate messages", () => {
    const received: InboundMessage[] = [];
    const acked: string[] = [];
    const handle = createInboundGateway({
      agentUserId: AGENT_ID,
      account: makeAccount({ requireMention: true, allowFrom: ["user-99"] }),
      onInbound: (msg) => received.push(msg),
      onAck: (id) => acked.push(id),
    });

    handle(makeMsg({ id: "a", sender_id: AGENT_ID }));
    handle(makeMsg({ id: "b", sender_id: "user-1" }));
    handle(makeMsg({ id: "c", sender_id: "user-99", chat_type: "group", mentions: [] }));
    handle(makeMsg({ id: "d", sender_id: "user-99" }));
    handle(makeMsg({ id: "d", sender_id: "user-99" }));

    expect(received.map((m) => m.rawPayload.id)).toEqual(["d"]);
    expect(acked).toEqual(["b", "c", "d", "d"]);
  });

  it("dedupes messages with the same id (replayed offline_messages)", () => {
    const received: InboundMessage[] = [];
    const handle = createInboundGateway({
      agentUserId: AGENT_ID,
      account: makeAccount({ requireMention: false }),
      onInbound: (msg) => received.push(msg),
    });

    const replayed = makeMsg({ id: "dup-1" });
    handle(replayed);
    handle(replayed);
    handle({ ...replayed });
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
