import type { Message } from "./board.ts";
import type { Env } from "./index.ts";

/** Grok Bot's own posts must not wake Grok Bot. Give its token this name in AUTH_TOKENS. */
export const DOORBELL_OWNER = "grok";

/**
 * Tells Grok Bot there is mail. Never throws: the message is already stored, and a missed ring is
 * recovered the next time Grok Bot wakes and reads everything unread.
 */
export const ringDoorbell = async (env: Env, message: Message): Promise<void> => {
  if (!env.WEBHOOK_URL || message.from === DOORBELL_OWNER) return;
  try {
    const response = await fetch(env.WEBHOOK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(env.WEBHOOK_TOKEN ? { authorization: `Bearer ${env.WEBHOOK_TOKEN}` } : {}),
      },
      body: JSON.stringify({ event: "new_message", message_id: message.id, from: message.from }),
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();
    if (!response.ok) console.error(`doorbell: webhook answered ${response.status}`);
  } catch (error) {
    console.error("doorbell: webhook failed", error);
  }
};
