import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAgent } from "../server/agent/MockAgent.ts";
import { MarkdownRepository } from "../server/repo/MarkdownRepository.ts";
import type { TaskFile } from "../server/repo/TaskRepository.ts";

let vault: string;
let repo: MarkdownRepository;
const NOW = new Date("2026-06-04T10:00:00Z");

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), "agent-mock-"));
  await mkdir(join(vault, "tasks"));
  await mkdir(join(vault, "goals"));
  await mkdir(join(vault, "routines"));
  repo = new MarkdownRepository(vault);
});

afterEach(async () => {
  await rm(vault, { recursive: true, force: true });
});

async function seed(rel: string, fm: Record<string, unknown>, body = "x"): Promise<void> {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  await writeFile(join(vault, rel), `---\n${lines.join("\n")}\n---\n${body}\n`, "utf8");
}

async function loadFiles(): Promise<TaskFile[]> {
  const { files } = await repo.list();
  return files;
}

describe("MockAgent.groom", () => {
  test("proposes the top non-settled task per active goal", async () => {
    await seed("goals/ship.md", { id: "g-ship", title: "Ship X", type: "goal", status: "active", priority: "P1" });
    await seed("tasks/low.md", { id: "t-low", title: "Low", type: "task", status: "backlog", priority: "P3", goal: "g-ship", order: "b" });
    await seed("tasks/high.md", { id: "t-high", title: "High", type: "task", status: "backlog", priority: "P0", goal: "g-ship", order: "c" });

    const agent = new MockAgent();
    const { suggestions } = await agent.groom({ files: await loadFiles(), now: NOW });

    const forGoal = suggestions.filter((s) => s.reason.includes("Ship X"));
    expect(forGoal).toHaveLength(1);
    expect(forGoal[0]!.taskId).toBe("t-high");
    expect(forGoal[0]!.patch).toEqual({ status: "today" });
  });

  test("skips tasks already in settled states (today / in-progress / done / blocked)", async () => {
    await seed("goals/ship.md", { id: "g-ship", title: "Ship X", type: "goal", status: "active", priority: "P1" });
    await seed("tasks/t1.md", { id: "t-1", title: "Done", type: "task", status: "done", priority: "P0", goal: "g-ship", order: "b" });
    await seed("tasks/t2.md", { id: "t-2", title: "Today", type: "task", status: "today", priority: "P0", goal: "g-ship", order: "c" });
    await seed("tasks/t3.md", { id: "t-3", title: "Blocked", type: "task", status: "blocked", priority: "P0", goal: "g-ship", order: "d" });
    await seed("tasks/t4.md", { id: "t-4", title: "InProg", type: "task", status: "in-progress", priority: "P0", goal: "g-ship", order: "e" });

    const { suggestions } = await new MockAgent().groom({ files: await loadFiles(), now: NOW });
    expect(suggestions).toEqual([]);
  });

  test("promotes daily routines not yet in today/done", async () => {
    await seed("routines/walk.md", {
      id: "r-walk",
      title: "Walk",
      type: "routine",
      status: "backlog",
      priority: "P2",
      order: "b",
      recurrence: "daily",
    });
    await seed("routines/weekly.md", {
      id: "r-week",
      title: "Weekly",
      type: "routine",
      status: "backlog",
      priority: "P2",
      order: "c",
      recurrence: "weekly",
    });

    const { suggestions } = await new MockAgent().groom({ files: await loadFiles(), now: NOW });
    expect(suggestions.map((s) => s.taskId)).toEqual(["r-walk"]);
    expect(suggestions[0]!.reason).toBe("Daily routine");
  });

  test("never proposes the same taskId twice", async () => {
    // Task is highest-priority for the goal AND would also be picked by pass 3.
    await seed("goals/ship.md", { id: "g-ship", title: "Ship X", type: "goal", status: "active", priority: "P0" });
    await seed("tasks/t.md", { id: "t-t", title: "T", type: "task", status: "backlog", priority: "P0", goal: "g-ship", order: "b" });

    const { suggestions } = await new MockAgent().groom({ files: await loadFiles(), now: NOW });
    expect(suggestions.map((s) => s.taskId)).toEqual(["t-t"]);
  });

  test("every suggestion carries provider=mock, baseVersion=file.contentHash, and createdAt=now", async () => {
    await seed("goals/ship.md", { id: "g-ship", title: "Ship X", type: "goal", status: "active", priority: "P1" });
    await seed("tasks/a.md", { id: "t-a", title: "A", type: "task", status: "backlog", priority: "P1", goal: "g-ship", order: "b" });

    const files = await loadFiles();
    const fileA = files.find((f) => f.id === "t-a")!;
    const { suggestions } = await new MockAgent().groom({ files, now: NOW });
    expect(suggestions).toHaveLength(1);
    const s = suggestions[0]!;
    expect(s.provider).toBe("mock");
    expect(s.baseVersion).toBe(fileA.contentHash);
    expect(s.createdAt).toBe(NOW.toISOString());
  });

  test("deterministic — same input produces same output", async () => {
    await seed("goals/g.md", { id: "g", title: "G", type: "goal", status: "active", priority: "P1" });
    await seed("tasks/a.md", { id: "t-a", title: "A", type: "task", status: "backlog", priority: "P1", goal: "g", order: "b" });
    await seed("tasks/b.md", { id: "t-b", title: "B", type: "task", status: "backlog", priority: "P2", goal: "g", order: "c" });

    const files = await loadFiles();
    const r1 = await new MockAgent().groom({ files, now: NOW });
    const r2 = await new MockAgent().groom({ files, now: NOW });
    expect(r1).toEqual(r2);
  });

  test("returns an encouraging summary when nothing needs grooming", async () => {
    await seed("tasks/done.md", { id: "t-d", title: "D", type: "task", status: "done", priority: "P0", order: "b" });
    const { suggestions, summary } = await new MockAgent().groom({ files: await loadFiles(), now: NOW });
    expect(suggestions).toEqual([]);
    expect(summary).toMatch(/already focused/);
  });

  test("skips files dismissed within the snooze window (24h)", async () => {
    await seed("goals/g.md", { id: "g", title: "G", type: "goal", status: "active", priority: "P1" });
    await seed("tasks/a.md", {
      id: "t-a", title: "A", type: "task", status: "backlog", priority: "P0", goal: "g", order: "b",
      agent_dismissed_at: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(), // 1h ago
    });
    await seed("tasks/b.md", { id: "t-b", title: "B", type: "task", status: "backlog", priority: "P1", goal: "g", order: "c" });

    const { suggestions } = await new MockAgent().groom({ files: await loadFiles(), now: NOW });
    // t-a is snoozed; should fall back to t-b for the goal slot.
    expect(suggestions.map((s) => s.taskId)).not.toContain("t-a");
    expect(suggestions.map((s) => s.taskId)).toContain("t-b");
  });

  test("re-proposes a file dismissed more than 24h ago", async () => {
    await seed("goals/g.md", { id: "g", title: "G", type: "goal", status: "active", priority: "P1" });
    await seed("tasks/a.md", {
      id: "t-a", title: "A", type: "task", status: "backlog", priority: "P0", goal: "g", order: "b",
      agent_dismissed_at: new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString(), // 25h ago
    });

    const { suggestions } = await new MockAgent().groom({ files: await loadFiles(), now: NOW });
    expect(suggestions.map((s) => s.taskId)).toContain("t-a");
  });

  test("invalid agent_dismissed_at is treated as not-dismissed (safer than swallowing the task)", async () => {
    await seed("goals/g.md", { id: "g", title: "G", type: "goal", status: "active", priority: "P1" });
    await seed("tasks/a.md", {
      id: "t-a", title: "A", type: "task", status: "backlog", priority: "P0", goal: "g", order: "b",
      agent_dismissed_at: "not-a-date",
    });

    const { suggestions } = await new MockAgent().groom({ files: await loadFiles(), now: NOW });
    expect(suggestions.map((s) => s.taskId)).toContain("t-a");
  });

  test("snooze also applies to daily routines", async () => {
    await seed("routines/walk.md", {
      id: "r-walk", title: "Walk", type: "routine", status: "backlog", priority: "P2", order: "b", recurrence: "daily",
      agent_dismissed_at: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(), // 1h ago
    });

    const { suggestions } = await new MockAgent().groom({ files: await loadFiles(), now: NOW });
    expect(suggestions.map((s) => s.taskId)).not.toContain("r-walk");
  });

  test("caps at MAX_TOTAL_SUGGESTIONS even on a busy vault", async () => {
    // 10 unfocused tasks, no goals — only pass 3 fires.
    for (let i = 0; i < 10; i++) {
      await seed(`tasks/t${i}.md`, {
        id: `t-${i}`,
        title: `T${i}`,
        type: "task",
        status: "backlog",
        priority: "P0",
        order: `b${i}`.padStart(2, "b"),
      });
    }
    const { suggestions } = await new MockAgent().groom({ files: await loadFiles(), now: NOW });
    expect(suggestions.length).toBeLessThanOrEqual(5);
  });
});
