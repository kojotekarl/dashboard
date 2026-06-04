// Wire-shape types mirroring server/api/wire.ts and friends.
// Kept as a local copy on purpose: the server boundary is one of the few
// places where a small bit of duplication is cheaper than the build / import
// gymnastics needed to share types across a Bun+server / Vite+web split.

export type TaskStatus = "backlog" | "today" | "in-progress" | "blocked" | "done";
export type GoalStatus = "active" | "paused" | "done";
export type Priority = "P0" | "P1" | "P2" | "P3";
export type Recurrence = "daily" | "weekly";
export type AgentProviderName = "mock" | "hermes";

export type PepperSuggests = {
  patch: Record<string, unknown>;
  reason: string;
  base_version: string;
  provider: AgentProviderName;
  created_at: string;
};

type TaskLike = {
  id: string;
  title: string;
  status: TaskStatus;
  priority: Priority;
  project: string | null;
  goal: string | null;
  due: string | null;
  scheduled: string | null;
  estimate: string | null;
  depends_on: string[];
  order: string;
  pepper_suggests?: PepperSuggests;
};

export type Entity =
  | (TaskLike & { type: "task"; recurrence?: null })
  | (TaskLike & { type: "learning-step"; recurrence?: null })
  | (TaskLike & { type: "routine"; recurrence: Recurrence })
  | {
      type: "goal";
      id: string;
      title: string;
      status: GoalStatus;
      priority: Priority;
      target_date?: string | null;
      pepper_suggests?: PepperSuggests;
    }
  | {
      type: "project";
      id: string;
      title: string;
      status: GoalStatus;
      priority: Priority;
      goal?: string | null;
      due?: string | null;
      pepper_suggests?: PepperSuggests;
    };

export type ApiTaskFile = {
  id: string;
  relPath: string;
  entity: Entity;
  body: string;
  contentHash: string;
};

export type ParseWarning = {
  file: string;
  field?: string;
  raw?: unknown;
  message: string;
};

export type ListTasksResponse = {
  files: ApiTaskFile[];
  warnings: ParseWarning[];
};

export type Suggestion = {
  taskId: string;
  patch: Record<string, unknown>;
  reason: string;
  baseVersion: string;
  provider: AgentProviderName;
  createdAt: string;
};

export type GroomResponse = {
  summary: string | undefined;
  provider: AgentProviderName;
  suggestions: (Suggestion & { file: ApiTaskFile })[];
};

export type ApproveAllResponse =
  | { ok: true; applied: ApiTaskFile[] }
  | {
      ok: false;
      error: string;
      stale: { taskId: string; expectedBaseVersion: string; actualContentHash: string }[];
    }
  | { ok: false; error: string; applied: ApiTaskFile[]; remaining: string[] };

// ─── WebSocket frames ──────────────────────────────────────────────

export type ServerMessage =
  | { type: "hello"; clients: number }
  | {
      type: "file_event";
      event: {
        kind: "add" | "change" | "unlink";
        relPath: string;
        mtimeMs: number;
        contentHash?: string;
      };
    };
