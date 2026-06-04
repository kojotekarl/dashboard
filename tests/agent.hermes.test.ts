import { describe, expect, test } from "bun:test";
import type { AgentProvider, GroomInput, GroomResult } from "../server/agent/AgentProvider.ts";
import { CountingBreaker } from "../server/agent/breaker.ts";
import {
  HermesAgent,
  buildPrompt,
  coerceSuggestions,
  parseAgentResponse,
} from "../server/agent/HermesAgent.ts";
import type { RunFn, RunResult } from "../server/agent/runner.ts";
import type { TaskFile } from "../server/repo/TaskRepository.ts";

const NOW = new Date("2026-06-04T10:00:00Z");

function mkTask(id: string, overrides: Partial<Record<string, unknown>> = {}): TaskFile {
  const entity = {
    type: "task" as const,
    id,
    title: id,
    status: "backlog" as const,
    priority: "P1" as const,
    project: null,
    goal: null,
    due: null,
    scheduled: null,
    estimate: null,
    depends_on: [],
    order: "b",
    ...overrides,
  } as unknown as TaskFile["entity"];
  return {
    id,
    path: `/tmp/${id}.md`,
    relPath: `tasks/${id}.md`,
    entity,
    body: "",
    rawFrontmatter: entity as unknown as Record<string, unknown>,
    contentHash: `hash-${id}`,
  };
}

function mkRun(impls: ((cmd: string, args: string[]) => Partial<RunResult>)[]): RunFn {
  let i = 0;
  return async (cmd, args) => {
    if (i >= impls.length) throw new Error(`unexpected extra run call #${i + 1}`);
    const partial = impls[i++]!(cmd, args);
    return {
      ok: partial.ok ?? false,
      code: partial.code ?? 0,
      stdout: partial.stdout ?? "",
      stderr: partial.stderr ?? "",
      durationMs: partial.durationMs ?? 5,
      timedOut: partial.timedOut ?? false,
    };
  };
}

class FixedMockAgent implements AgentProvider {
  readonly name = "mock" as const;
  constructor(private readonly result: GroomResult) {}
  async groom(_: GroomInput): Promise<GroomResult> {
    return {
      suggestions: [...this.result.suggestions],
      ...(this.result.summary !== undefined ? { summary: this.result.summary } : {}),
    };
  }
}

const EMPTY_MOCK = new FixedMockAgent({ suggestions: [], summary: "mock-empty" });

const validResponse = JSON.stringify({
  suggestions: [
    { taskId: "t-1", patch: { status: "today" }, reason: "important" },
  ],
});

describe("HermesAgent — happy paths", () => {
  test("parses valid JSON and tags suggestions with provider=hermes", async () => {
    const agent = new HermesAgent({
      fallback: EMPTY_MOCK,
      run: mkRun([() => ({ ok: true, code: 0, stdout: validResponse })]),
    });
    const result = await agent.groom({ files: [mkTask("t-1")], now: NOW });
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]!.provider).toBe("hermes");
    expect(result.suggestions[0]!.patch).toEqual({ status: "today" });
    expect(result.suggestions[0]!.baseVersion).toBe("hash-t-1");
    expect(result.summary).toMatch(/Hermes proposed/);
  });

  test("extracts JSON from a ```json fenced response", async () => {
    const agent = new HermesAgent({
      fallback: EMPTY_MOCK,
      run: mkRun([() => ({ ok: true, code: 0, stdout: `Here is your plan:\n\n\`\`\`json\n${validResponse}\n\`\`\`\nDone.` })]),
    });
    const result = await agent.groom({ files: [mkTask("t-1")], now: NOW });
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]!.provider).toBe("hermes");
  });

  test("extracts the outer { ... } when there are no fences but prose surrounds the JSON", async () => {
    const agent = new HermesAgent({
      fallback: EMPTY_MOCK,
      run: mkRun([() => ({ ok: true, code: 0, stdout: `Sure thing! ${validResponse} -- hope that helps.` })]),
    });
    const result = await agent.groom({ files: [mkTask("t-1")], now: NOW });
    expect(result.suggestions).toHaveLength(1);
  });

  test("repair retry: garbage on first call, valid JSON on second", async () => {
    const agent = new HermesAgent({
      fallback: EMPTY_MOCK,
      run: mkRun([
        () => ({ ok: true, code: 0, stdout: "I cannot comply." }),
        () => ({ ok: true, code: 0, stdout: validResponse }),
      ]),
    });
    const result = await agent.groom({ files: [mkTask("t-1")], now: NOW });
    expect(result.suggestions).toHaveLength(1);
    expect(result.summary).toMatch(/Hermes proposed/);
  });
});

describe("HermesAgent — failure paths fall back to the mock", () => {
  test("timeout → fallback + breaker++", async () => {
    const breaker = new CountingBreaker(3);
    const agent = new HermesAgent({
      fallback: EMPTY_MOCK,
      breaker,
      run: mkRun([() => ({ timedOut: true, ok: false, code: null, stderr: "" })]),
    });
    const result = await agent.groom({ files: [], now: NOW });
    expect(result.suggestions).toEqual([]);
    expect(result.summary).toMatch(/Hermes failed.*timed out/);
    expect(breaker.failures).toBe(1);
    expect(breaker.isOpen()).toBe(false);
  });

  test("non-zero exit → fallback + breaker++", async () => {
    const breaker = new CountingBreaker(3);
    const agent = new HermesAgent({
      fallback: EMPTY_MOCK,
      breaker,
      run: mkRun([() => ({ ok: false, code: 2, stderr: "boom" })]),
    });
    const result = await agent.groom({ files: [], now: NOW });
    expect(result.summary).toMatch(/Hermes failed: exit 2/);
    expect(breaker.failures).toBe(1);
  });

  test("empty stdout → fallback + breaker++", async () => {
    const breaker = new CountingBreaker(3);
    const agent = new HermesAgent({
      fallback: EMPTY_MOCK,
      breaker,
      run: mkRun([() => ({ ok: true, code: 0, stdout: "" })]),
    });
    const result = await agent.groom({ files: [], now: NOW });
    expect(result.summary).toMatch(/empty stdout/);
    expect(breaker.failures).toBe(1);
  });

  test("garbage on both attempts → repair retry fails → fallback + breaker++", async () => {
    const breaker = new CountingBreaker(3);
    const agent = new HermesAgent({
      fallback: EMPTY_MOCK,
      breaker,
      run: mkRun([
        () => ({ ok: true, code: 0, stdout: "no json here" }),
        () => ({ ok: true, code: 0, stdout: "still no json" }),
      ]),
    });
    const result = await agent.groom({ files: [], now: NOW });
    expect(result.summary).toMatch(/could not parse JSON/);
    expect(breaker.failures).toBe(1);
  });

  test("fallback summary is wrapped, fallback suggestions pass through verbatim", async () => {
    const mock = new FixedMockAgent({
      suggestions: [
        { taskId: "t-mock", patch: { status: "today" }, reason: "mock-only", baseVersion: "h", provider: "mock", createdAt: NOW.toISOString() },
      ],
      summary: "Mock summary",
    });
    const agent = new HermesAgent({
      fallback: mock,
      run: mkRun([() => ({ ok: false, code: 1, stderr: "" })]),
    });
    const result = await agent.groom({ files: [mkTask("t-mock")], now: NOW });
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]!.provider).toBe("mock");
    expect(result.summary).toMatch(/Mock summary/);
    expect(result.summary).toMatch(/using mock/);
  });
});

describe("HermesAgent — breaker", () => {
  test("opens after 3 consecutive failures; subsequent calls skip hermes entirely", async () => {
    const breaker = new CountingBreaker(3);
    let callsToHermes = 0;
    const run: RunFn = async () => {
      callsToHermes++;
      return { ok: false, code: 1, stdout: "", stderr: "", durationMs: 1, timedOut: false };
    };
    const agent = new HermesAgent({ fallback: EMPTY_MOCK, breaker, run });

    await agent.groom({ files: [], now: NOW });
    await agent.groom({ files: [], now: NOW });
    await agent.groom({ files: [], now: NOW });
    expect(breaker.isOpen()).toBe(true);
    expect(callsToHermes).toBe(3);

    const result = await agent.groom({ files: [], now: NOW });
    expect(callsToHermes).toBe(3); // no extra hermes call once open
    expect(result.summary).toMatch(/circuit open/);
  });

  test("success between failures resets the failure counter (not the open state)", async () => {
    const breaker = new CountingBreaker(3);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.failures).toBe(2);
    breaker.recordSuccess();
    expect(breaker.failures).toBe(0);
    expect(breaker.isOpen()).toBe(false);
  });

  test("reset() force-closes the breaker", () => {
    const breaker = new CountingBreaker(2);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(true);
    breaker.reset();
    expect(breaker.isOpen()).toBe(false);
    expect(breaker.failures).toBe(0);
  });
});

describe("coerceSuggestions — defense in depth", () => {
  test("filters out suggestions whose taskId is not in the input files", async () => {
    const out = coerceSuggestions(
      [
        { taskId: "t-real", patch: { status: "today" }, reason: "x" },
        { taskId: "t-ghost", patch: { status: "today" }, reason: "x" },
      ],
      { files: [mkTask("t-real")], now: NOW },
    );
    expect(out.map((s) => s.taskId)).toEqual(["t-real"]);
  });

  test("strips forbidden patch keys (id, type, pepper_suggests)", async () => {
    const out = coerceSuggestions(
      [
        { taskId: "t-1", patch: { status: "today", id: "evil", type: "rocket", pepper_suggests: {} }, reason: "x" },
      ],
      { files: [mkTask("t-1")], now: NOW },
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.patch).toEqual({ status: "today" });
  });

  test("drops suggestions whose patch becomes empty after stripping", async () => {
    const out = coerceSuggestions(
      [{ taskId: "t-1", patch: { id: "x", type: "y" }, reason: "x" }],
      { files: [mkTask("t-1")], now: NOW },
    );
    expect(out).toEqual([]);
  });

  test("drops malformed suggestion shapes (no taskId, non-object patch, null, etc.)", async () => {
    const out = coerceSuggestions(
      [
        null,
        "string",
        { patch: { status: "today" } },           // no taskId
        { taskId: "t-1", patch: null },           // null patch
        { taskId: "t-1", patch: ["array"] },      // array patch
        { taskId: 42, patch: { status: "today" } }, // wrong-typed taskId
      ],
      { files: [mkTask("t-1")], now: NOW },
    );
    expect(out).toEqual([]);
  });
});

describe("parseAgentResponse", () => {
  test("direct JSON parse", () => {
    expect(parseAgentResponse('{"suggestions": []}')).toEqual({ suggestions: [] });
  });
  test("rejects an object without a suggestions array", () => {
    expect(parseAgentResponse('{"wrong": "shape"}')).toBeUndefined();
  });
  test("strips ``` markdown fences", () => {
    expect(parseAgentResponse('```json\n{"suggestions": [1]}\n```')).toEqual({ suggestions: [1] });
  });
  test("extracts the outer {...} when surrounded by prose", () => {
    const r = parseAgentResponse('Sure: {"suggestions": [{"taskId":"x"}]} done');
    expect(r).toEqual({ suggestions: [{ taskId: "x" }] });
  });
  test("returns undefined when no JSON is present", () => {
    expect(parseAgentResponse("nothing useful here")).toBeUndefined();
  });
});

describe("buildPrompt", () => {
  test("includes today's date and every input file id", () => {
    const prompt = buildPrompt({ files: [mkTask("t-1"), mkTask("t-2")], now: NOW });
    expect(prompt).toContain("Today is 2026-06-04");
    expect(prompt).toContain('"t-1"');
    expect(prompt).toContain('"t-2"');
    expect(prompt).toContain("STRICT JSON only");
  });
});
