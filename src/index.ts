import { createMcpHandler } from "@modelcontextprotocol/server";
import { authenticate } from "./auth.ts";
import type { Board } from "./board.ts";
import { ringDoorbell } from "./doorbell.ts";
import { createServer } from "./tools.ts";

export { Board } from "./board.ts";

export interface Env {
  BOARD: DurableObjectNamespace<Board>;
  AUTH_TOKENS?: string;
  WEBHOOK_URL?: string;
  WEBHOOK_TOKEN?: string;
}

const MAX_REQUEST_BYTES = 64 * 1024;

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") return Response.json({ ok: true });
    if (pathname !== "/mcp") return Response.json({ error: "not found" }, { status: 404 });

    let agent: string | undefined;
    try {
      agent = await authenticate(request, env.AUTH_TOKENS);
    } catch (error) {
      console.error("auth:", error);
      return Response.json({ error: "server misconfigured" }, { status: 500 });
    }
    if (agent === undefined) {
      return Response.json(
        { error: "unauthorized" },
        { status: 401, headers: { "www-authenticate": 'Bearer realm="fridge-notes"' } },
      );
    }

    const board = env.BOARD.getByName("main");
    const mcp = createMcpHandler(
      () =>
        createServer({
          agent,
          board,
          // waitUntil keeps the webhook call alive after the response without delaying it.
          onPost: (message) => ctx.waitUntil(ringDoorbell(env, message)),
        }),
      { maxRequestBodySize: MAX_REQUEST_BYTES },
    );
    return mcp.fetch(request);
  },
} satisfies ExportedHandler<Env>;
