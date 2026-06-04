import type { MarkdownRepository } from "../repo/MarkdownRepository.ts";
import type { TaskFile } from "../repo/TaskRepository.ts";
import { type ApiTaskFile, serializeFile } from "./wire.ts";

/**
 * Build the patch that applies a pending suggestion: take its proposed
 * frontmatter changes AND delete `pepper_suggests` in the same write so
 * the file does not keep a stale suggestion on it.
 *
 * `repo.update` treats `undefined` as "delete this key", so spreading the
 * patch and then setting `pepper_suggests: undefined` clears it.
 */
function applyPatch(file: TaskFile): Record<string, unknown> | undefined {
  const sugg = file.entity.pepper_suggests;
  if (sugg === undefined) return undefined;
  return { ...sugg.patch, pepper_suggests: undefined };
}

/**
 * Dismiss writes a snooze marker (`pepper_dismissed_at`) so the agent
 * doesn't re-propose the same change on the next groom. MockAgent +
 * HermesAgent both skip files dismissed within the snooze window
 * (default 24h). After the window, the file is eligible again.
 */
function dismissPatch(now: Date): Record<string, unknown> {
  return {
    pepper_suggests: undefined,
    pepper_dismissed_at: now.toISOString(),
  };
}

/**
 * POST /api/suggestions/:taskId/approve
 *
 * Apply the file's pending `pepper_suggests` to its real fields and clear
 * the suggestion in one atomic write. Refuses with 409 if the file has
 * drifted since the suggestion was proposed — the staleness gate
 * (subagent #5 / codex C5).
 */
export async function handleApprove(
  repo: MarkdownRepository,
  taskId: string,
): Promise<Response> {
  const file = await repo.get(taskId);
  if (!file) {
    return Response.json({ error: `no task with id "${taskId}"` }, { status: 404 });
  }
  const sugg = file.entity.pepper_suggests;
  if (sugg === undefined) {
    return Response.json({ error: "no pending suggestion on this task" }, { status: 404 });
  }
  if (sugg.base_version !== file.contentHash) {
    return Response.json(
      {
        error: "suggestion is stale — the file changed since it was proposed",
        expectedBaseVersion: sugg.base_version,
        actualContentHash: file.contentHash,
      },
      { status: 409 },
    );
  }
  const patch = applyPatch(file);
  if (patch === undefined) {
    // Defensive: applyPatch only returns undefined if pepper_suggests is gone,
    // but we already checked above. Keeps the type checker happy.
    return Response.json({ error: "no pending suggestion on this task" }, { status: 404 });
  }
  const updated = await repo.update(taskId, patch);
  return Response.json(serializeFile(updated));
}

/**
 * POST /api/suggestions/:taskId/dismiss
 *
 * Clear the pending `pepper_suggests` without applying its patch. No
 * staleness check needed — dismiss never touches "real" fields.
 */
export async function handleDismiss(
  repo: MarkdownRepository,
  taskId: string,
): Promise<Response> {
  const file = await repo.get(taskId);
  if (!file) {
    return Response.json({ error: `no task with id "${taskId}"` }, { status: 404 });
  }
  if (file.entity.pepper_suggests === undefined) {
    return Response.json({ error: "no pending suggestion on this task" }, { status: 404 });
  }
  const updated = await repo.update(taskId, dismissPatch(new Date()));
  return Response.json(serializeFile(updated));
}

export type ApproveAllStale = {
  taskId: string;
  expectedBaseVersion: string;
  actualContentHash: string;
};

export type ApproveAllResponse =
  | { ok: true; applied: ApiTaskFile[] }
  | { ok: false; error: string; stale: ApproveAllStale[] }
  | { ok: false; error: string; applied: ApiTaskFile[]; remaining: string[] };

/**
 * POST /api/suggestions/approve-all
 *
 * Two-phase batch:
 *
 *   Phase 1 — pre-validate every pending file. If ANY base_version is stale,
 *   return 409 with the list and write nothing. This is the "all-or-nothing"
 *   contract from codex C9.
 *
 *   Phase 2 — apply sequentially. Sequential writes on a real filesystem
 *   cannot be wrapped in a transaction; if write N fails mid-loop we return
 *   500 with {applied: TaskFile[], remaining: id[]} so the UI can show the
 *   partial state honestly.
 */
export async function handleApproveAll(repo: MarkdownRepository): Promise<Response> {
  const { files } = await repo.list();
  const pending = files.filter((f) => f.entity.pepper_suggests !== undefined);

  if (pending.length === 0) {
    const body: ApproveAllResponse = { ok: true, applied: [] };
    return Response.json(body);
  }

  // Phase 1 — pre-validate.
  const stale: ApproveAllStale[] = [];
  for (const f of pending) {
    const sugg = f.entity.pepper_suggests!;
    if (sugg.base_version !== f.contentHash) {
      stale.push({
        taskId: f.id,
        expectedBaseVersion: sugg.base_version,
        actualContentHash: f.contentHash,
      });
    }
  }
  if (stale.length > 0) {
    const body: ApproveAllResponse = {
      ok: false,
      error: `${stale.length} suggestion${stale.length === 1 ? " is" : "s are"} stale — nothing applied`,
      stale,
    };
    return Response.json(body, { status: 409 });
  }

  // Phase 2 — apply sequentially.
  const applied: ApiTaskFile[] = [];
  for (let i = 0; i < pending.length; i++) {
    const f = pending[i]!;
    const patch = applyPatch(f);
    if (patch === undefined) continue;
    try {
      const updated = await repo.update(f.id, patch);
      applied.push(serializeFile(updated));
    } catch (err: unknown) {
      const remaining = pending.slice(i + 1).map((p) => p.id);
      const msg = err instanceof Error ? err.message : String(err);
      const body: ApproveAllResponse = {
        ok: false,
        error: `write failed on ${f.id}: ${msg}`,
        applied,
        remaining,
      };
      return Response.json(body, { status: 500 });
    }
  }

  const body: ApproveAllResponse = { ok: true, applied };
  return Response.json(body);
}

/**
 * Match `/api/suggestions/:taskId/approve` or `.../dismiss`.
 * Returns undefined for any other path (including `/api/suggestions/approve-all`,
 * which is matched separately by an exact-path check).
 */
export function matchSuggestionAction(
  pathname: string,
): { taskId: string; action: "approve" | "dismiss" } | undefined {
  const m = /^\/api\/suggestions\/([^/]+)\/(approve|dismiss)$/.exec(pathname);
  if (!m) return undefined;
  if (m[1] === "approve-all") return undefined; // collision guard
  try {
    return { taskId: decodeURIComponent(m[1]!), action: m[2] as "approve" | "dismiss" };
  } catch {
    return undefined;
  }
}
