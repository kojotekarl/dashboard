import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarkdownRepository, contentHash } from "../server/repo/MarkdownRepository.ts";

let vault: string;

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), "agent-test-"));
  await mkdir(join(vault, "tasks"));
  await mkdir(join(vault, "goals"));
  await mkdir(join(vault, "routines"));
  await mkdir(join(vault, "projects"));
});

afterEach(async () => {
  await rm(vault, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<void> {
  await writeFile(join(vault, rel), content, "utf8");
}

const task = (fields: Record<string, string | number>, body = "Notes."): string => {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n${body}\n`;
};

describe("MarkdownRepository.list", () => {
  test("returns parsed entities from all entity directories", async () => {
    await write(
      "tasks/foo.md",
      task({ id: "t-foo", title: "Foo", type: "task", status: "today", priority: "P1", order: "b" }),
    );
    await write(
      "goals/bar.md",
      task({ id: "g-bar", title: "Bar", type: "goal", status: "active", priority: "P2" }),
    );
    await write(
      "routines/baz.md",
      task({
        id: "r-baz",
        title: "Baz",
        type: "routine",
        status: "backlog",
        priority: "P2",
        order: "b",
        recurrence: "daily",
      }),
    );

    const { files, warnings } = await new MarkdownRepository(vault).list();
    const ids = files.map((f) => f.id).sort();
    expect(ids).toEqual(["g-bar", "r-baz", "t-foo"]);
    expect(warnings).toEqual([]);
  });

  test("missing optional subdirs are not an error", async () => {
    await rm(join(vault, "projects"), { recursive: true, force: true });
    await write("tasks/x.md", task({ id: "t-x", title: "x", type: "task", status: "today", priority: "P3", order: "b" }));
    const { files, warnings } = await new MarkdownRepository(vault).list();
    expect(files).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  test("ignores hidden files and in-flight .tmp.* writes", async () => {
    await write(".DS_Store", "");
    await write("tasks/visible.md", task({ id: "t-v", title: "v", type: "task", status: "today", priority: "P3", order: "b" }));
    await write("tasks/visible.md.tmp.abc123", "in flight");
    const { files } = await new MarkdownRepository(vault).list();
    expect(files.map((f) => f.id)).toEqual(["t-v"]);
  });
});

describe("MarkdownRepository.get + update", () => {
  test("update persists a field change and refreshes content hash", async () => {
    await write(
      "tasks/foo.md",
      task({ id: "t-foo", title: "Foo", type: "task", status: "today", priority: "P1", order: "b" }),
    );
    const repo = new MarkdownRepository(vault);
    const before = (await repo.get("t-foo"))!;
    expect(before.entity.type).toBe("task");
    if (before.entity.type !== "task") throw new Error("type narrow");
    expect(before.entity.status).toBe("today");

    const after = await repo.update("t-foo", { status: "done" });
    if (after.entity.type !== "task") throw new Error("type narrow");
    expect(after.entity.status).toBe("done");
    expect(after.contentHash).not.toBe(before.contentHash);

    const reread = await readFile(join(vault, "tasks/foo.md"), "utf8");
    expect(reread).toMatch(/^status: done$/m);
  });

  test("update throws on unknown id", async () => {
    const repo = new MarkdownRepository(vault);
    await expect(repo.update("nope", { status: "done" })).rejects.toThrow(/no file with id/);
  });
});

describe("coerce-and-warn", () => {
  test("unknown status alias is coerced with a warning, not dropped", async () => {
    await write(
      "tasks/x.md",
      task({ id: "t-x", title: "x", type: "task", status: "doing", priority: "P1", order: "b" }),
    );
    const { files, warnings } = await new MarkdownRepository(vault).list();
    expect(files).toHaveLength(1);
    if (files[0]!.entity.type !== "task") throw new Error("type narrow");
    expect(files[0]!.entity.status).toBe("in-progress");
    expect(warnings.find((w) => w.field === "status")).toBeDefined();
  });

  test("missing id falls back to filename stem", async () => {
    await write(
      "tasks/my-cool-task.md",
      task({ title: "no id field", type: "task", status: "backlog", priority: "P2", order: "b" }),
    );
    const { files, warnings } = await new MarkdownRepository(vault).list();
    expect(files[0]!.id).toBe("my-cool-task");
    expect(warnings.find((w) => w.field === "id")).toBeDefined();
  });

  test("malformed YAML produces a warning and drops just that file", async () => {
    await write("tasks/bad.md", "---\nstatus: [unclosed\n---\nbody");
    await write(
      "tasks/good.md",
      task({ id: "t-good", title: "ok", type: "task", status: "today", priority: "P1", order: "b" }),
    );
    const { files, warnings } = await new MarkdownRepository(vault).list();
    expect(files.map((f) => f.id)).toEqual(["t-good"]);
    expect(warnings.find((w) => w.message.startsWith("YAML parse error"))).toBeDefined();
  });
});

describe("contentHash", () => {
  test("stable across runs", () => {
    const data = { id: "t-1", title: "x", status: "today", priority: "P1", order: "b" };
    const h1 = contentHash(data, "body\n");
    const h2 = contentHash(data, "body\n");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  test("excludes agent_suggests so writing a suggestion does NOT change base hash", () => {
    const data = { id: "t-1", title: "x", status: "today", priority: "P1", order: "b" };
    const withSuggestion = {
      ...data,
      agent_suggests: { patch: { status: "done" }, reason: "x", base_version: "abc", provider: "mock", created_at: "now" },
    };
    expect(contentHash(data, "body")).toBe(contentHash(withSuggestion, "body"));
  });

  test("differs when body changes", () => {
    const data = { id: "t-1", title: "x", status: "today", priority: "P1", order: "b" };
    expect(contentHash(data, "a")).not.toBe(contentHash(data, "b"));
  });
});
