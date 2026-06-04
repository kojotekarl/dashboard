import type { TaskFile } from "../repo/TaskRepository.ts";
import type { AgentProvider, GroomInput, GroomResult, Suggestion } from "./AgentProvider.ts";
import type { CircuitBreaker } from "./breaker.ts";
import { CountingBreaker } from "./breaker.ts";
import { defaultRun, type RunFn, stripAnsi } from "./runner.ts";

export type HermesAgentOptions = {
  /** Path or bare name of the hermes binary. Default: "hermes" (PATH lookup). */
  bin?: string;
  /** Wall-clock budget for a single hermes call. Default: 90s. */
  timeoutMs?: number;
  /** Required: AgentProvider to use when hermes fails or the breaker is open. */
  fallback: AgentProvider;
  /** Optional circuit breaker. Default: 3-strike sticky. */
  breaker?: CircuitBreaker;
  /** Subprocess runner. Default: real Bun.spawn-backed runner. Tests inject a stub. */
  run?: RunFn;
};

/**
 * Live agent backed by `hermes -z PROMPT --yolo --accept-hooks` (the same
 * pattern agent-os uses at src/app/api/hermes/chat/route.ts). Wraps a
 * MockAgent fallback that takes over when Hermes:
 *
 *   - times out,
 *   - exits non-zero,
 *   - produces empty stdout,
 *   - produces output we can't parse as JSON (even after one repair retry),
 *   - or the session breaker has tripped open after 3 consecutive failures.
 *
 * Each Suggestion is tagged with provider="hermes" when Hermes produced it
 * and provider="mock" when the fallback did, so the UI badge in T10 reflects
 * what actually happened, not which agent was requested (codex C18).
 */
export class HermesAgent implements AgentProvider {
  readonly name = "hermes" as const;

  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly fallback: AgentProvider;
  private readonly breaker: CircuitBreaker;
  private readonly run: RunFn;

  constructor(opts: HermesAgentOptions) {
    this.bin = opts.bin ?? "hermes";
    this.timeoutMs = opts.timeoutMs ?? 90_000;
    this.fallback = opts.fallback;
    this.breaker = opts.breaker ?? new CountingBreaker(3);
    this.run = opts.run ?? defaultRun;
  }

  async groom(input: GroomInput): Promise<GroomResult> {
    if (this.breaker.isOpen()) {
      return this.withFallback("Hermes circuit open", input);
    }
    try {
      const result = await this.tryGroom(input);
      this.breaker.recordSuccess();
      return result;
    } catch (err: unknown) {
      this.breaker.recordFailure();
      const reason = err instanceof Error ? err.message : String(err);
      return this.withFallback(`Hermes failed: ${reason}`, input);
    }
  }

  /** Exposed for tests/health endpoints. */
  get breakerState(): { open: boolean; failures: number } {
    return { open: this.breaker.isOpen(), failures: this.breaker.failures };
  }

  // ─── internals ─────────────────────────────────────────────────────

  private async withFallback(reason: string, input: GroomInput): Promise<GroomResult> {
    const result = await this.fallback.groom(input);
    return {
      ...result,
      summary: `[${reason} — using mock] ${result.summary ?? ""}`.trim(),
    };
  }

  private async tryGroom(input: GroomInput): Promise<GroomResult> {
    const prompt = buildPrompt(input);
    const stdout = await this.runOnce(prompt);

    let parsed = parseAgentResponse(stdout);
    if (parsed === undefined) {
      const repaired = await this.runOnce(buildRepairPrompt(prompt, stdout));
      parsed = parseAgentResponse(repaired);
      if (parsed === undefined) {
        throw new Error("could not parse JSON after repair retry");
      }
    }

    const suggestions = coerceSuggestions(parsed.suggestions, input);
    return {
      suggestions,
      summary: `Hermes proposed ${suggestions.length} change${suggestions.length === 1 ? "" : "s"} for today.`,
    };
  }

  private async runOnce(prompt: string): Promise<string> {
    const out = await this.run(
      this.bin,
      ["-z", prompt, "--yolo", "--accept-hooks"],
      { timeoutMs: this.timeoutMs },
    );
    if (out.timedOut) throw new Error(`timed out after ${this.timeoutMs}ms`);
    if (!out.ok) {
      const tail = out.stderr.trim().slice(-200);
      throw new Error(`exit ${out.code}${tail ? `: ${tail}` : ""}`);
    }
    const text = stripAnsi(out.stdout).trim();
    if (text.length === 0) throw new Error("empty stdout");
    return text;
  }
}

// ─── prompt + parsing (free functions, exported for tests) ───────────

/** Compact wire-shape of the vault that gets dumped into the prompt. */
type PromptSummary = Record<string, unknown>;

function summarize(f: TaskFile): PromptSummary {
  const e = f.entity;
  const dismissed_at = (e as { agent_dismissed_at?: string }).agent_dismissed_at;
  const dismissedField = typeof dismissed_at === "string" ? { dismissed_at } : {};
  if (e.type === "goal") {
    return {
      id: e.id,
      type: e.type,
      title: e.title,
      status: e.status,
      priority: e.priority,
      target_date: e.target_date ?? null,
      ...dismissedField,
    };
  }
  if (e.type === "project") {
    return {
      id: e.id,
      type: e.type,
      title: e.title,
      status: e.status,
      priority: e.priority,
      goal: e.goal ?? null,
      due: e.due ?? null,
      ...dismissedField,
    };
  }
  // task | learning-step | routine
  const common = {
    id: e.id,
    type: e.type,
    title: e.title,
    status: e.status,
    priority: e.priority,
    project: e.project ?? null,
    goal: e.goal ?? null,
    due: e.due ?? null,
    scheduled: e.scheduled ?? null,
    estimate: e.estimate ?? null,
    ...dismissedField,
  };
  return e.type === "routine" ? { ...common, recurrence: e.recurrence } : common;
}

export function buildPrompt(input: GroomInput): string {
  const today = input.now.toISOString().slice(0, 10);
  const vault = input.files.map(summarize);
  return [
    `You are an agent, helping me decide what to focus on today.`,
    `Today is ${today}.`,
    ``,
    `My current goals, tasks, routines, and projects:`,
    JSON.stringify(vault, null, 2),
    ``,
    `Propose between 1 and 5 changes for today. Output STRICT JSON only — no markdown fences, no prose:`,
    ``,
    `{`,
    `  "suggestions": [`,
    `    { "taskId": "<id from above>", "patch": { "status": "today" }, "reason": "<short why>" }`,
    `  ]`,
    `}`,
    ``,
    `Rules:`,
    `- taskId must be an id from the list above.`,
    `- patch may set: status (backlog|today|in-progress|blocked|done), priority (P0|P1|P2|P3), scheduled (ISO datetime), due (YYYY-MM-DD), estimate.`,
    `- Do not propose changes to tasks already in "today", "done", or "blocked".`,
    `- Favor tasks aligned with active goals.`,
    `- If a task has a "dismissed_at" timestamp within the last 24 hours, skip it — the user already said "not today" to it.`,
    `- Return ONLY the JSON object. No prose, no fences, no commentary.`,
  ].join("\n");
}

export function buildRepairPrompt(originalPrompt: string, failedOutput: string): string {
  return [
    originalPrompt,
    ``,
    `--- IMPORTANT ---`,
    `Your previous response was unreadable as JSON. The first 1000 characters were:`,
    failedOutput.slice(0, 1000),
    ``,
    `Try again. Return ONLY the JSON object — no markdown fences, no prose, no commentary, no leading or trailing text.`,
  ].join("\n");
}

type ParsedShape = { suggestions: unknown[] };

function isParsedShape(x: unknown): x is ParsedShape {
  return (
    typeof x === "object" &&
    x !== null &&
    Array.isArray((x as { suggestions?: unknown }).suggestions)
  );
}

/**
 * Robust extraction of the suggestions object from messy LLM output:
 *
 *   1. Try `JSON.parse` directly on the trimmed text.
 *   2. If that fails, look for a ```json ... ``` markdown fence and parse it.
 *   3. If that fails, find the outermost `{...}` block in the text.
 *
 * Returns undefined if none of the three find a parseable object with a
 * `suggestions` array.
 */
export function parseAgentResponse(text: string): ParsedShape | undefined {
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };

  let obj = tryParse(text);
  if (isParsedShape(obj)) return obj;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) {
    obj = tryParse(fenced[1]!.trim());
    if (isParsedShape(obj)) return obj;
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    obj = tryParse(text.slice(start, end + 1));
    if (isParsedShape(obj)) return obj;
  }

  return undefined;
}

/** Forbidden patch keys — defense in depth against a model trying to set them. */
const FORBIDDEN_PATCH_KEYS: ReadonlySet<string> = new Set(["id", "type", "agent_suggests"]);

export function coerceSuggestions(rawSuggestions: unknown[], input: GroomInput): Suggestion[] {
  const isoNow = input.now.toISOString();
  const byId = new Map(input.files.map((f) => [f.id, f] as const));
  const out: Suggestion[] = [];

  for (const raw of rawSuggestions) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;

    const taskId = typeof r.taskId === "string" ? r.taskId : undefined;
    if (!taskId) continue;
    const file = byId.get(taskId);
    if (!file) continue; // suggestion for missing task — drop silently

    if (typeof r.patch !== "object" || r.patch === null || Array.isArray(r.patch)) continue;
    const patchInput = r.patch as Record<string, unknown>;
    const safePatch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patchInput)) {
      if (FORBIDDEN_PATCH_KEYS.has(k)) continue;
      safePatch[k] = v;
    }
    if (Object.keys(safePatch).length === 0) continue;

    out.push({
      taskId,
      patch: safePatch,
      reason: typeof r.reason === "string" && r.reason.length > 0 ? r.reason : "(no reason given)",
      baseVersion: file.contentHash,
      provider: "hermes",
      createdAt: isoNow,
    });
  }
  return out;
}
