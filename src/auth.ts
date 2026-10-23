import type { FixedAgents } from "./board.ts";
import type { Env } from "./index.ts";

export const AGENT_NAME = /^[\w-]{1,32}$/;
const MIN_SECRET_LENGTH = 16;
// RFC 6750 bearer-token characters. No colons: the OAuth library reserves `a:b:c` for its own
// tokens and never passes that shape to the static-token lookup.
const STATIC_TOKEN = /^[\w.~+/-]+=*$/;

const sha256 = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

/**
 * One `AUTH_TOKENS` entry, `name:token`, or null if it's malformed. The only parser for entries,
 * so no caller can mistake part of a token for a name.
 */
const parseEntry = (entry: string): { name: string; token: string } | null => {
  const separator = entry.indexOf(":");
  if (separator === -1) return null;
  const name = entry.slice(0, separator).trim();
  const token = entry.slice(separator + 1).trim();
  const valid =
    AGENT_NAME.test(name) && token.length >= MIN_SECRET_LENGTH && STATIC_TOKEN.test(token);
  return valid ? { name, token } : null;
};

/**
 * Parses `AUTH_TOKENS`: comma-separated `name:token` pairs, one per agent, e.g.
 * `grok:3f9c...,claude:a71b...`. The name becomes the `from` of every message the agent posts.
 * Throws on any malformed entry so a typo fails closed instead of silently dropping an agent.
 */
const parseTokens = async (config: string): Promise<Map<string, string>> => {
  const entries = config.split(",").map((entry, index) => {
    const parsed = parseEntry(entry);
    if (parsed === null) {
      throw new Error(
        `AUTH_TOKENS entry ${index + 1} must be name:token: a name of letters, digits, _ or -, and a token of ${MIN_SECRET_LENGTH}+ letters, digits or - . _ ~ + /`,
      );
    }
    return parsed;
  });
  return new Map(
    await Promise.all(entries.map(async ({ name, token }) => [await sha256(token), name] as const)),
  );
};

/**
 * Returns the agent name for a static bearer token from `AUTH_TOKENS`, or undefined if it isn't
 * one. Tokens are compared by SHA-256 digest so the lookup leaks nothing useful through timing.
 */
export const agentForToken = async (
  token: string,
  config: string | undefined,
): Promise<string | undefined> => {
  if (config === undefined || config.trim() === "") return undefined;
  const tokens = await parseTokens(config);
  return tokens.get(await sha256(token));
};

/**
 * The agent names in `AUTH_TOKENS`, so notes can be addressed to them before they first connect.
 * Skips malformed entries, whole, instead of throwing: a typo there must not stop OAuth agents
 * posting, and must never turn a pasted token into a visible "name".
 */
export const fixedAgentNames = (config: string | undefined): string[] =>
  (config ?? "").split(",").flatMap((entry) => {
    const parsed = parseEntry(entry);
    return parsed === null ? [] : [parsed.name];
  });

/**
 * Agents that exist through settings: `AUTH_TOKENS` names, and `WEBHOOK_AGENT` when `WEBHOOK_URL`
 * is set. Every check of who exists uses this, so a settings-only agent is never overlooked.
 */
export const fixedAgents = (env: Env): FixedAgents => {
  const doorbellAgent = env.WEBHOOK_AGENT?.trim() ?? "";
  return {
    names: fixedAgentNames(env.AUTH_TOKENS),
    doorbellAgent: env.WEBHOOK_URL && AGENT_NAME.test(doorbellAgent) ? doorbellAgent : null,
  };
};

/** True if `OWNER_PASSWORD` is set and long enough to resist guessing. */
export const ownerPasswordConfigured = (expected: string | undefined): expected is string =>
  expected !== undefined && expected.length >= MIN_SECRET_LENGTH;

/** Compares by SHA-256 digest, like tokens, so timing reveals nothing about the password. */
export const passwordMatches = async (presented: string, expected: string): Promise<boolean> =>
  (await sha256(presented)) === (await sha256(expected));
