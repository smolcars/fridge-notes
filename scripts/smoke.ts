// End-to-end check of a running server: static-token and OAuth auth, every MCP tool, mailbox
// isolation between agents, limits, and doorbells.
// Defaults match .dev.vars.example, so locally it is just `bun run dev`, then `bun run smoke`.
//
//   bun scripts/smoke.ts [base-url]   (default http://127.0.0.1:8787)
//
// Env overrides: AGENT_TOKEN, GROK_TOKEN, OWNER_PASSWORD, WEBHOOK_TOKEN, WEBHOOK_PORT.
import * as z from "zod";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:8787";
const agentToken = process.env["AGENT_TOKEN"] ?? "dev-agent-token-0000";
const grokToken = process.env["GROK_TOKEN"] ?? "dev-grok-token-0000";
const webhookToken = process.env["WEBHOOK_TOKEN"] ?? "dev-webhook-token";
const ownerPassword = process.env["OWNER_PASSWORD"] ?? "dev-owner-password-0000";
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
  to: z.string().nullable(),
  created_at: z.string(),
  read: z.boolean(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
});
const Agents = z.array(z.object({ name: z.string(), has_doorbell: z.boolean() }));
const Ring = z.object({
  event: z.string(),
  message_id: z.number(),
  from: z.string(),
  to: z.string(),
});
const ProtectedResource = z.object({
  resource: z.string(),
  authorization_servers: z.array(z.string()).min(1),
});
const AuthServer = z.object({
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  registration_endpoint: z.string(),
});
const Tokens = z.object({ access_token: z.string(), refresh_token: z.string() });

const base64url = (bytes: ArrayBuffer | Uint8Array): string =>
  Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url");

/** Cookie header from a response's Set-Cookie lines, as a browser would send them back. */
const cookiesFrom = (response: Response): string =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");

/** The approval page's form fields we need to post it back. */
const consentForm = (html: string) => ({
  handle: /name="handle" value="([^"]+)"/.exec(html)?.[1] ?? "",
  agent: /name="agent" value="([^"]*)"/.exec(html)?.[1] ?? "",
  webhookUrl: /name="webhook_url" type="url" value="([^"]*)"/.exec(html)?.[1] ?? "",
});

// Password lockouts are per client IP. Local dev servers take cf-connecting-ip from the request,
// so each run uses its own made-up IPs and never locks out the next run. (Cloudflare's edge
// overwrites the header, which is one reason this script is for local servers only.)
const randomIp = (): string =>
  `198.51.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

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

// Webhook receiver standing in for the agents' doorbells: /webhook is the one from settings
// (WEBHOOK_AGENT=grok), /oauth-bell the one set on the approval page.
const rings: { path: string; authorization: string | null; body: z.infer<typeof Ring> }[] = [];
let onRing = (): void => {};
const receiver = Bun.serve({
  hostname: "127.0.0.1",
  port: webhookPort,
  async fetch(request) {
    rings.push({
      path: new URL(request.url).pathname,
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
    "tools/list has the five tools",
    names.join() === "list_agents,list_messages,list_recent,mark_read,post_message",
    names,
  );

  // Addressing and doorbells.
  const missingTo = await callTool(agentToken, "post_message", { text: "hi" });
  check("notes need a recipient", missingTo.isError === true, missingTo);
  const unknown = await callTool(agentToken, "post_message", { to: "nobody-here", text: "hi" });
  check(
    "notes to unknown agents are refused",
    unknown.isError === true && (unknown.content[0]?.text ?? "").includes("no agent named"),
    unknown,
  );

  const rang = nextRing(5_000);
  const posted = await tool(Message, agentToken, "post_message", {
    to: "grok",
    text: "milk is out",
    metadata: { shelf: 2 },
  });
  check(
    "post_message signs with your agent and addresses the note",
    posted.from === "agent" && posted.to === "grok",
    posted,
  );
  check("post_message keeps metadata", posted.metadata?.["shelf"] === 2, posted);
  check("a note to an agent with a doorbell rings it", await rang, rings);
  const ring = rings.at(-1);
  check(
    "the doorbell sends the webhook's bearer key",
    ring?.path === "/webhook" && ring.authorization === `Bearer ${webhookToken}`,
    ring,
  );
  check(
    "the doorbell names the note and its recipient",
    ring?.body.event === "new_message" &&
      ring.body.message_id === posted.id &&
      ring.body.to === "grok",
    ring?.body,
  );

  const quietReply = nextRing(1_500);
  const reply = await tool(Message, grokToken, "post_message", { to: "agent", text: "noted" });
  check("a reply to an agent without a doorbell doesn't ring", !(await quietReply), rings);
  const quietSelf = nextRing(1_500);
  const selfNote = await tool(Message, grokToken, "post_message", { to: "grok", text: "todo" });
  check("a note to yourself doesn't ring", !(await quietSelf), rings);

  // Mailboxes: every agent sees and marks only the notes addressed to it.
  const sinceFirst = { after_id: posted.id - 1 };
  const grokInbox = await tool(z.array(Message), grokToken, "list_messages", sinceFirst);
  check(
    "list_messages returns your unread notes, oldest first",
    grokInbox.map((m) => m.id).join() === `${posted.id},${selfNote.id}`,
    grokInbox,
  );
  const agentInbox = await tool(z.array(Message), agentToken, "list_messages", sinceFirst);
  check(
    "agents don't see each other's notes",
    agentInbox.map((m) => m.id).join() === `${reply.id}`,
    agentInbox,
  );
  const since = await tool(z.array(Message), grokToken, "list_messages", {
    since: selfNote.created_at,
    unread_only: false,
  });
  check(
    "list_messages filters by timestamp",
    since.length > 0 && since.every((m) => m.id >= selfNote.id && m.to === "grok"),
    since,
  );

  const Marked = z.object({ marked: z.number() });
  const stolen = await tool(Marked, agentToken, "mark_read", { ids: [posted.id, selfNote.id] });
  check("agents can't mark each other's notes read", stolen.marked === 0, stolen);
  const marked = await tool(Marked, grokToken, "mark_read", {
    ids: [posted.id, selfNote.id, reply.id],
  });
  check("mark_read marks only your own notes", marked.marked === 2, marked);
  const again = await tool(Marked, grokToken, "mark_read", { ids: [posted.id] });
  check("mark_read is idempotent", again.marked === 0, again);
  const grokAfter = await tool(z.array(Message), grokToken, "list_messages", sinceFirst);
  check("read notes leave your inbox", grokAfter.length === 0, grokAfter);
  const agentAfter = await tool(z.array(Message), agentToken, "list_messages", sinceFirst);
  check(
    "another agent's mark_read leaves your notes unread",
    agentAfter.map((m) => m.id).join() === `${reply.id}`,
    agentAfter,
  );

  const recent = await tool(z.array(Message), agentToken, "list_recent", { limit: 2 });
  check(
    "list_recent shows notes to or from you, newest first",
    recent[0]?.id === reply.id && recent[1]?.id === posted.id,
    recent,
  );
  const agentRecent = await tool(z.array(Message), agentToken, "list_recent", { limit: 100 });
  check(
    "list_recent hides other agents' notes",
    agentRecent.every((m) => m.from === "agent" || m.to === "agent"),
    agentRecent.filter((m) => m.from !== "agent" && m.to !== "agent"),
  );

  const agentsResult = await callTool(agentToken, "list_agents", {});
  const agentsText = agentsResult.content[0]?.text ?? "[]";
  const agents = Agents.parse(parseJson(agentsText));
  check(
    "list_agents shows who has a doorbell",
    agents.find((a) => a.name === "grok")?.has_doorbell === true &&
      agents.find((a) => a.name === "agent")?.has_doorbell === false,
    agents,
  );
  check("list_agents never shows webhooks", !agentsText.includes("http"), agentsText);

  const tooLong = await callTool(agentToken, "post_message", {
    to: "grok",
    text: "x".repeat(8_001),
  });
  check("oversized text is rejected", tooLong.isError === true, tooLong);
  const bigMetadata = await callTool(agentToken, "post_message", {
    to: "grok",
    text: "hi",
    metadata: { blob: "x".repeat(5_000) },
  });
  check("oversized metadata is rejected", bigMetadata.isError === true, bigMetadata);
  const microseconds = await callTool(agentToken, "list_messages", {
    since: "2026-01-01T00:00:00.000001Z",
  });
  check("sub-millisecond since is rejected", microseconds.isError === true, microseconds);

  // OAuth, as an MCP client does it: discover from the 401, register, approve, exchange, refresh.
  const challenge = anonymous.headers.get("www-authenticate") ?? "";
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
  check("401 points at OAuth metadata", metadataUrl !== undefined, challenge);
  const resource = ProtectedResource.parse(await (await fetch(metadataUrl ?? "")).json());
  const issuer = resource.authorization_servers[0] ?? "";
  const endpoints = AuthServer.parse(
    await (await fetch(`${issuer}/.well-known/oauth-authorization-server`)).json(),
  );
  check("metadata names the MCP resource", resource.resource === `${baseUrl}/mcp`, resource);
  check("issuer is the public URL", issuer === new URL(baseUrl).origin, issuer);

  // The same server reached under another name must refuse, not advertise a second issuer.
  const host = new URL(baseUrl).hostname;
  const alias = host === "127.0.0.1" ? "localhost" : host === "localhost" ? "127.0.0.1" : undefined;
  if (alias !== undefined) {
    const aliasUrl = new URL(baseUrl);
    aliasUrl.hostname = alias;
    const misdirected = await fetch(`${aliasUrl.origin}/.well-known/oauth-authorization-server`);
    check("other hostnames get 421", misdirected.status === 421, misdirected.status);
  }

  const redirectUri = `http://127.0.0.1:${webhookPort}/callback`;
  const registered = await fetch(endpoints.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Smoke Test",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  const clientId = z.object({ client_id: z.string() }).parse(await registered.json()).client_id;
  check("dynamic client registration", registered.status === 201, registered.status);

  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const codeChallenge = base64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const state = crypto.randomUUID();
  const authorizeUrl = new URL(endpoints.authorization_endpoint);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    resource: resource.resource,
    scope: "notes",
  })) {
    authorizeUrl.searchParams.set(key, value);
  }
  const openConsent = async () => {
    const response = await fetch(authorizeUrl, { redirect: "manual" });
    return { response, html: await response.text(), cookie: cookiesFrom(response) };
  };
  const ownerIp = randomIp();
  const submitConsent = (
    page: { html: string; cookie: string },
    fields: Record<string, string>,
    ip = ownerIp,
  ): Promise<Response> =>
    fetch(endpoints.authorization_endpoint, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie: page.cookie,
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": ip,
      },
      body: new URLSearchParams({
        handle: consentForm(page.html).handle,
        scope: "notes",
        ...fields,
      }),
    });

  const consent = await openConsent();
  // What a hostile site can make the owner's browser send: no handle cookie, a made-up handle.
  const crossSite = await Promise.all(
    Array.from({ length: 11 }, () =>
      submitConsent(
        { html: 'name="handle" value="forged"', cookie: "" },
        { agent: "evil", password: "not-the-password", decision: "approve" },
      ).then((response) => response.status),
    ),
  );
  if (consent.response.status === 501) {
    console.log(
      "- OAuth approval isn't available on this runtime; skipped the rest of the OAuth checks",
    );
  } else {
    check(
      "approval page names the app and suggests an agent name",
      consent.response.status === 200 &&
        consent.html.includes("Smoke Test") &&
        consentForm(consent.html).agent === "smoke-test",
      consent.response.status,
    );
    check(
      "approval page lists the existing agents",
      consent.html.includes("Existing agents") && consent.html.includes("<strong>grok</strong>"),
      consent.html.length,
    );

    check(
      "forged approvals don't count toward the password lockout",
      crossSite.every((status) => status === 400),
      crossSite,
    );

    const oauthBell = `http://127.0.0.1:${webhookPort}/oauth-bell`;
    const badWebhook = await submitConsent(consent, {
      agent: "smoke-oauth",
      password: ownerPassword,
      webhook_url: "http://example.com/hook",
      decision: "approve",
    });
    const badWebhookPage = { html: await badWebhook.text(), cookie: cookiesFrom(badWebhook) };
    check(
      "a webhook that isn't https is refused",
      badWebhook.status === 400 && badWebhookPage.html.includes("must start with https://"),
      badWebhook.status,
    );

    const wrongPassword = await submitConsent(badWebhookPage, {
      agent: "smoke-oauth",
      password: "not-the-password",
      webhook_url: oauthBell,
      webhook_key: "oauth-bell-key",
      decision: "approve",
    });
    const retryPage = { html: await wrongPassword.text(), cookie: cookiesFrom(wrongPassword) };
    check(
      "wrong password shows the form again, keeping the name and webhook but not the key",
      wrongPassword.status === 400 &&
        retryPage.html.includes("Wrong password") &&
        consentForm(retryPage.html).agent === "smoke-oauth" &&
        consentForm(retryPage.html).webhookUrl === oauthBell &&
        !retryPage.html.includes("oauth-bell-key"),
      wrongPassword.status,
    );

    const approved = await submitConsent(retryPage, {
      agent: "smoke-oauth",
      password: ownerPassword,
      webhook_url: oauthBell,
      webhook_key: "oauth-bell-key",
      decision: "approve",
    });
    const callback = new URL(approved.headers.get("location") ?? "about:blank");
    const code = callback.searchParams.get("code") ?? "";
    check(
      "right password redirects back with a code",
      approved.status === 302 &&
        callback.href.startsWith(redirectUri) &&
        code !== "" &&
        callback.searchParams.get("state") === state,
      { status: approved.status, location: approved.headers.get("location") },
    );

    const exchange = await fetch(endpoints.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
        resource: resource.resource,
      }),
    });
    const tokens = Tokens.safeParse(await exchange.json());
    check("code exchanges for tokens", exchange.status === 200 && tokens.success, exchange.status);
    const accessToken = tokens.data?.access_token ?? "";

    const viaOAuth = await tool(Message, accessToken, "post_message", {
      to: "agent",
      text: "hello over OAuth",
    });
    check("OAuth token posts as the approved agent", viaOAuth.from === "smoke-oauth", viaOAuth);

    const refreshed = await fetch(endpoints.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.data?.refresh_token ?? "",
        client_id: clientId,
        resource: resource.resource,
      }),
    });
    const renewed = Tokens.safeParse(await refreshed.json());
    const afterRefresh = await callTool(renewed.data?.access_token ?? "", "list_recent", {
      limit: 1,
    });
    check(
      "refreshed token works",
      refreshed.status === 200 && afterRefresh.isError !== true,
      refreshed.status,
    );

    /** Posts a note from `agent` to smoke-oauth and reports whether its doorbell rang. */
    const ringsSmokeOauth = async (): Promise<boolean> => {
      const rung = nextRing(2_000);
      await tool(Message, agentToken, "post_message", { to: "smoke-oauth", text: "ping" });
      return (await rung) && rings.at(-1)?.path === "/oauth-bell";
    };
    check("a doorbell set on the approval page rings", await ringsSmokeOauth(), rings.at(-1));
    check(
      "it sends the key from the approval page",
      rings.at(-1)?.authorization === "Bearer oauth-bell-key",
      rings.at(-1),
    );

    /** Approves the same app again with `fields`. This replaces its approval, and the tokens above. */
    const reapprove = async (fields: Record<string, string>): Promise<number> => {
      const page = await openConsent();
      const response = await submitConsent(page, {
        agent: "smoke-oauth",
        password: ownerPassword,
        decision: "approve",
        ...fields,
      });
      return response.status;
    };
    const keptStatus = await reapprove({});
    check(
      "approving again without a webhook keeps the doorbell",
      keptStatus === 302 && (await ringsSmokeOauth()),
      keptStatus,
    );
    const removedStatus = await reapprove({ webhook_remove: "1" });
    check(
      "the remove box takes the doorbell away",
      removedStatus === 302 && !(await ringsSmokeOauth()),
      removedStatus,
    );

    // 15 wrong passwords at once from one IP: exactly 10 may be checked, the rest are locked out.
    const burstIp = randomIp();
    const burstPages = await Promise.all(Array.from({ length: 15 }, () => openConsent()));
    const burst = await Promise.all(
      burstPages.map((page) =>
        submitConsent(
          page,
          { agent: "guesser", password: "not-the-password", decision: "approve" },
          burstIp,
        ).then((response) => response.status),
      ),
    );
    check(
      "a burst of guesses can't pass the lockout",
      burst.filter((status) => status === 400).length === 10 &&
        burst.filter((status) => status === 429).length === 5,
      burst,
    );

    const denyPage = await openConsent();
    const denied = await submitConsent(denyPage, { decision: "deny" });
    const deniedTo = new URL(denied.headers.get("location") ?? "about:blank");
    check(
      "deny sends access_denied back to the app",
      denied.status === 302 && deniedTo.searchParams.get("error") === "access_denied",
      denied.headers.get("location"),
    );
  }
} finally {
  await receiver.stop(true);
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
