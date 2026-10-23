import {
  AuthorizationError,
  CimdFetchError,
  type AuthRequest,
  type ConsentDescription,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { AGENT_NAME, ownerPasswordConfigured, passwordMatches } from "./auth.ts";
import type { Env } from "./index.ts";

/** Everything this server can grant. `notes` is the only real permission: full board access. */
export const SCOPES = ["notes", "offline_access"];
/** An approved agent stays connected until it goes this long without using fridge-notes. */
export const GRANT_IDLE_DAYS = 90;

const PAGE_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
};

// Client name, domain and scopes come from the client itself, so all of it gets escaped.
const escape = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const page = (title: string, body: string): string => `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · fridge-notes</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; display: grid; place-items: center; min-height: 100vh; background: #f6f6f4; color: #1c1c1a; }
  main { width: min(26rem, calc(100% - 2rem)); padding: 2rem; background: #fff; border-radius: 14px; box-shadow: 0 1px 3px #0002; }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; }
  p { margin: 0 0 0.75rem; }
  .muted { color: #5c5c58; font-size: 0.9rem; }
  .warn, .error { padding: 0.6rem 0.8rem; border-radius: 8px; font-size: 0.9rem; }
  .warn { background: #fff4d6; }
  .error { background: #fde4e4; color: #8a1c1c; }
  label { display: block; margin: 1rem 0 0; font-weight: 600; font-size: 0.9rem; }
  label small { display: block; font-weight: 400; color: #5c5c58; }
  input:not([type=hidden]) { box-sizing: border-box; width: 100%; margin-top: 0.3rem; padding: 0.55rem 0.7rem; font: inherit; border: 1px solid #c8c8c2; border-radius: 8px; }
  .actions { display: flex; gap: 0.75rem; margin-top: 1.5rem; }
  button { flex: 1; padding: 0.6rem; font: inherit; font-weight: 600; border-radius: 8px; border: 1px solid #c8c8c2; background: #fff; cursor: pointer; }
  button.primary { background: #dc2626; border-color: #dc2626; color: #fff; }
</style>
<main>${body}</main>
</html>`;

const notice = (status: number, title: string, text: string): Response =>
  new Response(page(title, `<h1>${escape(title)}</h1><p>${escape(text)}</p>`), {
    status,
    headers: PAGE_HEADERS,
  });

// The OAuth library protects grants with AES-KW, which celld 0.6.3's WebCrypto doesn't have yet.
let aesKwSupport: Promise<boolean> | undefined;
const oauthSupported = (): Promise<boolean> =>
  (aesKwSupport ??= crypto.subtle
    .importKey("raw", new Uint8Array(32), "AES-KW", false, ["wrapKey"])
    .then(
      () => true,
      () => false,
    ));

/** "Claude Code" → "claude-code": a valid agent name to start from. */
const suggestAgentName = (clientName: string): string =>
  clientName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "agent";

interface FormState {
  handle: string;
  agent: string;
  error?: string | undefined;
}

const consentPage = (details: ConsentDescription, form: FormState): string => {
  const name = escape(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : "This app registered itself, so its name isn't verified.";
  const scopes = details.scope
    .filter((scope) => SCOPES.includes(scope))
    .map((scope) => `<input type="hidden" name="scope" value="${escape(scope)}">`)
    .join("");
  return page(
    `Connect ${details.clientName}`,
    `<h1>Connect ${name} to fridge-notes?</h1>
<p class="muted">${origin} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
<p>It will be able to read every note on the board, post notes (which wake Grok Bot), and mark
notes read. It stays connected until it goes ${GRANT_IDLE_DAYS} days without using fridge-notes.</p>
${details.redirectIsLoopback ? '<p class="warn">This sends access to an app on a computer, not a website. Continue only if you just started connecting from it.</p>' : ""}
${form.error === undefined ? "" : `<p class="error">${escape(form.error)}</p>`}
<form method="post">
  <!-- The form's first submit button is what Enter presses. Disabled, so Enter can't approve. -->
  <button type="submit" disabled hidden aria-hidden="true" tabindex="-1"></button>
  <input type="hidden" name="handle" value="${escape(form.handle)}">
  ${scopes}
  <label>Agent name
    <small>Shown as "from" on its messages. Name Grok Bot "grok".</small>
    <input name="agent" value="${escape(form.agent)}" maxlength="32" required autocomplete="off">
  </label>
  <label>Owner password
    <input type="password" name="password" required autocomplete="current-password" autofocus>
  </label>
  <div class="actions">
    <button class="primary" name="decision" value="approve">Allow</button>
    <button name="decision" value="deny" formnovalidate>Deny</button>
  </div>
</form>`,
  );
};

/**
 * Renders the form for `authRequest` with a fresh single-use handle. `carry` holds headers a
 * previous step must still send, such as the cookie update from a used-up handle.
 */
const showConsent = async (
  oauth: OAuthHelpers,
  authRequest: AuthRequest,
  form: { agent?: string; error?: string },
  status = 200,
  carry?: Headers,
): Promise<Response> => {
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  for (const cookie of carry?.getSetCookie() ?? []) consent.headers.append("set-cookie", cookie);
  for (const [name, value] of Object.entries(PAGE_HEADERS)) {
    if (!consent.headers.has(name)) consent.headers.set(name, value);
  }
  const state = {
    handle: consent.handle,
    agent: form.agent ?? suggestAgentName(details.clientName),
    error: form.error,
  };
  return new Response(consentPage(details, state), { status, headers: consent.headers });
};

const submitConsent = async (request: Request, env: Env): Promise<Response> => {
  const oauth = env.OAUTH_PROVIDER;
  const form = await request.formData();
  const field = (name: string): string => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  const handle = field("handle");

  if (field("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  if (!ownerPasswordConfigured(env.OWNER_PASSWORD)) {
    return notice(500, "Not set up yet", "Set OWNER_PASSWORD (16+ characters) to approve apps.");
  }

  // First, check that this form came from a page this browser opened, and use its handle up. A
  // cross-site POST fails here, before it can count against the owner's password attempts.
  const requested = form
    .getAll("scope")
    .filter((s): s is string => typeof s === "string" && SCOPES.includes(s));
  const approved = await oauth.approveConsent(request, handle, {
    scope: [...new Set(["notes", ...requested])],
  });
  const agent = field("agent").trim();
  const retry = (error: string) =>
    showConsent(oauth, approved.request, { agent, error }, 400, approved.headers);
  if (!AGENT_NAME.test(agent)) return retry("Agent name: use 1 to 32 letters, digits, _ or -.");

  const board = env.BOARD.getByName("main");
  const client = request.headers.get("cf-connecting-ip") ?? "unknown";
  const attempt = await board.beginLoginAttempt(client);
  if (attempt === undefined) {
    return notice(
      429,
      "Too many wrong passwords",
      "Wait 15 minutes, then connect again from your app.",
    );
  }
  if (!(await passwordMatches(field("password"), env.OWNER_PASSWORD))) {
    return retry("Wrong password.");
  }
  await board.forgiveLoginAttempt(client, attempt);

  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request,
    userId: "owner",
    metadata: { agent },
    scope: approved.request.scope,
    props: { agent },
  });
  approved.headers.set("location", redirectTo);
  return new Response(null, { status: 302, headers: approved.headers });
};

/**
 * The owner-approval page at /authorize. GET shows which app is asking and where its tokens go;
 * POST approves with the owner password and an agent name, which becomes `from` on its messages.
 */
export const handleAuthorize = async (request: Request, env: Env): Promise<Response> => {
  if (!(await oauthSupported())) {
    return notice(
      501,
      "OAuth isn't available here",
      "This server's runtime can't run OAuth yet: its WebCrypto has no AES-KW. Connect with a token from AUTH_TOKENS instead.",
    );
  }
  try {
    if (request.method === "GET") {
      const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      return await showConsent(env.OAUTH_PROVIDER, authRequest, {});
    }
    if (request.method === "POST") return await submitConsent(request, env);
    return notice(405, "Not allowed", "Use GET or POST.");
  } catch (error) {
    // Redirect back to the client only when the library has validated where that goes.
    if (error instanceof AuthorizationError && error.redirectTo !== undefined) {
      return Response.redirect(error.redirectTo, 302);
    }
    if (error instanceof AuthorizationError) {
      return notice(400, "Can't continue", `${error.description} Start again from your app.`);
    }
    if (error instanceof CimdFetchError) {
      return notice(400, "Can't continue", "This app could not be verified.");
    }
    console.error("authorize:", error);
    throw error;
  }
};
