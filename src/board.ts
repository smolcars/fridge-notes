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
 * What to ring for a new note: the recipient's own doorbell, `"settings"` for the `WEBHOOK_*`
 * doorbell (whose URL and key only the Worker knows), or nothing.
 */
export type Ring = Doorbell | "settings" | null;

/**
 * Agents that come from settings rather than from approvals: fixed-token names, and the agent
 * the `WEBHOOK_*` settings wake.
 */
export interface FixedAgents {
  names: string[];
  doorbellAgent: string | null;
}

/** A refusal (unknown recipient, rate limit) is a result, not a throw, so it isn't logged as a crash. */
export type PostResult = { message: Message; ring: Ring } | { refused: string };

export interface ListOptions {
  unreadOnly: boolean;
  afterId?: number | undefined;
  since?: string | undefined;
  limit: number;
}

export const POSTS_PER_MINUTE = 30;
export const LOGIN_FAILURES = 10;
const LOGIN_WINDOW_MS = 15 * 60_000;
/**
 * Two agents with doorbells could wake each other forever by replying to every reply. After this
 * many exchanges between the same two agents, each within EXCHANGE_WINDOW_MS of the last, their
 * notes still arrive but stop ringing until EXCHANGE_WINDOW_MS after the last ring.
 */
export const MAX_EXCHANGES = 10;
const EXCHANGE_WINDOW_MS = 10 * 60_000;
/** The longest window anything is counted over, so older counter rows can be dropped. */
const LONGEST_WINDOW_MS = Math.max(LOGIN_WINDOW_MS, EXCHANGE_WINDOW_MS);

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
  /** 1 once the owner removed its doorbell: then the `WEBHOOK_*` doorbell doesn't apply either. */
  doorbell_off: number;
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
    this.#addColumn("messages", "recipient TEXT");
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
    this.#addColumn("agents", "doorbell_off INTEGER NOT NULL DEFAULT 0");
    // Counters live in SQLite, not memory: an idle Durable Object is evicted within seconds, and a
    // limit that resets then wouldn't stop slow password guessing or a slow loop.
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS limits (
        key TEXT PRIMARY KEY,
        start INTEGER NOT NULL,
        count INTEGER NOT NULL
      )
    `);
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS exchanges (
        pair TEXT PRIMARY KEY,
        last_from TEXT NOT NULL,
        count INTEGER NOT NULL,
        at INTEGER NOT NULL
      )
    `);
  }

  /**
   * Stores a note from `from` to `to` and says what to ring. Refuses a `to` that isn't a known
   * agent, so a typo can't vanish.
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
    return { message: toMessage(row), ring: this.#ringFor(from, to, fixed) };
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
    return this.#knownNames(fixed).map((name) => ({
      name,
      has_doorbell: this.#doorbellOf(name, fixed) !== null,
    }));
  }

  /**
   * For the approval page, after the owner's password: whether `name` already has a mailbox,
   * counting agents that so far exist only in settings.
   */
  agentExists(name: string, fixed: FixedAgents): boolean {
    return this.#knownNames(fixed).includes(name);
  }

  /**
   * Records an approved agent. `doorbell` replaces its webhook; `null` removes it, including the
   * `WEBHOOK_*` doorbell; `undefined` keeps whatever it has, so approving an agent again can't
   * drop its doorbell by accident.
   */
  saveAgent(name: string, doorbell: Doorbell | null | undefined): void {
    this.#register(name);
    if (doorbell === undefined) return;
    this.#sql.exec(
      "UPDATE agents SET webhook_url = ?, webhook_token = ?, doorbell_off = ? WHERE name = ?",
      doorbell?.url ?? null,
      doorbell?.token ?? null,
      doorbell === null ? 1 : 0,
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
    this.#sql.exec(
      "UPDATE limits SET count = count - 1 WHERE key = ? AND start = ? AND count > 0",
      `login:${client}`,
      windowStart,
    );
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

  /** The one place that decides which doorbell, if any, an agent has. */
  #doorbellOf(name: string, fixed: FixedAgents): Ring {
    const row = this.#sql.exec<AgentRow>("SELECT * FROM agents WHERE name = ?", name).toArray()[0];
    if (row?.webhook_url != null) return { url: row.webhook_url, token: row.webhook_token };
    if (row?.doorbell_off === 1) return null;
    return fixed.doorbellAgent === name ? "settings" : null;
  }

  /** What a note from `from` to `to` rings: never yourself, and not past the exchange limit. */
  #ringFor(from: string, to: string, fixed: FixedAgents): Ring {
    if (from === to) return null;
    const ring = this.#doorbellOf(to, fixed);
    return ring !== null && this.#allowExchange(from, to) ? ring : null;
  }

  /**
   * Counts how often two agents' rings have gone back and forth. One-way notes never count, so
   * only a reply-to-reply loop between two agents with doorbells is ever held back. A held-back
   * note doesn't extend the pause, so the pair rings again EXCHANGE_WINDOW_MS after its last ring.
   */
  #allowExchange(from: string, to: string): boolean {
    const pair = [from, to].toSorted().join("\n");
    const now = Date.now();
    const state = this.#sql
      .exec<{ last_from: string; count: number; at: number }>(
        "SELECT last_from, count, at FROM exchanges WHERE pair = ?",
        pair,
      )
      .toArray()[0];
    const fresh = state === undefined || now - state.at >= EXCHANGE_WINDOW_MS;
    const count = fresh ? 0 : state.count + (state.last_from === from ? 0 : 1);
    if (count >= MAX_EXCHANGES) {
      // Held back: remember the direction and count, but keep `at`, the time of the last ring.
      this.#sql.exec(
        "UPDATE exchanges SET last_from = ?, count = ? WHERE pair = ?",
        from,
        count,
        pair,
      );
      return false;
    }
    if (fresh) this.#sql.exec("DELETE FROM exchanges WHERE at < ?", now - EXCHANGE_WINDOW_MS);
    this.#sql.exec(
      "INSERT OR REPLACE INTO exchanges (pair, last_from, count, at) VALUES (?, ?, ?, ?)",
      pair,
      from,
      count,
      now,
    );
    return true;
  }

  /** Adds a column to an existing table; a no-op once it's there. */
  #addColumn(table: string, column: string): void {
    try {
      this.#sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
    } catch (error) {
      if (!String(error).includes("duplicate column")) throw error;
    }
  }

  /** Events for `key` in its current fixed window. */
  #count(key: string, windowMs: number): number {
    const row = this.#sql
      .exec<{ start: number; count: number }>("SELECT start, count FROM limits WHERE key = ?", key)
      .toArray()[0];
    return row === undefined || Date.now() - row.start >= windowMs ? 0 : row.count;
  }

  /** Records an event for `key` and returns its current fixed window. */
  #hit(key: string, windowMs: number): { start: number; count: number } {
    const now = Date.now();
    const row = this.#sql
      .exec<{ start: number; count: number }>("SELECT start, count FROM limits WHERE key = ?", key)
      .toArray()[0];
    if (row === undefined || now - row.start >= windowMs) {
      // Login keys are per client IP, so drop finished windows before the table grows.
      this.#sql.exec("DELETE FROM limits WHERE start < ?", now - LONGEST_WINDOW_MS);
      this.#sql.exec(
        "INSERT OR REPLACE INTO limits (key, start, count) VALUES (?, ?, 1)",
        key,
        now,
      );
      return { start: now, count: 1 };
    }
    this.#sql.exec("UPDATE limits SET count = count + 1 WHERE key = ?", key);
    return { start: row.start, count: row.count + 1 };
  }
}
