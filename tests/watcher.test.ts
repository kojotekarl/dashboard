import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FileEvent, VaultWatcher } from "../server/watcher.ts";

let vault: string;
let watcher: VaultWatcher;

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), "pepper-watch-"));
  await mkdir(join(vault, "tasks"));
  watcher = new VaultWatcher(vault);
  await watcher.start();
});

afterEach(async () => {
  await watcher.stop();
  await rm(vault, { recursive: true, force: true });
});

/** Resolve with the next event, or reject after `timeoutMs`. */
function nextEvent(w: VaultWatcher, timeoutMs = 2000): Promise<FileEvent> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      unsub();
      reject(new Error(`no event within ${timeoutMs}ms`));
    }, timeoutMs);
    const unsub = w.on((e) => {
      clearTimeout(t);
      unsub();
      resolve(e);
    });
  });
}

/** Resolve true if NO event arrives within `windowMs`, false otherwise. */
function expectNoEvent(w: VaultWatcher, windowMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    let fired = false;
    const unsub = w.on(() => {
      fired = true;
    });
    setTimeout(() => {
      unsub();
      resolve(!fired);
    }, windowMs);
  });
}

describe("VaultWatcher", () => {
  test("emits 'add' when a new .md file is created", async () => {
    const next = nextEvent(watcher);
    await writeFile(join(vault, "tasks/new.md"), "---\nid: x\n---\n", "utf8");
    const evt = await next;
    expect(evt.type).toBe("add");
    expect(evt.relPath).toBe("tasks/new.md");
  });

  test("emits 'change' when an existing .md is modified", async () => {
    const path = join(vault, "tasks/edit.md");
    await writeFile(path, "v1", "utf8");
    await nextEvent(watcher); // consume the add

    const next = nextEvent(watcher);
    await writeFile(path, "v2", "utf8");
    const evt = await next;
    expect(evt.type).toBe("change");
    expect(evt.relPath).toBe("tasks/edit.md");
  });

  test("emits 'unlink' when a .md is deleted", async () => {
    const path = join(vault, "tasks/del.md");
    await writeFile(path, "x", "utf8");
    await nextEvent(watcher); // add

    const next = nextEvent(watcher);
    await unlink(path);
    const evt = await next;
    expect(evt.type).toBe("unlink");
    expect(evt.relPath).toBe("tasks/del.md");
  });

  test("ignores non-.md files", async () => {
    const quiet = expectNoEvent(watcher);
    await writeFile(join(vault, "tasks/notes.txt"), "x", "utf8");
    expect(await quiet).toBe(true);
  });

  test("ignores in-flight *.tmp.* files", async () => {
    const quiet = expectNoEvent(watcher);
    await writeFile(join(vault, "tasks/foo.md.tmp.abc123"), "x", "utf8");
    expect(await quiet).toBe(true);
  });

  test("suppressNext drops the next event for that exact path", async () => {
    const path = join(vault, "tasks/sup.md");
    watcher.suppressNext(path);
    const quiet = expectNoEvent(watcher);
    await writeFile(path, "x", "utf8");
    expect(await quiet).toBe(true);

    // Subsequent change is no longer suppressed.
    const next = nextEvent(watcher);
    await writeFile(path, "y", "utf8");
    const evt = await next;
    expect(evt.type).toBe("change");
  });

  test("atomic write (tmp + rename) is suppressed when paired with suppressNext", async () => {
    const path = join(vault, "tasks/atomic.md");
    const tmp = `${path}.tmp.xyz`;

    watcher.suppressNext(path);
    const quiet = expectNoEvent(watcher);
    await writeFile(tmp, "content", "utf8");
    await rename(tmp, path);
    expect(await quiet).toBe(true);
  });

  test("suppression expires after the window", async () => {
    const path = join(vault, "tasks/expire.md");
    watcher.suppressNext(path, 50);
    await new Promise((r) => setTimeout(r, 100));
    const next = nextEvent(watcher);
    await writeFile(path, "x", "utf8");
    const evt = await next;
    expect(evt.type).toBe("add");
  });
});
