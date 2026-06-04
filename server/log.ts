type Level = "debug" | "info" | "warn" | "error";

const SHOULD_LOG: Record<Level, boolean> = {
  debug: process.env.LOG_LEVEL === "debug",
  info: true,
  warn: true,
  error: true,
};

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (!SHOULD_LOG[level]) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  });
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};
