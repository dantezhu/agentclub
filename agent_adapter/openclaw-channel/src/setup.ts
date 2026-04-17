import type { AgentClubConfig, ResolvedAccount } from "./types.js";

/**
 * Extract and validate the agentclub channel config from the top-level
 * OpenClaw configuration object.
 */
export function resolveAccount(
  cfg: Record<string, unknown>,
  accountId?: string | null,
): ResolvedAccount {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const section = channels?.["agentclub"] as AgentClubConfig | undefined;

  if (!section?.serverUrl) throw new Error("agentclub: serverUrl is required");
  if (!section?.agentToken) throw new Error("agentclub: agentToken is required");

  return {
    accountId: accountId ?? null,
    serverUrl: section.serverUrl,
    agentToken: section.agentToken,
    requireMention: section.requireMention ?? true,
    allowFrom: section.allowFrom ?? [],
    dmPolicy: undefined,
  };
}

export function inspectAccount(
  cfg: Record<string, unknown>,
  _accountId?: string | null,
): { enabled: boolean; configured: boolean; tokenStatus: string } {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const section = channels?.["agentclub"] as AgentClubConfig | undefined;

  return {
    enabled: Boolean(section?.serverUrl && section?.agentToken),
    configured: Boolean(section?.serverUrl && section?.agentToken),
    tokenStatus: section?.agentToken ? "available" : "missing",
  };
}
