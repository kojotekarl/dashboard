import type { Entity, ParseWarning } from "./schema.ts";

/**
 * A vault file holding one entity (task/goal/routine/project/learning-step).
 *
 * `rawFrontmatter` carries every key from the file, including unknown
 * Obsidian/plugin keys we don't model. `update()` preserves them by mutating
 * the original object rather than rebuilding from `entity`.
 *
 * `contentHash` is computed over the file with `agent_suggests` excluded —
 * so writing a suggestion does NOT invalidate the base version of the
 * suggestion itself. (T7 / approve uses this to detect staleness.)
 */
export type TaskFile = {
  id: string;
  /** Absolute path on disk. */
  path: string;
  /** Path relative to the vault root. */
  relPath: string;
  entity: Entity;
  body: string;
  rawFrontmatter: Record<string, unknown>;
  contentHash: string;
};

export type RepoListing = {
  files: TaskFile[];
  warnings: ParseWarning[];
};

export interface TaskRepository {
  list(): Promise<RepoListing>;
  get(id: string): Promise<TaskFile | undefined>;
  /** Re-parse a single file by its vault-relative path (fast path for the watcher). */
  peek(relPath: string): Promise<TaskFile | undefined>;
  /**
   * Apply a shallow patch to the file's frontmatter and atomically rewrite it.
   * Unknown keys not mentioned in `patch` are preserved verbatim.
   * Returns the post-update TaskFile (with refreshed contentHash).
   */
  update(id: string, patch: Record<string, unknown>): Promise<TaskFile>;
}
