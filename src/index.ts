import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "@modelcontextprotocol/server";
import * as z from "zod";
import { agentForToken, fixedAgents } from "./auth.ts";
import type { Board, Doorbell, Ring } from "./board.ts";
import { GRANT_IDLE_DAYS, SCOPES, handleAuthorize } from "./consent.ts";
import { ringDoorbell } from "./doorbell.ts";
import { createServer } from "./tools.ts";

export { Board } from "./board.ts";

export interface Env {
  BOARD: DurableObjectNamespace<Board>;
  OAUTH_KV: KVNamespace;
  /** Injected by OAuthProvider for the non-API routes. */
  OAUTH_PROVIDER: OAuthHelpers;
  PUBLIC_URL?: string;
  OWNER_PASSWORD?: string;
  AUTH_TOKENS?: string;
  /**
   * A doorbell from settings, for setups without the approval page (celld, until it can run
   * OAuth): notes to WEBHOOK_AGENT ring WEBHOOK_URL. A doorbell set on the approval page wins.
   */
  WEBHOOK_AGENT?: string;
  WEBHOOK_URL?: string;
  WEBHOOK_TOKEN?: string;
}

const MAX_REQUEST_BYTES = 64 * 1024;

/** What every accepted token carries, OAuth or static: the agent name that becomes `from`. */
const GrantProps = z.object({ agent: z.string() });

/** Turns the Board's decision into a webhook: the Board never sees the settings' URL or key. */
const doorbellFor = (env: Env, ring: Ring): Doorbell | null =>
  ring === "settings" ? { url: env.WEBHOOK_URL ?? "", token: env.WEBHOOK_TOKEN || null } : ring;

let warnedAboutWebhookAgent = false;
/** WEBHOOK_URL without WEBHOOK_AGENT rings nobody: say so once instead of failing silently. */
const warnAboutSettings = (env: Env): void => {
  if (warnedAboutWebhookAgent || !env.WEBHOOK_URL || env.WEBHOOK_AGENT) return;
  warnedAboutWebhookAgent = true;
  console.warn(
    "WEBHOOK_URL is set but WEBHOOK_AGENT isn't, so it rings for nobody. Set WEBHOOK_AGENT to the agent it wakes, or set that agent's doorbell on the approval page.",
  );
};

const mcp = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { agent } = GrantProps.parse(ctx.props);
    warnAboutSettings(env);
    const board = env.BOARD.getByName("main");
    const handler = createMcpHandler(
      () =>
        createServer({
          agent,
          board,
          fixed: fixedAgents(env),
          onPost: (message, ring) => {
            const doorbell = doorbellFor(env, ring);
            // waitUntil keeps the webhook call alive after the response without delaying it.
            if (doorbell !== null) ctx.waitUntil(ringDoorbell(doorbell, message));
          },
        }),
      { maxRequestBodySize: MAX_REQUEST_BYTES },
    );
    return handler.fetch(request);
  },
};

const site = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") return Response.json({ ok: true });
    if (pathname === "/authorize") return handleAuthorize(request, env);
    return Response.json({ error: "not found" }, { status: 404 });
  },
};

const providers = new Map<string, OAuthProvider<Env>>();

/** The provider needs the public origin up front. It is fixed per deployment, so build it once. */
const providerFor = (origin: string): OAuthProvider<Env> => {
  const existing = providers.get(origin);
  if (existing !== undefined) return existing;
  const resource = `${origin}/mcp`;
  const provider = new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: mcp,
    defaultHandler: site,
    // Absolute URLs pin the issuer to PUBLIC_URL; relative ones follow each request's host.
    authorizeEndpoint: `${origin}/authorize`,
    tokenEndpoint: `${origin}/oauth/token`,
    clientRegistrationEndpoint: `${origin}/oauth/register`,
    // Turns itself off where the runtime doesn't enforce global_fetch_strictly_public (celld).
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: SCOPES,
    requiredScopes: ["notes"],
    // A new grant lasts refreshTokenTTL; each refresh then extends it by refreshTokenIdleTTL.
    refreshTokenTTL: GRANT_IDLE_DAYS * 24 * 60 * 60,
    refreshTokenIdleTTL: GRANT_IDLE_DAYS * 24 * 60 * 60,
    resourceMetadata: { resource, authorization_servers: [origin], resource_name: "fridge-notes" },
    // AUTH_TOKENS keep working next to OAuth, for clients that can only send a fixed header.
    resolveExternalToken: async ({ token, env }) => {
      const agent = await agentForToken(token, env.AUTH_TOKENS);
      return agent === undefined ? null : { props: { agent }, audience: resource };
    },
  });
  providers.set(origin, provider);
  return provider;
};

const publicOrigin = (value: string | undefined): string | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
};

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const origin = publicOrigin(env.PUBLIC_URL);
    if (origin === undefined) {
      console.error(
        "PUBLIC_URL must be this server's public URL, e.g. https://fridge-notes.<you>.workers.dev",
      );
      return Response.json({ error: "server misconfigured" }, { status: 500 });
    }
    // OAuth metadata and tokens name one origin, so answer only there. /health stays open for
    // probes that reach the server directly.
    const url = new URL(request.url);
    if (url.origin !== origin && url.pathname !== "/health") {
      return Response.json({ error: `this server is ${origin}` }, { status: 421 });
    }
    return providerFor(origin).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
