import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarkdownRepository } from "../server/repo/MarkdownRepository.ts";

let vault: string;

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), "pepper-roundtrip-"));
  await mkdir(join(vault, "tasks"));
});

afterEach(async () => {
  await rm(vault, { recursive: true, force: true });
});

describe("roundtrip preservation", () => {
  test("unknown frontmatter keys (Obsidian tags/aliases/plugin metadata) survive update", async () => {
    const path = join(vault, "tasks/foo.md");
    await writeFile(
      path,
      [
        "---",
        "id: t-foo",
        "title: Foo",
        "type: task",
        "status: today",
        "priority: P1",
        "order: b",
        "tags:",
        "  - obsidian",
        "  - my-plugin",
        "aliases:",
        "  - foo-alias",
        "weird_plugin_field: hello",
        "---",
        "Notes body.",
        "",
      ].join("\n"),
      "utf8",
    );

    const repo = new MarkdownRepository(vault);
    await repo.update("t-foo", { status: "done" });

    const after = await readFile(path, "utf8");
    expect(after).toMatch(/^status: done$/m);
    expect(after).toContain("tags:");
    expect(after).toContain("- obsidian");
    expect(after).toContain("- my-plugin");
    expect(after).toContain("aliases:");
    expect(after).toContain("- foo-alias");
    expect(after).toMatch(/weird_plugin_field: hello/);
  });

  test("body markdown is preserved verbatim through update", async () => {
    const path = join(vault, "tasks/foo.md");
    const body = [
      "# Heading",
      "",
      "Some _italic_ and **bold**.",
      "",
      "- bullet one",
      "- bullet two",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "Trailing line.",
      "",
    ].join("\n");
    await writeFile(
      path,
      ["---", "id: t-foo", "title: Foo", "type: task", "status: today", "priority: P1", "order: b", "---", body].join("\n"),
      "utf8",
    );

    const repo = new MarkdownRepository(vault);
    await repo.update("t-foo", { status: "in-progress" });

    const after = await readFile(path, "utf8");
    expect(after).toContain(body);
  });

  test("update can write pepper_suggests without disturbing other fields", async () => {
    const path = join(vault, "tasks/foo.md");
    await writeFile(
      path,
      [
        "---",
        "id: t-foo",
        "title: Foo",
        "type: task",
        "status: today",
        "priority: P1",
        "order: b",
        "tags:",
        "  - keepme",
        "---",
        "Body.",
        "",
      ].join("\n"),
      "utf8",
    );

    const repo = new MarkdownRepository(vault);
    const baseHash = (await repo.get("t-foo"))!.contentHash;

    const suggestion = {
      patch: { status: "in-progress" },
      reason: "due today",
      base_version: baseHash,
      provider: "mock",
      created_at: "2026-06-04T10:00:00Z",
    };
    const after = await repo.update("t-foo", { pepper_suggests: suggestion });

    // Hash excludes pepper_suggests, so the BASE hash is unchanged
    // even though the file on disk now has the suggestion in it.
    expect(after.contentHash).toBe(baseHash);

    const reread = await readFile(path, "utf8");
    expect(reread).toContain("pepper_suggests:");
    expect(reread).toContain("tags:");
    expect(reread).toContain("- keepme");
    expect(reread).toMatch(/^status: today$/m); // status NOT changed by writing a suggestion
  });

  test("update preserves field order of pre-existing keys", async () => {
    const path = join(vault, "tasks/foo.md");
    await writeFile(
      path,
      [
        "---",
        "title: Foo",
        "id: t-foo",
        "type: task",
        "priority: P1",
        "status: today",
        "order: b",
        "---",
        "",
      ].join("\n"),
      "utf8",
    );

    const repo = new MarkdownRepository(vault);
    await repo.update("t-foo", { status: "done" });

    const after = await readFile(path, "utf8");
    // Ordering of existing keys is preserved (title before id, priority before status).
    const titleIdx = after.indexOf("title:");
    const idIdx = after.indexOf("id:");
    const priorityIdx = after.indexOf("priority:");
    const statusIdx = after.indexOf("status:");
    expect(titleIdx).toBeLessThan(idIdx);
    expect(priorityIdx).toBeLessThan(statusIdx);
  });
});
