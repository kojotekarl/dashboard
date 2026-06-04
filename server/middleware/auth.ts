/**
 * Auth + CSRF defense for the dashboard HTTP and WebSocket surfaces.
 *
 * Decided in /plan-eng-review (codex C2 + C3):
 *
 * - The server refuses to bind a non-loopback host without DASHBOARD_TOKEN
 *   set (enforced in config.ts at startup). That guard is the FIRST line.
 *
 * - Once a token is configured, mutating HTTP methods (POST/PATCH/DELETE/PUT)
 *   require a matching `X-Dashboard-Token` header. GET stays open so the
 *   dashboard renders for anyone who can reach it.
 *
 * - CSRF defense layers on TOP of the token. A custom header forces a
 *   preflight, so a malicious page can't fire `<form method=post>` blindly
 *   at the API. We additionally check `Sec-Fetch-Site` (modern browsers)
 *   with an `Origin`-vs-`Host` fallback for older clients. Either check
 *   failing on a mutating request returns 403.
 *
 * - WebSockets don't carry custom headers from the browser API, so the
 *   token rides as a `?token=…` query param on the upgrade request. The
 *   socket carries no client-originated mutations in v1; this is mostly
 *   to keep file-change broadcasts from leaking to anyone on the LAN.
 */

export const TOKEN_HEADER = "x-dashboard-token";
const MUTATING_METHODS: ReadonlySet<string> = new Set(["POST", "PATCH", "PUT", "DELETE"]);

export type AuthContext = {
  /** When undefined, auth is off (localhost-only deploys). */
  requiredToken: string | undefined;
  /** Server's bound `host:port`, used for the Origin fallback check. */
  serverOrigin: string;
};

export function buildAuthContext(token: string | undefined, bindHost: string, port: number): AuthContext {
  return {
    requiredToken: token,
    // Strip port for loopback-vs-host matching; we compare host:port below.
    serverOrigin: `${bindHost}:${port}`,
  };
}

/**
 * Verify an incoming HTTP request. Returns a 401/403 Response when the
 * caller must reject the request; returns `null` when routing should
 * continue.
 *
 * Order matters:
 *   1. CSRF same-origin check first — rejecting at the network surface
 *      avoids leaking "is the token wrong, or is the origin wrong?" via
 *      timing differences.
 *   2. Token check second, only on mutating methods.
 */
export function checkHttpAuth(ctx: AuthContext, req: Request): Response | null {
  if (ctx.requiredToken === undefined) return null; // auth disabled

  if (MUTATING_METHODS.has(req.method)) {
    if (!isSameOrigin(ctx, req)) {
      return Response.json({ error: "cross-origin request rejected" }, { status: 403 });
    }
    const provided = req.headers.get(TOKEN_HEADER);
    if (provided === null || provided !== ctx.requiredToken) {
      return Response.json({ error: "missing or invalid X-Dashboard-Token" }, { status: 401 });
    }
  }

  return null;
}

/**
 * Browser-driven same-origin check. Prefers `Sec-Fetch-Site` (Chrome/Firefox/
 * Safari modern), falls back to `Origin` vs `Host` for older clients.
 *
 *   Sec-Fetch-Site present:
 *     same-origin / same-site / none -> allowed
 *     cross-site                     -> rejected
 *
 *   Sec-Fetch-Site missing, Origin present:
 *     allowed iff origin's host == server's host:port
 *
 *   Both absent: allowed (likely a non-browser client; the token check
 *   below still applies). Production CSRF only matters when a browser
 *   is involved, and browsers always send at least Origin on writes.
 */
function isSameOrigin(ctx: AuthContext, req: Request): boolean {
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite !== null) {
    return fetchSite === "same-origin" || fetchSite === "same-site" || fetchSite === "none";
  }

  const origin = req.headers.get("origin");
  if (origin === null) return true; // no signal — let the token check decide

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false; // malformed Origin = treat as cross
  }

  return originHost === ctx.serverOrigin;
}

/**
 * WebSocket upgrade auth — the browser API can't set custom headers, so the
 * client passes the token as `?token=…` on the upgrade URL. Returns true if
 * the request may upgrade.
 */
export function checkWsAuth(ctx: AuthContext, req: Request): boolean {
  if (ctx.requiredToken === undefined) return true;
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  return token !== null && token === ctx.requiredToken;
}
