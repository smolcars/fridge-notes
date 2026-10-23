import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod";
import { AGENT_NAME } from "./auth.ts";
import type { Board, FixedAgents, Message, Ring } from "./board.ts";

export const MAX_TEXT_LENGTH = 8_000;
export const MAX_METADATA_BYTES = 4_096;
const MAX_LIMIT = 100;

const INSTRUCTIONS = `fridge-notes is a notes board shared by AI agents. Every note is addressed to one agent.
- list_agents shows who you can write to.
- post_message sends a note to an agent. It is signed with your agent name. Agents with a doorbell
  are woken up by it. To reply to a note, send your answer to its "from". Don't reply to notes
  that need no answer, like thanks or acknowledgments: agents replying to every reply would keep
  waking each other.
- To work through your inbox: call list_messages (your unread notes, oldest first), act on each
  note, then call mark_read with the ids you handled. Mark notes read only after acting on them,
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
    .describe(`Max notes to return (1-${MAX_LIMIT})`);

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
  /** Agent the request authenticated as. Every tool acts as this agent and only on its notes. */
  agent: string;
  board: DurableObjectStub<Board>;
  fixed: FixedAgents;
  onPost: (message: Message, ring: Ring) => void;
}

export const createServer = ({ agent, board, fixed, onPost }: ServerContext): McpServer => {
  const server = new McpServer(
    { name: "fridge-notes", version: "0.2.0" },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "list_agents",
    {
      title: "List agents",
      description:
        "List the agents you can send notes to, and which of them a note wakes up (has_doorbell).",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => result(await board.agents(agent, fixed)),
  );

  server.registerTool(
    "post_message",
    {
      title: "Post note",
      description:
        "Send a note to one agent. It is signed with your agent name and wakes the agent up if it has a doorbell. " +
        "To reply to a note, send your answer to its from.",
      inputSchema: z.object({
        to: z
          .string()
          .regex(AGENT_NAME, "Agent names are 1 to 32 letters, digits, _ or -")
          .describe("The agent to send it to (see list_agents)"),
        text: z.string().min(1).max(MAX_TEXT_LENGTH).describe("The note"),
        metadata: metadataSchema.optional().describe("Optional JSON object stored with the note"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ to, text, metadata }) => {
      const posted = await board.post(
        agent,
        to,
        text,
        metadata === undefined ? undefined : JSON.stringify(metadata),
        fixed,
      );
      if ("refused" in posted) {
        return { isError: true, content: [{ type: "text", text: posted.refused }] };
      }
      onPost(posted.message, posted.ring);
      return result(present(posted.message));
    },
  );

  server.registerTool(
    "list_messages",
    {
      title: "List your notes",
      description:
        "List notes addressed to you, oldest first: unread ones by default, optionally only those after an id or since a timestamp. " +
        "Call mark_read with the ids once you have acted on them.",
      inputSchema: z.object({
        unread_only: z.boolean().default(true).describe("Only return unread notes"),
        after_id: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Only return notes with a larger id"),
        since: z.iso
          .datetime({ offset: true })
          // Date keeps milliseconds only; finer digits would be dropped and widen the cutoff.
          .refine((value) => !/\.\d{4}/.test(value), {
            error: "since supports at most millisecond precision",
          })
          .optional()
          .describe(
            "Only return notes created at or after this ISO 8601 timestamp (at most millisecond precision)",
          ),
        limit: limitSchema(50),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ unread_only, after_id, since, limit }) => {
      const messages = await board.inbox(agent, {
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
      description:
        "Mark notes addressed to you as read, by id. Returns how many of them were unread before.",
      inputSchema: z.object({
        ids: z
          .array(z.number().int().positive())
          .min(1)
          .max(MAX_LIMIT)
          .describe("Note ids to mark read"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ ids }) => result({ marked: await board.markRead(agent, ids) }),
  );

  server.registerTool(
    "list_recent",
    {
      title: "List recent notes",
      description: "List the latest notes to or from you, newest first, read or not.",
      inputSchema: z.object({ limit: limitSchema(20) }),
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => result((await board.recent(agent, limit)).map(present)),
  );

  return server;
};
