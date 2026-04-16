import { describe, it, expect } from "vitest";
import { toSessionKey, parseSessionKey } from "../src/session.js";

describe("toSessionKey", () => {
  it("builds a direct session key", () => {
    expect(toSessionKey("direct", "abc123")).toBe("agent-club:direct:abc123");
  });

  it("builds a group session key", () => {
    expect(toSessionKey("group", "xyz789")).toBe("agent-club:group:xyz789");
  });
});

describe("parseSessionKey", () => {
  it("parses a direct session key", () => {
    const result = parseSessionKey("agent-club:direct:abc123");
    expect(result).toEqual({ chatType: "direct", chatId: "abc123" });
  });

  it("parses a group session key", () => {
    const result = parseSessionKey("agent-club:group:xyz789");
    expect(result).toEqual({ chatType: "group", chatId: "xyz789" });
  });

  it("returns null for keys from other channels", () => {
    expect(parseSessionKey("slack:direct:abc")).toBeNull();
  });

  it("returns null for malformed keys", () => {
    expect(parseSessionKey("agent-club")).toBeNull();
    expect(parseSessionKey("agent-club:")).toBeNull();
    expect(parseSessionKey("agent-club:unknown:id")).toBeNull();
    expect(parseSessionKey("")).toBeNull();
  });

  it("handles chat IDs containing colons", () => {
    const result = parseSessionKey("agent-club:group:id:with:colons");
    expect(result).toEqual({ chatType: "group", chatId: "id:with:colons" });
  });

  it("round-trips correctly", () => {
    const key = toSessionKey("direct", "test-id-42");
    const parsed = parseSessionKey(key);
    expect(parsed).toEqual({ chatType: "direct", chatId: "test-id-42" });
  });
});
