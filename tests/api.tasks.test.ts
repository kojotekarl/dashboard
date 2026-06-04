import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleListTasks, handlePatchTask, matchTaskId } from "../server/api/tasks.ts";
import { MarkdownRepository } from "../server/repo/MarkdownRepository.ts";

let vault: string;
let repo: MarkdownRepository;

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), "agent-api-"));
  await mkdir(join(vault, "tasks"));
  await mkdir(join(vault, "goals"));
  repo = new MarkdownRepository(vault);
});

afterEach(async () => {
  await rm(vault, { recursive: true, force: true });
});

async function seed(rel: string, fm: Record<string, unknown>, body = "Notes."): Promise<void> {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  await writeFile(join(vault, rel), `---\n${lines.join("\n")}\n---\n${body}\n`, "utf8");
}

describe("handleListTasks", () => {
  test("returns wire-shape files + warnings, no absolute paths", async () => {
    await seed("tasks/a.md", { id: "t-a", title: "A", type: "task", status: "today", priority: "P1", order: "b" });
    await seed("goals/g.md", { id: "g-g", title: "G", type: "goal", status: "active", priority: "P2" });

    const res = await handleListTasks(repo);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: { id: string; relPath: string; contentHash: string }[]; warnings: unknown[] };
    expect(body.files.map((f) => f.id).sort()).toEqual(["g-g", "t-a"]);
    for (const f of body.files) {
      expect(f.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(f.relPath.startsWith("/")).toBe(false);
      expect(f.relPath).not.toContain(vault); // no absolute leak
    }
    expect(Array.isArray(body.warnings)).toBe(true);
  });
});

describe("handlePatchTask", () => {
  test("applies a patch and returns the new contentHash", async () => {
    await seed("tasks/x.md", { id: "t-x", title: "x", type: "task", status: "today", priority: "P1", order: "b" });
    const before = (await repo.get("t-x"))!.contentHash;

    const res = await handlePatchTask(repo, "t-x", { status: "done" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { contentHash: string; entity: { status: string } };
    expect(body.entity.status).toBe("done");
    expect(body.contentHash).not.toBe(before);
  });

  test("404 on unknown id", async () => {
    const res = await handlePatchTask(repo, "nope", { status: "done" });
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toMatchObject({ error: expect.stringContaining("no file with id") });
  });

  test("400 on non-object body", async () => {
    const r1 = await handlePatchTask(repo, "anything", null);
    expect(r1.status).toBe(400);
    const r2 = await handlePatchTask(repo, "anything", "string");
    expect(r2.status).toBe(400);
    const r3 = await handlePatchTask(repo, "anything", [1, 2, 3]);
    expect(r3.status).toBe(400);
  });

  test("400 on empty patch", async () => {
    const res = await handlePatchTask(repo, "anything", {});
    expect(res.status).toBe(400);
  });

  test("400 on forbidden fields (id, type, agent_suggests)", async () => {
    await seed("tasks/x.md", { id: "t-x", title: "x", type: "task", status: "today", priority: "P1", order: "b" });
    for (const field of ["id", "type", "agent_suggests"]) {
      const res = await handlePatchTask(repo, "t-x", { [field]: "anything" });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain(field);
    }
  });

  test("400 on empty id", async () => {
    const res = await handlePatchTask(repo, "", { status: "done" });
    expect(res.status).toBe(400);
  });

  test("400 on invalid order rank (defense in depth — drag patches validated)", async () => {
    await seed("tasks/x.md", { id: "t-x", title: "x", type: "task", status: "today", priority: "P1", order: "b" });
    const res = await handlePatchTask(repo, "t-x", { order: "INVALID" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/invalid rank/);
  });

  test("400 on invalid status enum", async () => {
    await seed("tasks/x.md", { id: "t-x", title: "x", type: "task", status: "today", priority: "P1", order: "b" });
    const res = await handlePatchTask(repo, "t-x", { status: "rocket" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/status must be one of/);
  });

  test("400 on invalid priority enum", async () => {
    await seed("tasks/x.md", { id: "t-x", title: "x", type: "task", status: "today", priority: "P1", order: "b" });
    const res = await handlePatchTask(repo, "t-x", { priority: "P9" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/priority must be one of/);
  });

  test("accepts a valid drag patch (status + order together)", async () => {
    await seed("tasks/x.md", { id: "t-x", title: "x", type: "task", status: "backlog", priority: "P1", order: "b" });
    const res = await handlePatchTask(repo, "t-x", { status: "today", order: "n" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entity: { status: string; order: string } };
    expect(body.entity.status).toBe("today");
    expect(body.entity.order).toBe("n");
  });
});

describe("matchTaskId", () => {
  test("matches /api/tasks/:id and url-decodes", () => {
    expect(matchTaskId("/api/tasks/t-foo")).toBe("t-foo");
    expect(matchTaskId("/api/tasks/t%2Dfoo")).toBe("t-foo");
  });

  test("rejects non-matching paths", () => {
    expect(matchTaskId("/api/tasks")).toBeUndefined();
    expect(matchTaskId("/api/tasks/")).toBeUndefined();
    expect(matchTaskId("/api/tasks/foo/bar")).toBeUndefined();
    expect(matchTaskId("/api/other")).toBeUndefined();
  });
});
