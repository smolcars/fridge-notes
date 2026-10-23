// End-to-end check of a running server: auth, every MCP tool, limits, and the webhook doorbell.
// Defaults match .dev.vars.example, so locally it is just `bun run dev`, then `bun run smoke`.
//
//   bun scripts/smoke.ts [base-url]   (default http://127.0.0.1:8787)
//
// Env overrides: AGENT_TOKEN, GROK_TOKEN, WEBHOOK_TOKEN, WEBHOOK_PORT.
import * as z from "zod";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:8787";
const agentToken = process.env["AGENT_TOKEN"] ?? "dev-agent-token-0000";
const grokToken = process.env["GROK_TOKEN"] ?? "dev-grok-token-0000";
const webhookToken = process.env["WEBHOOK_TOKEN"] ?? "dev-webhook-token";
const webhookPort = Number(process.env["WEBHOOK_PORT"] ?? 8788);
const PROTOCOL_VERSION = "2025-06-18";

const RpcReply = z.object({ result: z.unknown().optional(), error: z.unknown().optional() });
const ToolResult = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string() })),
});
const Message = z.object({
  id: z.number(),
  text: z.string(),
  from: z.string(),
  created_at: z.string(),
  read: z.boolean(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
});
const Ring = z.object({ event: z.string(), message_id: z.number(), from: z.string() });

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  if (!ok) failures++;
  const suffix = ok || detail === undefined ? "" : ` → ${JSON.stringify(detail)}`;
  console.log(`${ok ? "✓" : "✗"} ${name}${suffix}`);
};

const parseJson = (text: string): unknown => JSON.parse(text);

// The stateless transport answers with either plain JSON or a one-event SSE stream.
const readRpc = async (response: Response): Promise<z.infer<typeof RpcReply>> => {
  const body = await response.text();
  const isStream = (response.headers.get("content-type") ?? "").includes("text/event-stream");
  const json = isStream
    ? (body
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5) ?? "{}")
    : body;
  return RpcReply.parse(parseJson(json));
};

let nextId = 1;
const rpc = async (token: string, method: string, params: Record<string, unknown> = {}) => {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  return readRpc(response);
};

const callTool = async (token: string, name: string, args: Record<string, unknown>) => {
  const reply = await rpc(token, "tools/call", { name, arguments: args });
  if (reply.error !== undefined) {
    return { isError: true, content: [{ type: "text", text: JSON.stringify(reply.error) }] };
  }
  return ToolResult.parse(reply.result);
};

const tool = async <T extends z.ZodType>(
  schema: T,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<z.infer<T>> => {
  const result = await callTool(token, name, args);
  const text = result.content[0]?.text ?? "null";
  if (result.isError === true) throw new Error(`${name} failed: ${text}`);
  return schema.parse(parseJson(text));
};

// Webhook receiver standing in for Grok Bot's doorbell.
const rings: { authorization: string | null; body: z.infer<typeof Ring> }[] = [];
let onRing = (): void => {};
const receiver = Bun.serve({
  hostname: "127.0.0.1",
  port: webhookPort,
  async fetch(request) {
    rings.push({
      authorization: request.headers.get("authorization"),
      body: Ring.parse(await request.json()),
    });
    onRing();
    return new Response("ok");
  },
});
/** Resolves true on the next ring, false after `ms`. Call before the action that should ring. */
const nextRing = (ms: number): Promise<boolean> =>
  Promise.race([
    new Promise<boolean>((resolve) => {
      onRing = () => resolve(true);
    }),
    Bun.sleep(ms).then(() => false),
  ]);

try {
  const health = await fetch(`${baseUrl}/health`);
  check("GET /health is 200", health.status === 200, health.status);

  const anonymous = await fetch(`${baseUrl}/mcp`, { method: "POST", body: "{}" });
  check("missing token is 401", anonymous.status === 401, anonymous.status);
  const wrong = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { authorization: "Bearer nope" },
    body: "{}",
  });
  check("wrong token is 401", wrong.status === 401, wrong.status);

  const init = await rpc(agentToken, "initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  const server = z.object({ serverInfo: z.object({ name: z.string() }) }).safeParse(init.result);
  check("initialize", server.data?.serverInfo.name === "fridge-notes", init);

  const listed = await rpc(agentToken, "tools/list");
  const tools = z
    .object({ tools: z.array(z.object({ name: z.string() })) })
    .safeParse(listed.result);
  const names = (tools.data?.tools ?? []).map((t) => t.name).toSorted();
  check(
    "tools/list has the four tools",
    names.join() === "list_messages,list_recent,mark_read,post_message",
    names,
  );

  const rang = nextRing(5_000);
  const posted = await tool(Message, agentToken, "post_message", {
    text: "milk is out",
    metadata: { shelf: 2 },
  });
  check("post_message signs with the token's agent", posted.from === "agent", posted);
  check("post_message keeps metadata", posted.metadata?.["shelf"] === 2, posted);
  check("doorbell rings", await rang, rings);
  const ring = rings.at(-1);
  check(
    "doorbell sends the webhook bearer",
    ring?.authorization === `Bearer ${webhookToken}`,
    ring,
  );
  check(
    "doorbell body names the message",
    ring?.body.event === "new_message" && ring.body.message_id === posted.id,
    ring?.body,
  );

  const silent = nextRing(1_500);
  const fromGrok = await tool(Message, grokToken, "post_message", { text: "noted" });
  check("grok's own post does not ring", !(await silent), rings);

  const inbox = { after_id: posted.id - 1 };
  const unread = await tool(z.array(Message), grokToken, "list_messages", inbox);
  check(
    "list_messages returns unread, oldest first",
    unread[0]?.id === posted.id && unread[1]?.id === fromGrok.id,
    unread,
  );
  const since = await tool(z.array(Message), grokToken, "list_messages", {
    since: fromGrok.created_at,
    unread_only: false,
  });
  check(
    "list_messages filters by timestamp",
    since.length > 0 && since.every((message) => message.id >= fromGrok.id),
    since,
  );

  const Marked = z.object({ marked: z.number() });
  const marked = await tool(Marked, grokToken, "mark_read", { ids: [posted.id, fromGrok.id] });
  check("mark_read marks both", marked.marked === 2, marked);
  const again = await tool(Marked, grokToken, "mark_read", { ids: [posted.id] });
  check("mark_read is idempotent", again.marked === 0, again);
  const after = await tool(z.array(Message), grokToken, "list_messages", inbox);
  check("read messages leave the inbox", after.length === 0, after);

  const recent = await tool(z.array(Message), agentToken, "list_recent", { limit: 2 });
  check(
    "list_recent is newest first",
    recent[0]?.id === fromGrok.id && recent[1]?.id === posted.id,
    recent,
  );

  const tooLong = await callTool(agentToken, "post_message", { text: "x".repeat(8_001) });
  check("oversized text is rejected", tooLong.isError === true, tooLong);
  const bigMetadata = await callTool(agentToken, "post_message", {
    text: "hi",
    metadata: { blob: "x".repeat(5_000) },
  });
  check("oversized metadata is rejected", bigMetadata.isError === true, bigMetadata);
  const microseconds = await callTool(agentToken, "list_messages", {
    since: "2026-01-01T00:00:00.000001Z",
  });
  check("sub-millisecond since is rejected", microseconds.isError === true, microseconds);
} finally {
  await receiver.stop(true);
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
