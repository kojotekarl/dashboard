import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DENYLIST, scanForLeaks } from "../scripts/privacy-lint.ts";

describe("privacy lint — committed sample-vault is clean", () => {
  test("scanForLeaks against ./sample-vault returns zero hits", async () => {
    const hits = await scanForLeaks("./sample-vault");
    if (hits.length > 0) {
      // Dump the report so it's actionable when this test fails.
      for (const h of hits) {
        console.error(`  ${h.file}:${h.line}  [${h.pattern}]  ${h.snippet}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

describe("privacy lint — detects planted leaks", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pepper-lint-"));
    await mkdir(join(dir, "tasks"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("flags a personal first name", async () => {
    await writeFile(join(dir, "tasks/leak.md"), "---\nid: x\n---\nNote from Stefan today\n", "utf8");
    const hits = await scanForLeaks(dir);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.pattern).toMatch(/stefan/i);
  });

  test("flags an absolute /Users/ path", async () => {
    await writeFile(join(dir, "tasks/leak.md"), "see /Users/alice/notes.md\n", "utf8");
    const hits = await scanForLeaks(dir);
    expect(hits.some((h) => h.pattern.includes("/Users/"))).toBe(true);
  });

  test("flags a hostname leak (zoidberg)", async () => {
    await writeFile(join(dir, "tasks/leak.md"), "scheduled on zoidberg overnight\n", "utf8");
    const hits = await scanForLeaks(dir);
    expect(hits.some((h) => h.pattern.includes("zoidberg"))).toBe(true);
  });

  test("skips binary and non-text extensions", async () => {
    await writeFile(join(dir, "tasks/leak.png"), "stefan", "utf8");
    const hits = await scanForLeaks(dir);
    expect(hits).toEqual([]);
  });

  test("skips node_modules and other vendor dirs", async () => {
    await mkdir(join(dir, "node_modules"), { recursive: true });
    await writeFile(join(dir, "node_modules/leak.md"), "stefan was here\n", "utf8");
    const hits = await scanForLeaks(dir);
    expect(hits).toEqual([]);
  });

  test("custom denylist is honored", async () => {
    await writeFile(join(dir, "tasks/leak.md"), "internal-codename-X is shipping\n", "utf8");
    const hits = await scanForLeaks(dir, [{ pattern: /internal-codename-X/, label: "internal codename" }]);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.pattern).toBe("internal codename");
  });
});

describe("default denylist sanity", () => {
  test("includes the high-priority patterns", () => {
    const labels = DEFAULT_DENYLIST.map((p) => p.label);
    expect(labels.some((l) => l.includes("stefan"))).toBe(true);
    expect(labels.some((l) => l.includes("zoidberg"))).toBe(true);
    expect(labels.some((l) => l.includes("/Users/"))).toBe(true);
  });
});
