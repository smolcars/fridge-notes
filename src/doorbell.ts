import type { Doorbell, Message } from "./board.ts";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** True when this server itself runs on a loopback host, i.e. in local development. */
export const isLoopbackHost = (hostname: string): boolean => LOOPBACK.has(hostname);

/**
 * Checks a webhook typed on the approval page. Returns the doorbell, or why it can't be used.
 * Plain http is accepted only for a loopback host, and only when `allowLoopback` (local dev).
 */
export const parseDoorbell = (
  url: string,
  token: string,
  allowLoopback: boolean,
): Doorbell | string => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "The webhook URL isn't a valid URL.";
  }
  const loopbackHttp =
    allowLoopback && parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname);
  if (parsed.protocol !== "https:" && !loopbackHttp) {
    return "The webhook URL must start with https://.";
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return "The webhook URL can't contain a username or password. Put the key in the key field.";
  }
  if (url.length > 2_048) return "The webhook URL is too long.";
  if (token.length > 1_024 || /[\r\n]/.test(token)) {
    return "The webhook key is too long or has line breaks.";
  }
  return { url: parsed.href, token: token === "" ? null : token };
};

/**
 * Tells an agent it has mail. Never throws: the note is already stored, and a missed ring is
 * recovered the next time the agent wakes and reads its unread notes.
 */
export const ringDoorbell = async (doorbell: Doorbell, message: Message): Promise<void> => {
  try {
    const response = await fetch(doorbell.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(doorbell.token === null ? {} : { authorization: `Bearer ${doorbell.token}` }),
      },
      body: JSON.stringify({
        event: "new_message",
        message_id: message.id,
        from: message.from,
        to: message.to,
      }),
      signal: AbortSignal.timeout(10_000),
      // A redirect could send the note to a host the owner never approved, so it counts as a
      // failed ring instead of being followed.
      redirect: "manual",
    });
    await response.body?.cancel();
    // Log only the status: the webhook URL and key are secrets.
    if (!response.ok) {
      console.error(`doorbell for ${message.to}: webhook answered ${response.status}`);
    }
  } catch (error) {
    // Only the error's type: fetch errors can quote the URL, and webhook URLs carry secrets.
    const kind = error instanceof Error ? error.name : "unknown error";
    console.error(`doorbell for ${message.to}: webhook failed (${kind})`);
  }
};
