const AGENT_NAME = /^[\w-]{1,32}$/;
const MIN_TOKEN_LENGTH = 16;

const sha256 = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

/**
 * Parses `AUTH_TOKENS`: comma-separated `name:token` pairs, one per agent, e.g.
 * `grok:3f9c...,claude:a71b...`. The name becomes the `from` of every message the agent posts.
 * Throws on any malformed entry so a typo fails closed instead of silently dropping an agent.
 */
const parseTokens = async (config: string): Promise<Map<string, string>> => {
  const entries = config.split(",").map((entry, index) => {
    const separator = entry.indexOf(":");
    const name = entry.slice(0, separator).trim();
    const token = entry.slice(separator + 1).trim();
    if (separator === -1 || !AGENT_NAME.test(name) || token.length < MIN_TOKEN_LENGTH) {
      throw new Error(
        `AUTH_TOKENS entry ${index + 1} must be name:token with a name of letters, digits, _ or - and a token of ${MIN_TOKEN_LENGTH}+ characters`,
      );
    }
    return { name, token };
  });
  return new Map(
    await Promise.all(entries.map(async ({ name, token }) => [await sha256(token), name] as const)),
  );
};

/**
 * Returns the agent name for the request's bearer token, or undefined if it has none or an unknown one.
 * Tokens are compared by SHA-256 digest so the lookup leaks nothing useful through timing.
 */
export const authenticate = async (
  request: Request,
  config: string | undefined,
): Promise<string | undefined> => {
  if (config === undefined || config.trim() === "") {
    throw new Error("AUTH_TOKENS is not set");
  }
  const tokens = await parseTokens(config);
  const presented = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  return presented === undefined ? undefined : tokens.get(await sha256(presented));
};
