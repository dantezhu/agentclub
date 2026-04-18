import { describe, it, expect } from "vitest";
import { toSessionKey, parseSessionKey } from "../src/session.js";

describe("toSessionKey", () => {
  it("builds a direct session key", () => {
    expect(toSessionKey("direct", "abc123")).toBe("agentclub:direct:abc123");
  });

  it("builds a group session key", () => {
    expect(toSessionKey("group", "xyz789")).toBe("agentclub:group:xyz789");
  });
});

describe("parseSessionKey", () => {
  it("parses a direct session key", () => {
    const result = parseSessionKey("agentclub:direct:abc123");
    expect(result).toEqual({ chatType: "direct", chatId: "abc123" });
  });

  it("parses a group session key", () => {
    const result = parseSessionKey("agentclub:group:xyz789");
    expect(result).toEqual({ chatType: "group", chatId: "xyz789" });
  });

  it("returns null for keys from other channels", () => {
    expect(parseSessionKey("slack:direct:abc")).toBeNull();
  });

  it("returns null for malformed keys", () => {
    expect(parseSessionKey("agentclub")).toBeNull();
    expect(parseSessionKey("agentclub:")).toBeNull();
    expect(parseSessionKey("agentclub:unknown:id")).toBeNull();
    expect(parseSessionKey("")).toBeNull();
  });

  it("handles chat IDs containing colons", () => {
    const result = parseSessionKey("agentclub:group:id:with:colons");
    expect(result).toEqual({ chatType: "group", chatId: "id:with:colons" });
  });

  it("round-trips correctly", () => {
    const key = toSessionKey("direct", "test-id-42");
    const parsed = parseSessionKey(key);
    expect(parsed).toEqual({ chatType: "direct", chatId: "test-id-42" });
  });
});
