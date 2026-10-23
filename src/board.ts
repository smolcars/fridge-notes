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
 * notes still arrive but stop ringing until the pair has been quiet for that long.
 */
export const MAX_EXCHANGES = 10;
const EXCHANGE_WINDOW_MS = 10 * 60_000;

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
  // In-memory, so limits reset when the object is evicted. Good enough to stop a runaway agent,
  // slow down password guessing, or break a loop between two agents.
  readonly #windows = new Map<string, { start: number; count: number }>();
  readonly #exchanges = new Map<string, { lastFrom: string; count: number; at: number }>();

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

  /** For the approval page, after the owner's password: whether reusing `name` shares a mailbox. */
  agentExists(name: string): boolean {
    return this.#sql.exec("SELECT 1 FROM agents WHERE name = ?", name).toArray().length > 0;
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
   * only a reply-to-reply loop between two agents with doorbells is ever held back.
   */
  #allowExchange(from: string, to: string): boolean {
    const pair = [from, to].toSorted().join("\n");
    const now = Date.now();
    const state = this.#exchanges.get(pair);
    if (state === undefined || now - state.at >= EXCHANGE_WINDOW_MS) {
      if (this.#exchanges.size > 1_000) {
        for (const [key, stale] of this.#exchanges) {
          if (now - stale.at >= EXCHANGE_WINDOW_MS) this.#exchanges.delete(key);
        }
      }
      this.#exchanges.set(pair, { lastFrom: from, count: 0, at: now });
      return true;
    }
    if (state.lastFrom !== from) state.count++;
    state.lastFrom = from;
    state.at = now;
    return state.count < MAX_EXCHANGES;
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
