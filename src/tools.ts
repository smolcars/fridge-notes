import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { Board, Message } from "./board.ts";

export const MAX_TEXT_LENGTH = 8_000;
export const MAX_METADATA_BYTES = 4_096;
const MAX_LIMIT = 100;

const INSTRUCTIONS = `fridge-notes is a shared message board.
- post_message leaves a message. It is signed with your agent name and wakes Grok Bot up.
- To work through your inbox: call list_messages (unread, oldest first), act on each message,
  then call mark_read with the ids you handled. Mark messages read only after acting on them,
  so nothing is lost if you stop halfway.`;

// A plain object schema: the recursive schema z.json() emits trips up some tool-calling clients.
const metadataSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (metadata) =>
      new TextEncoder().encode(JSON.stringify(metadata)).byteLength <= MAX_METADATA_BYTES,
    {
      error: `metadata must be at most ${MAX_METADATA_BYTES} bytes as JSON`,
    },
  );

const limitSchema = (fallback: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .default(fallback)
    .describe(`Max messages to return (1-${MAX_LIMIT})`);

const result = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});

const parseJson = (text: string): unknown => JSON.parse(text);

/** Expands the stored metadata string back into an object for the agent. */
const present = ({ metadata, ...message }: Message) => ({
  ...message,
  metadata: metadata === null ? null : parseJson(metadata),
});

interface ServerContext {
  /** Agent name the request authenticated as; becomes `from` on posted messages. */
  agent: string;
  board: DurableObjectStub<Board>;
  onPost: (message: Message) => void;
}

export const createServer = ({ agent, board, onPost }: ServerContext): McpServer => {
  const server = new McpServer(
    { name: "fridge-notes", version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "post_message",
    {
      title: "Post message",
      description:
        "Post a message to the board. It is signed with your agent name and wakes Grok Bot up.",
      inputSchema: z.object({
        text: z.string().min(1).max(MAX_TEXT_LENGTH).describe("The message"),
        metadata: metadataSchema
          .optional()
          .describe("Optional JSON object stored with the message"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ text, metadata }) => {
      const message = await board.post(
        agent,
        text,
        metadata === undefined ? undefined : JSON.stringify(metadata),
      );
      onPost(message);
      return result(present(message));
    },
  );

  server.registerTool(
    "list_messages",
    {
      title: "List messages",
      description:
        "List messages oldest first: unread ones by default, optionally only those after an id or since a timestamp. " +
        "Call mark_read with the ids once you have acted on them.",
      inputSchema: z.object({
        unread_only: z.boolean().default(true).describe("Only return unread messages"),
        after_id: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Only return messages with a larger id"),
        since: z.iso
          .datetime({ offset: true })
          // Date keeps milliseconds only; finer digits would be dropped and widen the cutoff.
          .refine((value) => !/\.\d{4}/.test(value), {
            error: "since supports at most millisecond precision",
          })
          .optional()
          .describe(
            "Only return messages created at or after this ISO 8601 timestamp (at most millisecond precision)",
          ),
        limit: limitSchema(50),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ unread_only, after_id, since, limit }) => {
      const messages = await board.list({
        unreadOnly: unread_only,
        afterId: after_id,
        since: since === undefined ? undefined : new Date(since).toISOString(),
        limit,
      });
      return result(messages.map(present));
    },
  );

  server.registerTool(
    "mark_read",
    {
      title: "Mark read",
      description: "Mark messages as read by id. Returns how many were unread before.",
      inputSchema: z.object({
        ids: z
          .array(z.number().int().positive())
          .min(1)
          .max(MAX_LIMIT)
          .describe("Message ids to mark read"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ ids }) => result({ marked: await board.markRead(ids) }),
  );

  server.registerTool(
    "list_recent",
    {
      title: "List recent messages",
      description: "List the latest messages newest first, read or not. Meant for debugging.",
      inputSchema: z.object({ limit: limitSchema(20) }),
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => result((await board.recent(limit)).map(present)),
  );

  return server;
};
