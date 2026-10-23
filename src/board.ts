import { DurableObject } from "cloudflare:workers";

/** A stored note. `metadata` stays a JSON string so the type survives the RPC boundary. */
export interface Message {
  id: number;
  text: string;
  from: string;
  /** Null only for notes from before notes were addressed. */
  to: string | null;
  created_at: string;
  read: boolean;
  metadata: string | null;
}

/** Where to wake an agent. Stays inside the server: no tool ever returns it. */
export interface Doorbell {
  url: string;
  token: string | null;
}

/**
 * Agents that come from settings rather than from approvals: fixed-token names, and the agent
 * the `WEBHOOK_*` settings wake.
 */
export interface FixedAgents {
  names: string[];
  doorbellAgent: string | null;
}

/** A refusal (unknown recipient, rate limit) is a result, not a throw, so it isn't logged as a crash. */
export type PostResult = { message: Message; doorbell: Doorbell | null } | { refused: string };

export interface ListOptions {
  unreadOnly: boolean;
  afterId?: number | undefined;
  since?: string | undefined;
  limit: number;
}

export const POSTS_PER_MINUTE = 30;
export const LOGIN_FAILURES = 10;
const LOGIN_WINDOW_MS = 15 * 60_000;

type MessageRow = {
  id: number;
  text: string;
  sender: string;
  recipient: string | null;
  created_at: string;
  read: number;
  metadata: string | null;
};

type AgentRow = {
  name: string;
  webhook_url: string | null;
  webhook_token: string | null;
};

const toMessage = (row: MessageRow): Message => ({
  id: row.id,
  text: row.text,
  from: row.sender,
  to: row.recipient,
  created_at: row.created_at,
  read: row.read === 1,
  metadata: row.metadata,
});

/**
 * The single notes board. One instance, addressed by name, holds every note and agent in SQLite.
 * Every method that reads or changes notes takes the calling agent and only touches that agent's
 * own notes, so agents can't read or mark each other's mail.
 */
export class Board extends DurableObject {
  readonly #sql: SqlStorage;
  // In-memory, so limits reset when the object is evicted. Good enough to stop a runaway agent
  // or slow down password guessing.
  readonly #windows = new Map<string, { start: number; count: number }>();

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY,
        text TEXT NOT NULL,
        sender TEXT NOT NULL,
        created_at TEXT NOT NULL,
        read INTEGER NOT NULL DEFAULT 0,
        metadata TEXT
      )
    `);
    try {
      this.#sql.exec("ALTER TABLE messages ADD COLUMN recipient TEXT");
    } catch (error) {
      if (!String(error).includes("duplicate column")) throw error;
    }
    this.#sql.exec(
      "CREATE INDEX IF NOT EXISTS messages_by_recipient ON messages (recipient, read, id)",
    );
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        name TEXT PRIMARY KEY,
        webhook_url TEXT,
        webhook_token TEXT,
        created_at TEXT NOT NULL
      )
    `);
  }

  /**
   * Stores a note from `from` to `to` and returns it with `to`'s doorbell, if it has one. A note
   * to yourself never rings. Refuses a `to` that isn't a known agent, so a typo can't vanish.
   */
  post(
    from: string,
    to: string,
    text: string,
    metadata: string | undefined,
    fixed: FixedAgents,
  ): PostResult {
    if (this.#hit(`post:${from}`, 60_000).count > POSTS_PER_MINUTE) {
      return { refused: `Rate limit exceeded: at most ${POSTS_PER_MINUTE} posts per minute` };
    }
    this.#register(from);
    const known = this.#knownNames(fixed);
    if (!known.includes(to)) {
      return { refused: `There's no agent named "${to}". Agents: ${known.join(", ")}.` };
    }
    const row = this.#sql
      .exec<MessageRow>(
        "INSERT INTO messages (text, sender, recipient, created_at, metadata) VALUES (?, ?, ?, ?, ?) RETURNING *",
        text,
        from,
        to,
        new Date().toISOString(),
        metadata ?? null,
      )
      .one();
    return { message: toMessage(row), doorbell: to === from ? null : this.#doorbell(to) };
  }

  /** Notes addressed to `agent`, oldest first, so it can work through them in order. */
  inbox(agent: string, { unreadOnly, afterId, since, limit }: ListOptions): Message[] {
    this.#register(agent);
    const where = ["recipient = ?"];
    const params: SqlStorageValue[] = [agent];
    if (unreadOnly) where.push("read = 0");
    if (afterId !== undefined) {
      where.push("id > ?");
      params.push(afterId);
    }
    if (since !== undefined) {
      where.push("created_at >= ?");
      params.push(since);
    }
    return this.#sql
      .exec<MessageRow>(
        `SELECT * FROM messages WHERE ${where.join(" AND ")} ORDER BY id LIMIT ?`,
        ...params,
        limit,
      )
      .toArray()
      .map(toMessage);
  }

  /** Notes to or from `agent`, newest first, read or not. */
  recent(agent: string, limit: number): Message[] {
    this.#register(agent);
    return this.#sql
      .exec<MessageRow>(
        "SELECT * FROM messages WHERE recipient = ? OR sender = ? ORDER BY id DESC LIMIT ?",
        agent,
        agent,
        limit,
      )
      .toArray()
      .map(toMessage);
  }

  /** Marks `agent`'s own notes read; ids of other agents' notes are ignored. Returns how many changed. */
  markRead(agent: string, ids: number[]): number {
    this.#register(agent);
    // Count RETURNING rows: `rowsWritten` also counts index writes.
    return this.#sql
      .exec(
        "UPDATE messages SET read = 1 WHERE recipient = ? AND read = 0 AND id IN (SELECT value FROM json_each(?)) RETURNING id",
        agent,
        JSON.stringify(ids),
      )
      .toArray().length;
  }

  /** Every agent a note can be addressed to, and whether a note to it rings a doorbell. */
  agents(caller: string, fixed: FixedAgents): { name: string; has_doorbell: boolean }[] {
    this.#register(caller);
    const withDoorbell = new Set(
      this.#sql
        .exec<{ name: string }>("SELECT name FROM agents WHERE webhook_url IS NOT NULL")
        .toArray()
        .map((row) => row.name),
    );
    if (fixed.doorbellAgent !== null) withDoorbell.add(fixed.doorbellAgent);
    return this.#knownNames(fixed).map((name) => ({ name, has_doorbell: withDoorbell.has(name) }));
  }

  /** For the approval page: each agent and, if it has a doorbell, only the webhook's host. */
  agentSummaries(): { name: string; doorbellHost: string | null }[] {
    return this.#sql
      .exec<AgentRow>("SELECT * FROM agents ORDER BY name")
      .toArray()
      .map((row) => ({
        name: row.name,
        doorbellHost: row.webhook_url === null ? null : new URL(row.webhook_url).host,
      }));
  }

  /**
   * Records an approved agent. `doorbell` replaces its webhook, `null` removes it, and
   * `undefined` keeps whatever it has, so approving an agent again can't drop it by accident.
   */
  saveAgent(name: string, doorbell: Doorbell | null | undefined): void {
    this.#register(name);
    if (doorbell === undefined) return;
    this.#sql.exec(
      "UPDATE agents SET webhook_url = ?, webhook_token = ? WHERE name = ?",
      doorbell?.url ?? null,
      doorbell?.token ?? null,
      name,
    );
  }

  /**
   * Counts an owner-password attempt before the password is checked, in one step, so a burst of
   * concurrent guesses can't all pass the check first. Returns the window the attempt counted in,
   * for `forgiveLoginAttempt`, or undefined once `client` is locked out.
   */
  beginLoginAttempt(client: string): number | undefined {
    const key = `login:${client}`;
    if (this.#count(key, LOGIN_WINDOW_MS) >= LOGIN_FAILURES) return undefined;
    return this.#hit(key, LOGIN_WINDOW_MS).start;
  }

  /**
   * A correct password gives its attempt back, so approving apps never locks the owner out. Only
   * to the window it was counted in: a late refund must not erase a failure in a newer window.
   */
  forgiveLoginAttempt(client: string, windowStart: number): void {
    const window = this.#windows.get(`login:${client}`);
    if (window?.start === windowStart && window.count > 0) window.count--;
  }

  /** Agents exist from their approval or their first call, so others can address them. */
  #register(name: string): void {
    this.#sql.exec(
      "INSERT OR IGNORE INTO agents (name, created_at) VALUES (?, ?)",
      name,
      new Date().toISOString(),
    );
  }

  #knownNames(fixed: FixedAgents): string[] {
    const stored = this.#sql
      .exec<{ name: string }>("SELECT name FROM agents")
      .toArray()
      .map((row) => row.name);
    const all = [...stored, ...fixed.names];
    if (fixed.doorbellAgent !== null) all.push(fixed.doorbellAgent);
    return [...new Set(all)].toSorted();
  }

  #doorbell(name: string): Doorbell | null {
    const row = this.#sql.exec<AgentRow>("SELECT * FROM agents WHERE name = ?", name).toArray()[0];
    return row?.webhook_url == null ? null : { url: row.webhook_url, token: row.webhook_token };
  }

  /** Events for `key` in its current fixed window. */
  #count(key: string, windowMs: number): number {
    const window = this.#windows.get(key);
    return window === undefined || Date.now() - window.start >= windowMs ? 0 : window.count;
  }

  /** Records an event for `key` and returns its current fixed window. */
  #hit(key: string, windowMs: number): { start: number; count: number } {
    const now = Date.now();
    if (this.#windows.size > 1_000) {
      // Login keys are per client IP, so drop finished windows before the map can grow unbounded.
      for (const [stale, window] of this.#windows) {
        if (now - window.start >= LOGIN_WINDOW_MS) this.#windows.delete(stale);
      }
    }
    const window = this.#windows.get(key);
    if (window === undefined || now - window.start >= windowMs) {
      const fresh = { start: now, count: 1 };
      this.#windows.set(key, fresh);
      return fresh;
    }
    window.count++;
    return window;
  }
}
