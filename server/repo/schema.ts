import { z } from "zod";

// ─── Domain enums ────────────────────────────────────────────────────

export const TaskStatus = z.enum([
  "backlog",
  "today",
  "in-progress",
  "blocked",
  "done",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const GoalStatus = z.enum(["active", "paused", "done"]);
export type GoalStatus = z.infer<typeof GoalStatus>;

export const Priority = z.enum(["P0", "P1", "P2", "P3"]);
export type Priority = z.infer<typeof Priority>;

export const Recurrence = z.enum(["daily", "weekly"]);
export type Recurrence = z.infer<typeof Recurrence>;

// ─── Suggestion embedded in a file's frontmatter ────────────────────

export const PepperSuggests = z.object({
  patch: z.record(z.string(), z.unknown()),
  reason: z.string().min(1),
  base_version: z.string().min(1),
  provider: z.enum(["mock", "hermes"]),
  created_at: z.string().min(1), // ISO datetime
});
export type PepperSuggests = z.infer<typeof PepperSuggests>;

// ─── Discriminated entity union (one per file) ──────────────────────
//
// `order` is intentionally `string` so we can use lexorank-style fractional
// ranks. (It also accepts coerced numbers via the coerce-and-warn path.)

const BaseTaskLike = {
  id: z.string().min(1),
  title: z.string().min(1),
  status: TaskStatus,
  priority: Priority,
  project: z.string().min(1).nullable().optional(),
  goal: z.string().min(1).nullable().optional(),
  due: z.string().nullable().optional(), // YYYY-MM-DD or full ISO
  scheduled: z.string().nullable().optional(),
  estimate: z.string().nullable().optional(),
  depends_on: z.array(z.string()).default([]),
  order: z.string().min(1),
  pepper_suggests: PepperSuggests.optional(),
  /**
   * ISO datetime of when the user last dismissed a suggestion on this file.
   * Agents skip the file while this is within the snooze window (default 24h).
   * Set by handleDismiss; survives across grooms.
   */
  pepper_dismissed_at: z.string().min(1).optional(),
} as const;

export const TaskEntity = z.object({
  type: z.literal("task"),
  ...BaseTaskLike,
  recurrence: z.null().optional(),
});
export const LearningStepEntity = z.object({
  type: z.literal("learning-step"),
  ...BaseTaskLike,
  recurrence: z.null().optional(),
});
export const RoutineEntity = z.object({
  type: z.literal("routine"),
  ...BaseTaskLike,
  recurrence: Recurrence,
});
export const GoalEntity = z.object({
  type: z.literal("goal"),
  id: z.string().min(1),
  title: z.string().min(1),
  status: GoalStatus,
  priority: Priority,
  target_date: z.string().nullable().optional(),
  pepper_suggests: PepperSuggests.optional(),
  pepper_dismissed_at: z.string().min(1).optional(),
});
export const ProjectEntity = z.object({
  type: z.literal("project"),
  id: z.string().min(1),
  title: z.string().min(1),
  status: GoalStatus,
  priority: Priority,
  goal: z.string().min(1).nullable().optional(),
  due: z.string().nullable().optional(),
  pepper_suggests: PepperSuggests.optional(),
  pepper_dismissed_at: z.string().min(1).optional(),
});

export const Entity = z.discriminatedUnion("type", [
  TaskEntity,
  LearningStepEntity,
  RoutineEntity,
  GoalEntity,
  ProjectEntity,
]);
export type Entity = z.infer<typeof Entity>;
export type EntityType = Entity["type"];

// ─── Coerce-and-warn parser ──────────────────────────────────────────
//
// The repository never throws on a malformed file. It returns a partial,
// best-effort entity (or undefined if too broken to repair) plus a list of
// warnings the UI can surface. This is the explicit policy decided in
// /plan-eng-review (subagent #4): silent drops are worse than visible warnings.

export type ParseWarning = {
  file: string; // relative path inside the vault
  field?: string | undefined;
  raw?: unknown;
  message: string;
};

export type ParseResult =
  | { entity: Entity; warnings: ParseWarning[] }
  | { entity: undefined; warnings: ParseWarning[] };

const STATUS_ALIASES: Record<string, TaskStatus> = {
  todo: "backlog",
  doing: "in-progress",
  inprogress: "in-progress",
  in_progress: "in-progress",
  wip: "in-progress",
  completed: "done",
  finished: "done",
};

const PRIORITY_ALIASES: Record<string, Priority> = {
  high: "P0",
  med: "P2",
  medium: "P2",
  low: "P3",
};

function coerceString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

/**
 * Normalize an "ISO datetime" frontmatter value back to a string. js-yaml
 * happily turns unquoted ISO timestamps into JS Date objects on parse, so
 * a field we wrote as `now.toISOString()` may round-trip as `Date` instead.
 * Tolerate both shapes here; reject anything else.
 */
function coerceIsoString(v: unknown): string | undefined {
  if (typeof v === "string" && v.length > 0) return v;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
  return undefined;
}

function coerceStatus(v: unknown, file: string, warnings: ParseWarning[]): TaskStatus | undefined {
  const s = coerceString(v)?.toLowerCase().trim();
  if (!s) return undefined;
  if (TaskStatus.options.includes(s as TaskStatus)) return s as TaskStatus;
  const aliased = STATUS_ALIASES[s];
  if (aliased) {
    warnings.push({ file, field: "status", raw: v, message: `coerced "${s}" -> "${aliased}"` });
    return aliased;
  }
  warnings.push({ file, field: "status", raw: v, message: `unknown status; defaulting to "backlog"` });
  return "backlog";
}

function coercePriority(v: unknown, file: string, warnings: ParseWarning[]): Priority | undefined {
  const s = coerceString(v)?.toUpperCase().trim();
  if (!s) return undefined;
  if (Priority.options.includes(s as Priority)) return s as Priority;
  const aliased = PRIORITY_ALIASES[s.toLowerCase()];
  if (aliased) {
    warnings.push({ file, field: "priority", raw: v, message: `coerced "${s}" -> "${aliased}"` });
    return aliased;
  }
  warnings.push({ file, field: "priority", raw: v, message: `unknown priority; defaulting to "P3"` });
  return "P3";
}

function coerceOrder(v: unknown, file: string, warnings: ParseWarning[]): string {
  if (typeof v === "string" && v.length > 0) return v;
  // Numeric `order:` is a common authoring pattern (sample data ships this way);
  // coerce silently. The Kanban view writes lexorank strings back on drag.
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  warnings.push({ file, field: "order", raw: v, message: `missing/invalid order; using "n"` });
  return "n"; // middle-ish lexorank seed
}

function coerceArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

/**
 * Best-effort parser. Never throws; always returns warnings list.
 * Drops the entity only if it cannot be assigned a type at all.
 */
export function parseEntity(
  data: Record<string, unknown>,
  file: string,
  fallbackId: string,
): ParseResult {
  const warnings: ParseWarning[] = [];

  // Resolve type from `type` field or fall back to a default heuristic.
  let type = coerceString(data.type);
  if (!type) {
    warnings.push({ file, field: "type", raw: data.type, message: `missing type; defaulting to "task"` });
    type = "task";
  }
  if (!["task", "learning-step", "routine", "goal", "project"].includes(type)) {
    warnings.push({ file, field: "type", raw: data.type, message: `unknown type "${type}"; treating as "task"` });
    type = "task";
  }

  const id = coerceString(data.id) ?? fallbackId;
  if (!coerceString(data.id)) {
    warnings.push({ file, field: "id", raw: data.id, message: `missing id; using "${fallbackId}" (from filename)` });
  }
  const title = coerceString(data.title) ?? fallbackId;
  if (!coerceString(data.title)) {
    warnings.push({ file, field: "title", raw: data.title, message: `missing title; using id` });
  }

  // Build per-type, then validate. We let Zod do the final shape check on
  // the coerced object; any remaining issues become warnings, not drops.
  let candidate: Record<string, unknown>;

  if (type === "goal" || type === "project") {
    const statusRaw = coerceString(data.status)?.toLowerCase().trim() ?? "active";
    const status = GoalStatus.options.includes(statusRaw as GoalStatus)
      ? (statusRaw as GoalStatus)
      : (warnings.push({ file, field: "status", raw: data.status, message: `unknown ${type} status; defaulting to "active"` }), "active");
    candidate = {
      type,
      id,
      title,
      status,
      priority: coercePriority(data.priority, file, warnings) ?? "P3",
      ...(type === "goal"
        ? { target_date: coerceString(data.target_date) ?? null }
        : { goal: coerceString(data.goal) ?? null, due: coerceString(data.due) ?? null }),
      ...(data.pepper_suggests !== undefined ? { pepper_suggests: data.pepper_suggests } : {}),
      ...(coerceIsoString(data.pepper_dismissed_at) !== undefined
        ? { pepper_dismissed_at: coerceIsoString(data.pepper_dismissed_at) }
        : {}),
    };
  } else {
    // task | learning-step | routine
    const status = coerceStatus(data.status, file, warnings) ?? "backlog";
    const priority = coercePriority(data.priority, file, warnings) ?? "P3";
    const order = coerceOrder(data.order, file, warnings);
    const depends_on = coerceArray(data.depends_on);
    candidate = {
      type,
      id,
      title,
      status,
      priority,
      project: coerceString(data.project) ?? null,
      goal: coerceString(data.goal) ?? null,
      due: coerceString(data.due) ?? null,
      scheduled: coerceString(data.scheduled) ?? null,
      estimate: coerceString(data.estimate) ?? null,
      depends_on,
      order,
      ...(data.pepper_suggests !== undefined ? { pepper_suggests: data.pepper_suggests } : {}),
      ...(coerceIsoString(data.pepper_dismissed_at) !== undefined
        ? { pepper_dismissed_at: coerceIsoString(data.pepper_dismissed_at) }
        : {}),
    };
    if (type === "routine") {
      const recRaw = coerceString(data.recurrence)?.toLowerCase().trim();
      if (recRaw === "daily" || recRaw === "weekly") {
        candidate.recurrence = recRaw;
      } else {
        warnings.push({ file, field: "recurrence", raw: data.recurrence, message: `routine missing recurrence; defaulting to "daily"` });
        candidate.recurrence = "daily";
      }
    } else {
      candidate.recurrence = null;
    }
  }

  const parsed = Entity.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      warnings.push({
        file,
        field: issue.path.join("."),
        message: issue.message,
      });
    }
    return { entity: undefined, warnings };
  }
  return { entity: parsed.data, warnings };
}
