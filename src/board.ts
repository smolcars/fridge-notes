import { DurableObject } from "cloudflare:workers";

/** A stored message. `metadata` stays a JSON string so the type survives the RPC boundary. */
export interface Message {
  id: number;
  text: string;
  from: string;
  created_at: string;
  read: boolean;
  metadata: string | null;
}

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
  created_at: string;
  read: number;
  metadata: string | null;
};

const toMessage = (row: MessageRow): Message => ({
  id: row.id,
  text: row.text,
  from: row.sender,
  created_at: row.created_at,
  read: row.read === 1,
  metadata: row.metadata,
});

/** The single message board. One instance, addressed by name, holds every message in SQLite. */
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
    this.#sql.exec("CREATE INDEX IF NOT EXISTS messages_by_read ON messages (read, id)");
  }

  /** `metadata` is a JSON object serialized by the caller. */
  post(from: string, text: string, metadata: string | undefined): Message {
    if (this.#hit(`post:${from}`, 60_000) > POSTS_PER_MINUTE) {
      throw new Error(`Rate limit exceeded: at most ${POSTS_PER_MINUTE} posts per minute`);
    }
    const row = this.#sql
      .exec<MessageRow>(
        "INSERT INTO messages (text, sender, created_at, metadata) VALUES (?, ?, ?, ?) RETURNING *",
        text,
        from,
        new Date().toISOString(),
        metadata ?? null,
      )
      .one();
    return toMessage(row);
  }

  /** Oldest first, so an agent can work through its inbox in order. */
  list({ unreadOnly, afterId, since, limit }: ListOptions): Message[] {
    const where: string[] = [];
    const params: SqlStorageValue[] = [];
    if (unreadOnly) where.push("read = 0");
    if (afterId !== undefined) {
      where.push("id > ?");
      params.push(afterId);
    }
    if (since !== undefined) {
      where.push("created_at >= ?");
      params.push(since);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return this.#sql
      .exec<MessageRow>(`SELECT * FROM messages ${clause} ORDER BY id LIMIT ?`, ...params, limit)
      .toArray()
      .map(toMessage);
  }

  /** Newest first, regardless of read status. */
  recent(limit: number): Message[] {
    return this.#sql
      .exec<MessageRow>("SELECT * FROM messages ORDER BY id DESC LIMIT ?", limit)
      .toArray()
      .map(toMessage);
  }

  /** Returns how many messages changed from unread to read. */
  markRead(ids: number[]): number {
    // Count RETURNING rows: `rowsWritten` also counts index writes.
    return this.#sql
      .exec(
        "UPDATE messages SET read = 1 WHERE read = 0 AND id IN (SELECT value FROM json_each(?)) RETURNING id",
        JSON.stringify(ids),
      )
      .toArray().length;
  }

  /** True once `client` has entered the owner password wrong too often in the current window. */
  loginLocked(client: string): boolean {
    return this.#count(`login:${client}`, LOGIN_WINDOW_MS) >= LOGIN_FAILURES;
  }

  /** Only failures count, so the owner never locks themselves out by approving apps. */
  recordLoginFailure(client: string): void {
    this.#hit(`login:${client}`, LOGIN_WINDOW_MS);
  }

  /** Events for `key` in its current fixed window. */
  #count(key: string, windowMs: number): number {
    const window = this.#windows.get(key);
    return window === undefined || Date.now() - window.start >= windowMs ? 0 : window.count;
  }

  /** Records an event for `key` and returns the count in its current fixed window. */
  #hit(key: string, windowMs: number): number {
    const now = Date.now();
    if (this.#windows.size > 1_000) {
      // Login keys are per client IP, so drop finished windows before the map can grow unbounded.
      for (const [stale, window] of this.#windows) {
        if (now - window.start >= LOGIN_WINDOW_MS) this.#windows.delete(stale);
      }
    }
    const window = this.#windows.get(key);
    if (window === undefined || now - window.start >= windowMs) {
      this.#windows.set(key, { start: now, count: 1 });
      return 1;
    }
    return ++window.count;
  }
}
