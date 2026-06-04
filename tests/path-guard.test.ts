import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PathSandboxError,
  assertUnderVault,
  canonicalizeVaultRoot,
} from "../server/safety/path-guard.ts";
import { MarkdownRepository } from "../server/repo/MarkdownRepository.ts";

let vault: string;
let canonicalRoot: string;

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), "pepper-guard-"));
  await mkdir(join(vault, "tasks"));
  canonicalRoot = canonicalizeVaultRoot(vault);
});

afterEach(async () => {
  await rm(vault, { recursive: true, force: true });
});

describe("canonicalizeVaultRoot", () => {
  test("resolves symlinked prefixes (macOS /tmp -> /private/tmp)", () => {
    // realpathSync returns an absolute path; we just verify it works without throwing.
    expect(canonicalRoot.length).toBeGreaterThan(0);
    expect(canonicalRoot.startsWith("/")).toBe(true);
  });

  test("throws for a non-existent root", () => {
    expect(() => canonicalizeVaultRoot("/no/such/dir")).toThrow(PathSandboxError);
  });
});

describe("assertUnderVault — happy paths", () => {
  test("accepts an existing regular file inside the vault", async () => {
    const file = join(vault, "tasks/x.md");
    await writeFile(file, "ok", "utf8");
    expect(() => assertUnderVault(canonicalRoot, file)).not.toThrow();
  });

  test("accepts a not-yet-existing tmp file inside the vault (mayNotExist)", () => {
    const tmp = join(vault, "tasks/x.md.tmp.abc123");
    expect(() => assertUnderVault(canonicalRoot, tmp, { mayNotExist: true })).not.toThrow();
  });

  test("returns the canonical absolute path of the target", () => {
    const out = assertUnderVault(canonicalRoot, join(vault, "tasks/x.md"), { mayNotExist: true });
    expect(out).toContain("tasks/x.md");
    expect(out).toContain(canonicalRoot);
  });
});

describe("assertUnderVault — rejects path escapes", () => {
  test("rejects ../-style traversal that escapes the root", () => {
    const escaped = join(vault, "tasks", "..", "..", "etc", "passwd");
    expect(() => assertUnderVault(canonicalRoot, escaped, { mayNotExist: true })).toThrow(
      PathSandboxError,
    );
  });

  test("rejects an absolute path outside the vault", () => {
    expect(() => assertUnderVault(canonicalRoot, "/etc/passwd", { mayNotExist: true })).toThrow(
      PathSandboxError,
    );
  });

  test("rejects a non-existent file when mayNotExist is not set", () => {
    expect(() => assertUnderVault(canonicalRoot, join(vault, "tasks/missing.md"))).toThrow(
      PathSandboxError,
    );
  });
});

describe("assertUnderVault — symlink defense", () => {
  test("rejects a symlink pointing OUTSIDE the vault", async () => {
    const link = join(vault, "tasks/escape.md");
    await symlink("/etc/passwd", link);
    expect(() => assertUnderVault(canonicalRoot, link)).toThrow(PathSandboxError);
  });

  test("rejects a symlink even when it points INSIDE the vault", async () => {
    // Defense in depth: a symlink-leaf is rejected on principle, not just for
    // where it points. Prevents subtle attacks where a vault-internal symlink
    // is later retargeted.
    const real = join(vault, "tasks/real.md");
    await writeFile(real, "ok", "utf8");
    const link = join(vault, "tasks/link.md");
    await symlink(real, link);
    expect(() => assertUnderVault(canonicalRoot, link)).toThrow(PathSandboxError);
  });

  test("allowSymlinks=true bypasses the lstat check (test-only)", async () => {
    const real = join(vault, "tasks/real.md");
    await writeFile(real, "ok", "utf8");
    const link = join(vault, "tasks/link.md");
    await symlink(real, link);
    expect(() => assertUnderVault(canonicalRoot, link, { allowSymlinks: true })).not.toThrow();
  });
});

describe("MarkdownRepository integration — symlink in vault subdir", () => {
  test("list() surfaces a warning for a symlink pointing outside the vault and skips it", async () => {
    // Plant a symlink in the vault that points at /etc — a typical attack.
    await symlink("/etc/passwd", join(vault, "tasks/escape.md"));
    // And a real file so we know normal parsing still works.
    await writeFile(
      join(vault, "tasks/real.md"),
      "---\nid: t-real\ntitle: real\ntype: task\nstatus: today\npriority: P1\norder: b\n---\nok\n",
      "utf8",
    );

    const repo = new MarkdownRepository(vault);
    const { files, warnings } = await repo.list();

    expect(files.map((f) => f.id)).toEqual(["t-real"]);
    const guardWarning = warnings.find((w) => w.message.includes("path-guard"));
    expect(guardWarning).toBeDefined();
    expect(guardWarning!.message).toMatch(/symlink|escape/);
  });

  test("update() never writes through a symlink target", async () => {
    // Seed a real file the repo can list.
    await writeFile(
      join(vault, "tasks/real.md"),
      "---\nid: t-real\ntitle: real\ntype: task\nstatus: today\npriority: P1\norder: b\n---\nok\n",
      "utf8",
    );
    const repo = new MarkdownRepository(vault);

    // Now corrupt the file out from under us by replacing it with a symlink
    // to /etc/passwd. The list() above gave us the path; update() should
    // refuse to write through it.
    await rm(join(vault, "tasks/real.md"));
    await symlink("/etc/passwd", join(vault, "tasks/real.md"));

    await expect(repo.update("t-real", { status: "done" })).rejects.toThrow();
  });
});
