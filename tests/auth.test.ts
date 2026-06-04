import { describe, expect, test } from "bun:test";
import { buildAuthContext, checkHttpAuth, checkWsAuth, TOKEN_HEADER } from "../server/middleware/auth.ts";

const TOKEN = "s3cret";
const HOST = "127.0.0.1:3000";

const ctxWith = buildAuthContext(TOKEN, "127.0.0.1", 3000);
const ctxNoAuth = buildAuthContext(undefined, "127.0.0.1", 3000);

function req(
  method: string,
  init: { headers?: Record<string, string>; url?: string } = {},
): Request {
  return new Request(init.url ?? "http://127.0.0.1:3000/api/tasks", {
    method,
    headers: init.headers ?? {},
  });
}

describe("checkHttpAuth — no token configured", () => {
  test("allows any method without checks (dev / localhost mode)", () => {
    expect(checkHttpAuth(ctxNoAuth, req("GET"))).toBeNull();
    expect(checkHttpAuth(ctxNoAuth, req("POST"))).toBeNull();
    expect(checkHttpAuth(ctxNoAuth, req("PATCH"))).toBeNull();
    expect(checkHttpAuth(ctxNoAuth, req("DELETE"))).toBeNull();
  });
});

describe("checkHttpAuth — token configured", () => {
  test("GET is open even when a token is required", () => {
    expect(checkHttpAuth(ctxWith, req("GET"))).toBeNull();
  });

  test("POST without token header → 401", async () => {
    const res = checkHttpAuth(ctxWith, req("POST", { headers: { "sec-fetch-site": "same-origin" } }));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    const body = await res!.json() as { error: string };
    expect(body.error).toMatch(/missing or invalid/);
  });

  test("POST with WRONG token → 401", async () => {
    const res = checkHttpAuth(
      ctxWith,
      req("POST", { headers: { [TOKEN_HEADER]: "wrong", "sec-fetch-site": "same-origin" } }),
    );
    expect(res!.status).toBe(401);
  });

  test("POST with correct token AND same-origin → null (allowed)", () => {
    const res = checkHttpAuth(
      ctxWith,
      req("POST", { headers: { [TOKEN_HEADER]: TOKEN, "sec-fetch-site": "same-origin" } }),
    );
    expect(res).toBeNull();
  });

  test("PATCH same as POST — token required, same-origin required", async () => {
    const ok = checkHttpAuth(
      ctxWith,
      req("PATCH", { headers: { [TOKEN_HEADER]: TOKEN, "sec-fetch-site": "same-origin" } }),
    );
    expect(ok).toBeNull();
    // No browser headers + no token → token check fires (401).
    const missing = checkHttpAuth(ctxWith, req("PATCH"));
    expect(missing!.status).toBe(401);
    // Browser headers present and cross-site + correct token → CSRF check fires (403).
    const csrf = checkHttpAuth(
      ctxWith,
      req("PATCH", { headers: { [TOKEN_HEADER]: TOKEN, "sec-fetch-site": "cross-site" } }),
    );
    expect(csrf!.status).toBe(403);
  });
});

describe("checkHttpAuth — CSRF / same-origin", () => {
  test("Sec-Fetch-Site: cross-site is rejected even with the right token", async () => {
    const res = checkHttpAuth(
      ctxWith,
      req("POST", { headers: { [TOKEN_HEADER]: TOKEN, "sec-fetch-site": "cross-site" } }),
    );
    expect(res!.status).toBe(403);
    const body = await res!.json() as { error: string };
    expect(body.error).toMatch(/cross-origin/);
  });

  test("Sec-Fetch-Site: same-site is allowed", () => {
    const res = checkHttpAuth(
      ctxWith,
      req("POST", { headers: { [TOKEN_HEADER]: TOKEN, "sec-fetch-site": "same-site" } }),
    );
    expect(res).toBeNull();
  });

  test("Sec-Fetch-Site: none is allowed (browser-initiated navigation)", () => {
    const res = checkHttpAuth(
      ctxWith,
      req("POST", { headers: { [TOKEN_HEADER]: TOKEN, "sec-fetch-site": "none" } }),
    );
    expect(res).toBeNull();
  });

  test("Origin fallback: matching origin → allowed", () => {
    const res = checkHttpAuth(
      ctxWith,
      req("POST", { headers: { [TOKEN_HEADER]: TOKEN, origin: `http://${HOST}` } }),
    );
    expect(res).toBeNull();
  });

  test("Origin fallback: mismatched origin → 403", async () => {
    const res = checkHttpAuth(
      ctxWith,
      req("POST", { headers: { [TOKEN_HEADER]: TOKEN, origin: "http://evil.test:3000" } }),
    );
    expect(res!.status).toBe(403);
  });

  test("Origin fallback: malformed Origin → 403", async () => {
    const res = checkHttpAuth(
      ctxWith,
      req("POST", { headers: { [TOKEN_HEADER]: TOKEN, origin: "not-a-url" } }),
    );
    expect(res!.status).toBe(403);
  });

  test("Neither header → allowed (non-browser client; token still required)", () => {
    const ok = checkHttpAuth(ctxWith, req("POST", { headers: { [TOKEN_HEADER]: TOKEN } }));
    expect(ok).toBeNull();
    const noToken = checkHttpAuth(ctxWith, req("POST"));
    expect(noToken!.status).toBe(401);
  });
});

describe("checkWsAuth", () => {
  test("no token configured → always allowed", () => {
    expect(checkWsAuth(ctxNoAuth, req("GET", { url: "http://127.0.0.1:3000/api/ws" }))).toBe(true);
  });

  test("token configured + matching ?token=… → allowed", () => {
    expect(
      checkWsAuth(ctxWith, req("GET", { url: `http://127.0.0.1:3000/api/ws?token=${TOKEN}` })),
    ).toBe(true);
  });

  test("token configured + missing ?token → rejected", () => {
    expect(checkWsAuth(ctxWith, req("GET", { url: "http://127.0.0.1:3000/api/ws" }))).toBe(false);
  });

  test("token configured + wrong ?token → rejected", () => {
    expect(
      checkWsAuth(ctxWith, req("GET", { url: "http://127.0.0.1:3000/api/ws?token=wrong" })),
    ).toBe(false);
  });
});
