import type { ReadonlyMode } from "../config.ts";

/**
 * Returns a 403 Response when the request would mutate vault state in a way
 * that's disallowed by the current ReadonlyMode. Returns null when the
 * request should proceed.
 *
 * Matrix:
 *
 *   off        — never blocks. Default; mutations allowed.
 *
 *   strict     — every non-GET/HEAD/OPTIONS request returns 403. The
 *                vault is treated as a frozen read source. Used when
 *                pointing at production data you DO NOT trust the
 *                parser to handle without risk.
 *
 *   agent-only — agent may write its OWN fields (agent_suggests +
 *                agent_dismissed_at via POST /api/agent/groom and
 *                POST /api/suggestions/:id/dismiss). Anything that
 *                would touch real frontmatter (status, priority, order,
 *                etc.) is rejected: PATCH /api/tasks/:id, approve,
 *                approve-all. Used when pointing at a real vault and
 *                you want to SEE the agent's reasoning without
 *                anything landing.
 */
export function checkReadonly(mode: ReadonlyMode, req: Request): Response | null {
  if (mode === "off") return null;

  const method = req.method;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;

  const path = new URL(req.url).pathname;

  if (mode === "strict") {
    return blocked(mode, method, path, "all mutations are blocked");
  }

  // agent-only — allow groom + dismiss (both touch only agent_* fields).
  if (method === "POST" && path === "/api/agent/groom") return null;
  if (method === "POST" && /^\/api\/suggestions\/[^/]+\/dismiss$/.test(path)) return null;

  return blocked(
    mode,
    method,
    path,
    "this endpoint would touch real frontmatter fields; only agent_suggests/agent_dismissed_at writes are allowed",
  );
}

function blocked(mode: ReadonlyMode, method: string, path: string, reason: string): Response {
  return Response.json(
    { error: `VAULT_READONLY=${mode}: ${method} ${path} blocked`, reason },
    { status: 403 },
  );
}
