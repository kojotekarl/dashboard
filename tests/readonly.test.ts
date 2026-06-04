import { describe, expect, test } from "bun:test";
import { checkReadonly } from "../server/middleware/readonly.ts";

function req(method: string, path: string): Request {
  return new Request(`http://127.0.0.1:3000${path}`, { method });
}

describe("checkReadonly — off mode", () => {
  test("never blocks", () => {
    expect(checkReadonly("off", req("GET", "/api/tasks"))).toBeNull();
    expect(checkReadonly("off", req("POST", "/api/agent/groom"))).toBeNull();
    expect(checkReadonly("off", req("PATCH", "/api/tasks/t-x"))).toBeNull();
    expect(checkReadonly("off", req("POST", "/api/suggestions/t-x/approve"))).toBeNull();
    expect(checkReadonly("off", req("POST", "/api/suggestions/approve-all"))).toBeNull();
  });
});

describe("checkReadonly — strict mode", () => {
  test("GET / HEAD / OPTIONS always pass", () => {
    expect(checkReadonly("strict", req("GET", "/api/tasks"))).toBeNull();
    expect(checkReadonly("strict", req("HEAD", "/api/tasks"))).toBeNull();
    expect(checkReadonly("strict", req("OPTIONS", "/api/tasks"))).toBeNull();
  });

  test("every mutating method returns 403", async () => {
    for (const m of ["POST", "PATCH", "PUT", "DELETE"] as const) {
      const r = checkReadonly("strict", req(m, "/api/agent/groom"));
      expect(r).not.toBeNull();
      expect(r!.status).toBe(403);
      const body = (await r!.json()) as { error: string; reason: string };
      expect(body.error).toMatch(/VAULT_READONLY=strict/);
    }
  });
});

describe("checkReadonly — agent-only mode", () => {
  test("GET passes", () => {
    expect(checkReadonly("agent-only", req("GET", "/api/tasks"))).toBeNull();
  });

  test("POST /api/agent/groom is allowed (writes only agent_suggests)", () => {
    expect(checkReadonly("agent-only", req("POST", "/api/agent/groom"))).toBeNull();
  });

  test("POST /api/suggestions/:id/dismiss is allowed (touches only agent_* fields)", () => {
    expect(
      checkReadonly("agent-only", req("POST", "/api/suggestions/t-foo/dismiss")),
    ).toBeNull();
    expect(
      checkReadonly("agent-only", req("POST", "/api/suggestions/t-foo%2Dx/dismiss")),
    ).toBeNull();
  });

  test("POST /api/suggestions/:id/approve is blocked (touches real fields)", async () => {
    const r = checkReadonly("agent-only", req("POST", "/api/suggestions/t-foo/approve"));
    expect(r!.status).toBe(403);
    const body = (await r!.json()) as { error: string; reason: string };
    expect(body.reason).toMatch(/real frontmatter/);
  });

  test("POST /api/suggestions/approve-all is blocked", () => {
    const r = checkReadonly("agent-only", req("POST", "/api/suggestions/approve-all"));
    expect(r!.status).toBe(403);
  });

  test("PATCH /api/tasks/:id is blocked (arbitrary patch body)", () => {
    const r = checkReadonly("agent-only", req("PATCH", "/api/tasks/t-x"));
    expect(r!.status).toBe(403);
  });

  test("DELETE on anything is blocked", () => {
    const r = checkReadonly("agent-only", req("DELETE", "/api/tasks/t-x"));
    expect(r!.status).toBe(403);
  });
});
