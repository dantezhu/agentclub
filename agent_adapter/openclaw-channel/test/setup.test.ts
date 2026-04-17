import { describe, it, expect } from "vitest";
import { resolveAccount, inspectAccount } from "../src/setup.js";

describe("resolveAccount", () => {
  it("resolves a valid config", () => {
    const cfg = {
      channels: {
        "agentclub": {
          serverUrl: "https://im.example.com:5555",
          agentToken: "my-secret-token",
          requireMention: false,
          allowFrom: ["user-1"],
        },
      },
    };

    const account = resolveAccount(cfg);

    expect(account.serverUrl).toBe("https://im.example.com:5555");
    expect(account.agentToken).toBe("my-secret-token");
    expect(account.requireMention).toBe(false);
    expect(account.allowFrom).toEqual(["user-1"]);
  });

  it("defaults requireMention to true", () => {
    const cfg = {
      channels: {
        "agentclub": {
          serverUrl: "https://im.example.com",
          agentToken: "token",
        },
      },
    };

    const account = resolveAccount(cfg);
    expect(account.requireMention).toBe(true);
  });

  it("throws when serverUrl is missing", () => {
    const cfg = { channels: { "agentclub": { agentToken: "token" } } };
    expect(() => resolveAccount(cfg)).toThrow("serverUrl is required");
  });

  it("throws when agentToken is missing", () => {
    const cfg = { channels: { "agentclub": { serverUrl: "https://im.example.com" } } };
    expect(() => resolveAccount(cfg)).toThrow("agentToken is required");
  });
});

describe("inspectAccount", () => {
  it("reports configured when both fields present", () => {
    const cfg = {
      channels: {
        "agentclub": {
          serverUrl: "https://im.example.com",
          agentToken: "token",
        },
      },
    };

    const result = inspectAccount(cfg);
    expect(result.enabled).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.tokenStatus).toBe("available");
  });

  it("reports not configured when section is missing", () => {
    const result = inspectAccount({ channels: {} });
    expect(result.configured).toBe(false);
    expect(result.tokenStatus).toBe("missing");
  });

  it("reports not configured when token is missing", () => {
    const cfg = { channels: { "agentclub": { serverUrl: "https://im.example.com" } } };
    const result = inspectAccount(cfg);
    expect(result.configured).toBe(false);
  });
});
