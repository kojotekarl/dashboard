import type { TaskFile } from "../repo/TaskRepository.ts";

/**
 * A single proposed change to one task. Returned by an AgentProvider; the
 * server then validates + writes it as `pepper_suggests:` on the file.
 *
 * `baseVersion` snapshots the file's contentHash at proposal time so T7's
 * approve handler can refuse to apply if the file has drifted since (the
 * suggestion-staleness defense — subagent #5 / codex C5).
 */
export type Suggestion = {
  taskId: string;
  patch: Record<string, unknown>;
  reason: string;
  baseVersion: string;
  provider: "mock" | "hermes";
  /** ISO 8601, taken from `GroomInput.now`. */
  createdAt: string;
};

export type GroomInput = {
  /** Every parsed file in the vault (tasks, goals, routines, projects, learning-steps). */
  files: readonly TaskFile[];
  /** "Now" as the server sees it. Injected so the agent is deterministic in tests. */
  now: Date;
};

export type GroomResult = {
  suggestions: Suggestion[];
  /** Optional one-line summary for the UI. */
  summary?: string;
};

/**
 * Provider abstraction so the public class repo can ship with a real LLM
 * provider (HermesAgent) and a deterministic fallback (MockAgent) behind
 * one interface. The UI shows `name` as the "Live Hermes" / "Mock" badge
 * (codex C18 — provenance visibility).
 */
export interface AgentProvider {
  readonly name: "mock" | "hermes";
  groom(input: GroomInput): Promise<GroomResult>;
}
