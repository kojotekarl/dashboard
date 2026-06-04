export type RunOptions = {
  timeoutMs: number;
  cwd?: string;
  env?: Record<string, string>;
};

export type RunResult = {
  /** True iff exit code is 0 AND we did not have to kill it on timeout. */
  ok: boolean;
  /** Process exit code; null if killed before exiting cleanly. */
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
};

/**
 * Injectable subprocess runner. Production wires `defaultRun`; tests pass a
 * stub so we don't depend on a `hermes` binary being present.
 */
export type RunFn = (cmd: string, args: string[], opts: RunOptions) => Promise<RunResult>;

/**
 * Run a subprocess to completion. Enforces a hard wall-clock budget: when
 * the timeout fires, the process is SIGKILL'd — no SIGTERM courtesy. This
 * matches what the eng review settled on (subagent #9): never let a wedged
 * `hermes -z` hang the groom endpoint.
 */
export const defaultRun: RunFn = async (cmd, args, opts) => {
  const started = Date.now();

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([cmd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    });
  } catch (err: unknown) {
    // ENOENT (binary not on PATH) and similar spawn failures: surface as a
    // structured failure result rather than an exception, so callers can fall
    // back consistently.
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: null,
      stdout: "",
      stderr: `spawn ${cmd}: ${msg}`,
      durationMs: Date.now() - started,
      timedOut: false,
    };
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      // already exited
    }
  }, opts.timeoutMs);

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);

  clearTimeout(timer);

  return {
    ok: code === 0 && !timedOut,
    code: timedOut ? null : (code as number | null),
    stdout,
    stderr,
    durationMs: Date.now() - started,
    timedOut,
  };
};

/**
 * Strip the common ANSI escape sequences agent CLIs love to spray into stdout.
 * Copy of the same regex agent-os uses in src/app/api/hermes/chat/route.ts so
 * our JSON parser sees clean text.
 */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\]\d+;[^\x07\x1b]*(\x07|\x1b\\)/g, "");
}
