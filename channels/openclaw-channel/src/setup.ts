import {
  ALLOW_FROM_KIND_TOKENS,
  type AgentClubConfig,
  type AllowFromKindToken,
  type ResolvedAccount,
} from "./types.js";

/**
 * Validate the raw `allowFromKind` list. Unknown tokens (e.g. typos like
 * `"humans"` / `"bot"`) raise at load time — silently dropping them
 * would look like "default-deny is broken" to an operator.
 */
function validateAllowFromKind(raw: unknown): AllowFromKindToken[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(
      `agentclub: allowFromKind must be an array, got ${typeof raw}`,
    );
  }
  const valid = new Set<string>(ALLOW_FROM_KIND_TOKENS);
  const invalid = raw.filter((t) => !valid.has(t as string));
  if (invalid.length > 0) {
    throw new Error(
      `agentclub: allowFromKind entries must be one of ${JSON.stringify(
        ALLOW_FROM_KIND_TOKENS,
      )}; got invalid tokens: ${JSON.stringify(invalid)}`,
    );
  }
  return raw as AllowFromKindToken[];
}

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
    allowFromKind: validateAllowFromKind(section.allowFromKind),
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
