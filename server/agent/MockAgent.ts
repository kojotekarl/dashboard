import type { Priority } from "../repo/schema.ts";
import type { TaskFile } from "../repo/TaskRepository.ts";
import type { AgentProvider, GroomInput, GroomResult, Suggestion } from "./AgentProvider.ts";

const PRIORITY_RANK: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/**
 * States we treat as "settled" — Mock won't propose moving them to Today.
 *   today        already there
 *   in-progress  already today's focus, just unflagged
 *   done         finished
 *   blocked      needs unblocking, not just a status flip
 */
const SETTLED_STATUSES: ReadonlySet<string> = new Set([
  "today",
  "in-progress",
  "done",
  "blocked",
]);

const MAX_TOTAL_SUGGESTIONS = 5;

/**
 * Snooze window after a Dismiss. If the user just said "no, not this one",
 * the agent should respect that for a while instead of re-proposing it on
 * the next groom click. 24h gives "not today" semantics with a natural
 * decay: tomorrow, the task is eligible again.
 */
export const SNOOZE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * True iff the file was dismissed within the snooze window. Tolerates an
 * invalid timestamp by treating it as "not dismissed" — we'd rather
 * re-propose than silently swallow a real task.
 */
function isSnoozed(file: TaskFile, now: Date): boolean {
  const raw = (file.entity as { agent_dismissed_at?: string }).agent_dismissed_at;
  if (typeof raw !== "string") return false;
  const ts = Date.parse(raw);
  if (Number.isNaN(ts)) return false;
  return now.getTime() - ts < SNOOZE_WINDOW_MS;
}

/**
 * Deterministic local "agent". Returns a small set of proposals so the public
 * class repo + graders without Hermes still see the groom-and-approve loop
 * working end-to-end. The HermesAgent ships with the same interface and a
 * provider="hermes" badge so the UI can show which path produced the output
 * (codex C18 — provenance visibility).
 *
 * Algorithm:
 *   1. For each active goal in priority order, propose its highest-priority
 *      non-settled task/learning-step → status: today.
 *   2. Promote each daily routine not already in today/done.
 *   3. Fill up to MAX_TOTAL_SUGGESTIONS with the highest-priority remaining
 *      tasks regardless of goal — keeps the demo lively on a sparse vault.
 *
 * Pure function of (files, now). Same input ⇒ same output (modulo `now`).
 */
export class MockAgent implements AgentProvider {
  readonly name = "mock" as const;

  async groom({ files, now }: GroomInput): Promise<GroomResult> {
    const isoNow = now.toISOString();
    const seen = new Set<string>();
    const suggestions: Suggestion[] = [];

    // Pass 1: one top candidate per active goal.
    const activeGoals = sortByPriority(
      files.filter((f) => f.entity.type === "goal" && f.entity.status === "active"),
    );
    for (const goalFile of activeGoals) {
      if (goalFile.entity.type !== "goal") continue;
      const goalId = goalFile.entity.id;
      const candidates = files.filter((f) => {
        if (seen.has(f.id)) return false;
        const e = f.entity;
        if (e.type !== "task" && e.type !== "learning-step") return false;
        if (e.goal !== goalId) return false;
        if (SETTLED_STATUSES.has(e.status)) return false;
        return !isSnoozed(f, now);
      });
      const top = sortByPriority(candidates)[0];
      if (top) {
        seen.add(top.id);
        suggestions.push({
          taskId: top.id,
          patch: { status: "today" },
          reason: `Advances goal "${goalFile.entity.title}"`,
          baseVersion: top.contentHash,
          provider: "mock",
          createdAt: isoNow,
        });
      }
    }

    // Pass 2: daily routines not already today/done.
    for (const f of files) {
      if (seen.has(f.id)) continue;
      const e = f.entity;
      if (e.type !== "routine" || e.recurrence !== "daily") continue;
      if (SETTLED_STATUSES.has(e.status)) continue;
      if (isSnoozed(f, now)) continue;
      seen.add(f.id);
      suggestions.push({
        taskId: f.id,
        patch: { status: "today" },
        reason: "Daily routine",
        baseVersion: f.contentHash,
        provider: "mock",
        createdAt: isoNow,
      });
    }

    // Pass 3: fill remaining slots with top-priority unseen tasks.
    const remaining = files.filter((f) => {
      if (seen.has(f.id)) return false;
      const e = f.entity;
      if (e.type !== "task" && e.type !== "learning-step") return false;
      if (SETTLED_STATUSES.has(e.status)) return false;
      return !isSnoozed(f, now);
    });
    for (const f of sortByPriority(remaining)) {
      if (suggestions.length >= MAX_TOTAL_SUGGESTIONS) break;
      if (f.entity.type !== "task" && f.entity.type !== "learning-step") continue;
      seen.add(f.id);
      suggestions.push({
        taskId: f.id,
        patch: { status: "today" },
        reason: `Top ${f.entity.priority} candidate`,
        baseVersion: f.contentHash,
        provider: "mock",
        createdAt: isoNow,
      });
    }

    return {
      suggestions,
      summary: suggestions.length
        ? `Proposed ${suggestions.length} change${suggestions.length === 1 ? "" : "s"} for today.`
        : "Nothing to groom — your day is already focused.",
    };
  }
}

function sortByPriority(files: readonly TaskFile[]): TaskFile[] {
  return [...files].sort((a, b) => {
    const d = PRIORITY_RANK[a.entity.priority] - PRIORITY_RANK[b.entity.priority];
    if (d !== 0) return d;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
