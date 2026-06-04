import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import matter from "gray-matter";
import { type Entity, type ParseWarning, parseEntity } from "./schema.ts";
import type { RepoListing, TaskFile, TaskRepository } from "./TaskRepository.ts";

const ENTITY_DIRS = ["tasks", "goals", "routines", "projects"] as const;

/**
 * Reads/writes a vault of plain markdown files with YAML frontmatter.
 *
 *   vault/
 *     tasks/*.md
 *     goals/*.md
 *     routines/*.md
 *     projects/*.md
 *
 * Writes are atomic (tmp + rename) and ignore-able by the file watcher via
 * the `*.tmp.*` glob. Unknown frontmatter keys are preserved on update.
 */
export class MarkdownRepository implements TaskRepository {
  constructor(private readonly vaultPath: string) {}

  async list(): Promise<RepoListing> {
    const files: TaskFile[] = [];
    const warnings: ParseWarning[] = [];

    for (const sub of ENTITY_DIRS) {
      const dir = join(this.vaultPath, sub);
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch (err: unknown) {
        // Missing optional subdir is fine; only surface unexpected errors.
        if (isENOENT(err)) continue;
        warnings.push({
          file: sub + "/",
          message: `failed to read directory: ${String(err)}`,
        });
        continue;
      }
      for (const name of entries) {
        if (!isVaultFile(name)) continue;
        const path = join(dir, name);
        const relPath = relative(this.vaultPath, path);
        const parsed = await this.parseFile(path, relPath);
        if (parsed.warnings.length > 0) warnings.push(...parsed.warnings);
        if (parsed.file) files.push(parsed.file);
      }
    }

    return { files, warnings };
  }

  async get(id: string): Promise<TaskFile | undefined> {
    const { files } = await this.list();
    return files.find((f) => f.id === id);
  }

  async update(id: string, patch: Record<string, unknown>): Promise<TaskFile> {
    const current = await this.get(id);
    if (!current) {
      throw new Error(`update: no file with id "${id}"`);
    }

    // Mutate a clone of the original frontmatter object so unknown keys
    // (Obsidian tags/aliases/plugin metadata) are preserved AND insertion
    // order is maintained for keys we don't touch.
    const merged: Record<string, unknown> = { ...current.rawFrontmatter };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) {
        delete merged[k];
      } else {
        merged[k] = v;
      }
    }

    const next = matter.stringify(current.body, merged);
    await this.atomicWrite(current.path, next);

    // Re-read to refresh the content hash from the on-disk truth.
    const refreshed = await this.parseFile(current.path, current.relPath);
    if (!refreshed.file) {
      throw new Error(
        `update wrote ${current.relPath} but the result failed to re-parse: ` +
          refreshed.warnings.map((w) => w.message).join("; "),
      );
    }
    return refreshed.file;
  }

  // ─── internals ─────────────────────────────────────────────────────

  private async parseFile(
    path: string,
    relPath: string,
  ): Promise<{ file: TaskFile | undefined; warnings: ParseWarning[] }> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err: unknown) {
      return {
        file: undefined,
        warnings: [{ file: relPath, message: `read failed: ${String(err)}` }],
      };
    }

    let parsed: { data: Record<string, unknown>; content: string };
    try {
      const result = matter(raw);
      parsed = { data: (result.data ?? {}) as Record<string, unknown>, content: result.content };
    } catch (err: unknown) {
      return {
        file: undefined,
        warnings: [{ file: relPath, message: `YAML parse error: ${(err as Error).message}` }],
      };
    }

    const fallbackId = basename(path, extname(path));
    const entityResult = parseEntity(parsed.data, relPath, fallbackId);
    if (!entityResult.entity) {
      return { file: undefined, warnings: entityResult.warnings };
    }

    const file: TaskFile = {
      id: entityResult.entity.id,
      path,
      relPath,
      entity: entityResult.entity,
      body: parsed.content,
      rawFrontmatter: parsed.data,
      contentHash: contentHash(parsed.data, parsed.content),
    };
    return { file, warnings: entityResult.warnings };
  }

  private async atomicWrite(path: string, contents: string): Promise<void> {
    const tmp = `${path}.tmp.${randomUUID()}`;
    await writeFile(tmp, contents, "utf8");
    await rename(tmp, path);
  }
}

// ─── helpers ────────────────────────────────────────────────────────

function isENOENT(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

function isVaultFile(name: string): boolean {
  if (name.startsWith(".")) return false; // .DS_Store, etc.
  if (name.includes(".tmp.")) return false; // in-flight atomic writes
  return name.endsWith(".md");
}

/**
 * SHA-256 hex of canonicalized frontmatter + body. Excludes `pepper_suggests`
 * so writing a suggestion to a file does NOT change the file's base version
 * (the version the suggestion was generated against).
 */
export function contentHash(data: Record<string, unknown>, body: string): string {
  const { pepper_suggests: _drop, ...rest } = data;
  const sortedKeys = Object.keys(rest).sort();
  const canonical: Record<string, unknown> = {};
  for (const k of sortedKeys) canonical[k] = rest[k];
  const payload = JSON.stringify(canonical) + "\n---\n" + body;
  return createHash("sha256").update(payload).digest("hex");
}

/** Exported only for tests. */
export { ENTITY_DIRS as _ENTITY_DIRS };

/** Convenience re-export so callers can type-narrow without importing schema. */
export type { Entity, TaskFile };
