import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAgent } from "../server/agent/MockAgent.ts";
import type { AgentProvider, GroomInput, GroomResult, Suggestion } from "../server/agent/AgentProvider.ts";
import { handleGroom } from "../server/api/agent.ts";
import {
  handleApprove,
  handleApproveAll,
  handleDismiss,
  matchSuggestionAction,
} from "../server/api/suggestions.ts";
import { MarkdownRepository } from "../server/repo/MarkdownRepository.ts";

let vault: string;
let repo: MarkdownRepository;
const NOW = new Date("2026-06-04T10:00:00Z");

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), "pepper-t7-"));
  await mkdir(join(vault, "tasks"));
  await mkdir(join(vault, "goals"));
  await mkdir(join(vault, "routines"));
  repo = new MarkdownRepository(vault);
});

afterEach(async () => {
  await rm(vault, { recursive: true, force: true });
});

async function seed(rel: string, fm: Record<string, unknown>, body = "x"): Promise<void> {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  await writeFile(join(vault, rel), `---\n${lines.join("\n")}\n---\n${body}\n`, "utf8");
}

/** Agent that returns a fixed set of suggestions — used to test handlers in isolation. */
function scriptedAgent(make: (input: GroomInput) => Suggestion[]): AgentProvider {
  return {
    name: "mock",
    async groom(input: GroomInput): Promise<GroomResult> {
      return { suggestions: make(input), summary: "scripted" };
    },
  };
}

describe("handleGroom", () => {
  test("writes pepper_suggests to each target file", async () => {
    await seed("goals/ship.md", { id: "g-ship", title: "Ship", type: "goal", status: "active", priority: "P1" });
    await seed("tasks/a.md", { id: "t-a", title: "A", type: "task", status: "backlog", priority: "P1", goal: "g-ship", order: "b" });

    const res = await handleGroom(repo, new MockAgent());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { suggestions: { taskId: string; file: { entity: { pepper_suggests?: unknown } } }[]; provider: string };
    expect(body.provider).toBe("mock");
    expect(body.suggestions.length).toBeGreaterThan(0);

    // The file on disk now carries pepper_suggests as YAML.
    const raw = await readFile(join(vault, "tasks/a.md"), "utf8");
    expect(raw).toContain("pepper_suggests:");
    expect(raw).toMatch(/base_version:/);
    expect(raw).toMatch(/provider: mock/);
  });

  test("contentHash is unchanged by writing pepper_suggests (excluded from the hash)", async () => {
    await seed("tasks/a.md", { id: "t-a", title: "A", type: "task", status: "backlog", priority: "P0", order: "b" });
    const before = (await repo.get("t-a"))!.contentHash;

    const agent = scriptedAgent((input) => [{
      taskId: "t-a",
      patch: { status: "today" },
      reason: "test",
      baseVersion: input.files.find((f) => f.id === "t-a")!.contentHash,
      provider: "mock",
      createdAt: NOW.toISOString(),
    }]);
    await handleGroom(repo, agent);

    const after = (await repo.get("t-a"))!.contentHash;
    expect(after).toBe(before);
  });

  test("re-grooming overwrites the existing pepper_suggests", async () => {
    await seed("tasks/a.md", { id: "t-a", title: "A", type: "task", status: "backlog", priority: "P0", order: "b" });

    const a1 = scriptedAgent((input) => [{
      taskId: "t-a", patch: { status: "today" }, reason: "first",
      baseVersion: input.files.find((f) => f.id === "t-a")!.contentHash,
      provider: "mock", createdAt: NOW.toISOString(),
    }]);
    await handleGroom(repo, a1);

    const a2 = scriptedAgent((input) => [{
      taskId: "t-a", patch: { status: "in-progress" }, reason: "second",
      baseVersion: input.files.find((f) => f.id === "t-a")!.contentHash,
      provider: "mock", createdAt: NOW.toISOString(),
    }]);
    await handleGroom(repo, a2);

    const file = (await repo.get("t-a"))!;
    expect(file.entity.pepper_suggests?.reason).toBe("second");
    expect(file.entity.pepper_suggests?.patch).toEqual({ status: "in-progress" });
  });

  test("a suggestion for a missing taskId is dropped without failing the whole groom", async () => {
    await seed("tasks/exists.md", { id: "t-exists", title: "E", type: "task", status: "backlog", priority: "P0", order: "b" });
    const agent = scriptedAgent((input) => [
      { taskId: "t-exists", patch: { status: "today" }, reason: "ok",
        baseVersion: input.files.find((f) => f.id === "t-exists")!.contentHash,
        provider: "mock", createdAt: NOW.toISOString() },
      { taskId: "t-missing", patch: { status: "today" }, reason: "skip me",
        baseVersion: "deadbeef", provider: "mock", createdAt: NOW.toISOString() },
    ]);
    const res = await handleGroom(repo, agent);
    const body = (await res.json()) as { suggestions: { taskId: string }[] };
    expect(body.suggestions.map((s) => s.taskId)).toEqual(["t-exists"]);
  });
});

describe("handleApprove", () => {
  test("applies the patch and clears pepper_suggests in one write", async () => {
    await seed("tasks/a.md", { id: "t-a", title: "A", type: "task", status: "backlog", priority: "P0", order: "b" });
    const agent = scriptedAgent((input) => [{
      taskId: "t-a", patch: { status: "today" }, reason: "test",
      baseVersion: input.files.find((f) => f.id === "t-a")!.contentHash,
      provider: "mock", createdAt: NOW.toISOString(),
    }]);
    await handleGroom(repo, agent);

    const res = await handleApprove(repo, "t-a");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entity: { status: string; pepper_suggests?: unknown } };
    expect(body.entity.status).toBe("today");
    expect(body.entity.pepper_suggests).toBeUndefined();

    const raw = await readFile(join(vault, "tasks/a.md"), "utf8");
    expect(raw).not.toContain("pepper_suggests");
    expect(raw).toMatch(/^status: today$/m);
  });

  test("404 when no pending suggestion exists on the task", async () => {
    await seed("tasks/a.md", { id: "t-a", title: "A", type: "task", status: "backlog", priority: "P0", order: "b" });
    const res = await handleApprove(repo, "t-a");
    expect(res.status).toBe(404);
  });

  test("404 on unknown taskId", async () => {
    const res = await handleApprove(repo, "nope");
    expect(res.status).toBe(404);
  });

  test("409 when the file has drifted since the suggestion was proposed", async () => {
    await seed("tasks/a.md", { id: "t-a", title: "A", type: "task", status: "backlog", priority: "P0", order: "b" });
    const agent = scriptedAgent((input) => [{
      taskId: "t-a", patch: { status: "today" }, reason: "test",
      baseVersion: input.files.find((f) => f.id === "t-a")!.contentHash,
      provider: "mock", createdAt: NOW.toISOString(),
    }]);
    await handleGroom(repo, agent);

    // Hand-edit changes a non-suggestion field. Now contentHash != base_version.
    await repo.update("t-a", { priority: "P1" });

    const res = await handleApprove(repo, "t-a");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; expectedBaseVersion: string; actualContentHash: string };
    expect(body.error).toMatch(/stale/);
    expect(body.expectedBaseVersion).not.toBe(body.actualContentHash);

    // File state is untouched by the failed approve.
    const file = (await repo.get("t-a"))!;
    if (file.entity.type !== "task") throw new Error("type");
    expect(file.entity.status).toBe("backlog");
    expect(file.entity.pepper_suggests).toBeDefined();
  });
});

describe("handleDismiss", () => {
  test("clears pepper_suggests without changing other fields", async () => {
    await seed("tasks/a.md", { id: "t-a", title: "A", type: "task", status: "backlog", priority: "P0", order: "b" });
    const agent = scriptedAgent((input) => [{
      taskId: "t-a", patch: { status: "today" }, reason: "test",
      baseVersion: input.files.find((f) => f.id === "t-a")!.contentHash,
      provider: "mock", createdAt: NOW.toISOString(),
    }]);
    await handleGroom(repo, agent);

    const res = await handleDismiss(repo, "t-a");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entity: { status: string; pepper_suggests?: unknown } };
    expect(body.entity.status).toBe("backlog"); // unchanged
    expect(body.entity.pepper_suggests).toBeUndefined();
  });

  test("404 when no pending suggestion exists", async () => {
    await seed("tasks/a.md", { id: "t-a", title: "A", type: "task", status: "backlog", priority: "P0", order: "b" });
    const res = await handleDismiss(repo, "t-a");
    expect(res.status).toBe(404);
  });

  test("dismiss writes pepper_dismissed_at as an ISO timestamp", async () => {
    await seed("tasks/a.md", { id: "t-a", title: "A", type: "task", status: "backlog", priority: "P0", order: "b" });
    const agent = scriptedAgent((input) => [{
      taskId: "t-a", patch: { status: "today" }, reason: "test",
      baseVersion: input.files.find((f) => f.id === "t-a")!.contentHash,
      provider: "mock", createdAt: NOW.toISOString(),
    }]);
    await handleGroom(repo, agent);

    const before = Date.now();
    const res = await handleDismiss(repo, "t-a");
    expect(res.status).toBe(200);

    const file = (await repo.get("t-a"))!;
    if (file.entity.type !== "task") throw new Error("type narrow");
    const stamp = (file.entity as { pepper_dismissed_at?: string }).pepper_dismissed_at;
    expect(typeof stamp).toBe("string");
    const parsed = Date.parse(stamp!);
    expect(Number.isFinite(parsed)).toBe(true);
    expect(parsed).toBeGreaterThanOrEqual(before - 5);
    expect(parsed).toBeLessThanOrEqual(Date.now() + 5);
  });
});

describe("handleApproveAll", () => {
  test("applies every pending suggestion atomically", async () => {
    await seed("tasks/a.md", { id: "t-a", title: "A", type: "task", status: "backlog", priority: "P0", order: "b" });
    await seed("tasks/b.md", { id: "t-b", title: "B", type: "task", status: "backlog", priority: "P0", order: "c" });
    const agent = scriptedAgent((input) => input.files
      .filter((f) => f.entity.type === "task")
      .map((f) => ({
        taskId: f.id, patch: { status: "today" }, reason: "test",
        baseVersion: f.contentHash, provider: "mock" as const, createdAt: NOW.toISOString(),
      })));
    await handleGroom(repo, agent);

    const res = await handleApproveAll(repo);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; applied: { id: string; entity: { status: string } }[] };
    expect(body.ok).toBe(true);
    expect(body.applied.map((a) => a.id).sort()).toEqual(["t-a", "t-b"]);
    for (const f of body.applied) {
      expect(f.entity.status).toBe("today");
    }
  });

  test("409 + no writes when ANY suggestion is stale", async () => {
    await seed("tasks/a.md", { id: "t-a", title: "A", type: "task", status: "backlog", priority: "P0", order: "b" });
    await seed("tasks/b.md", { id: "t-b", title: "B", type: "task", status: "backlog", priority: "P0", order: "c" });
    const agent = scriptedAgent((input) => input.files
      .filter((f) => f.entity.type === "task")
      .map((f) => ({
        taskId: f.id, patch: { status: "today" }, reason: "test",
        baseVersion: f.contentHash, provider: "mock" as const, createdAt: NOW.toISOString(),
      })));
    await handleGroom(repo, agent);

    // Drift exactly one file.
    await repo.update("t-a", { priority: "P1" });

    const res = await handleApproveAll(repo);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; stale: { taskId: string }[] };
    expect(body.ok).toBe(false);
    expect(body.stale.map((s) => s.taskId)).toEqual(["t-a"]);

    // No-write contract: t-b is still backlog with its suggestion intact.
    const tb = (await repo.get("t-b"))!;
    if (tb.entity.type !== "task") throw new Error("type");
    expect(tb.entity.status).toBe("backlog");
    expect(tb.entity.pepper_suggests).toBeDefined();
  });

  test("empty pending → ok: true with no applied", async () => {
    await seed("tasks/a.md", { id: "t-a", title: "A", type: "task", status: "backlog", priority: "P0", order: "b" });
    const res = await handleApproveAll(repo);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; applied: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.applied).toEqual([]);
  });
});

describe("matchSuggestionAction", () => {
  test("matches approve and dismiss with URL decoding", () => {
    expect(matchSuggestionAction("/api/suggestions/t-foo/approve")).toEqual({ taskId: "t-foo", action: "approve" });
    expect(matchSuggestionAction("/api/suggestions/t%2Dfoo/dismiss")).toEqual({ taskId: "t-foo", action: "dismiss" });
  });

  test("rejects non-matching and the approve-all collision", () => {
    expect(matchSuggestionAction("/api/suggestions/foo/other")).toBeUndefined();
    expect(matchSuggestionAction("/api/suggestions/approve-all")).toBeUndefined();
    expect(matchSuggestionAction("/api/suggestions/approve-all/approve")).toBeUndefined();
    expect(matchSuggestionAction("/api/agent/groom")).toBeUndefined();
  });
});
