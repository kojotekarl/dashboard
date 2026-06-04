import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Kanban, type MovePatch } from "./components/Kanban.tsx";
import { api, ApiError } from "./lib/api.ts";
import { OptimisticTracker } from "./lib/optimistic.ts";
import type { ApiTaskFile, ParseWarning, ServerMessage } from "./lib/types.ts";
import { type ConnectionState, DashboardWS } from "./lib/ws.ts";
import { dashboardWsUrl } from "./lib/wsUrl.ts";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; files: ApiTaskFile[]; warnings: ParseWarning[] }
  | { kind: "error"; message: string };

type GroomState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ok"; summary: string; provider: "mock" | "hermes"; count: number }
  | { kind: "error"; message: string };

export function App() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [connection, setConnection] = useState<ConnectionState>("closed");
  const [lastEvent, setLastEvent] = useState<ServerMessage | null>(null);
  const [groom, setGroom] = useState<GroomState>({ kind: "idle" });
  const [moveError, setMoveError] = useState<string | null>(null);

  // Latest files snapshot — used for revert on drag-PATCH failure.
  const filesRef = useRef<ApiTaskFile[] | null>(null);
  useEffect(() => {
    filesRef.current = state.kind === "ready" ? state.files : null;
  }, [state]);

  const tracker = useMemo(() => new OptimisticTracker(), []);

  const refetch = useCallback(async () => {
    const res = await api.listTasks();
    for (const f of res.files) tracker.record(f.contentHash);
    setState({ kind: "ready", files: res.files, warnings: res.warnings });
  }, [tracker]);

  const onGroom = useCallback(async () => {
    setGroom({ kind: "running" });
    try {
      const res = await api.groom();
      for (const s of res.suggestions) tracker.record(s.file.contentHash);
      await refetch();
      setGroom({
        kind: "ok",
        summary: res.summary ?? `${res.suggestions.length} change${res.suggestions.length === 1 ? "" : "s"} proposed.`,
        provider: res.provider,
        count: res.suggestions.length,
      });
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? `${err.status} ${err.message}` : String(err);
      setGroom({ kind: "error", message: msg });
    }
  }, [refetch, tracker]);

  const onMove = useCallback(
    async (taskId: string, patch: MovePatch) => {
      const snapshot = filesRef.current;
      if (snapshot === null) return;

      // Optimistic: apply locally so the card stays in its new column / position.
      setState((prev) =>
        prev.kind === "ready"
          ? { ...prev, files: prev.files.map((f) => mergeOptimistic(f, taskId, patch)) }
          : prev,
      );
      setMoveError(null);

      try {
        const updated = await api.patchTask(taskId, patch);
        tracker.record(updated.contentHash);
        setState((prev) =>
          prev.kind === "ready"
            ? { ...prev, files: prev.files.map((f) => (f.id === taskId ? updated : f)) }
            : prev,
        );
      } catch (err: unknown) {
        // Revert to the pre-drag state and surface the error.
        setState((prev) => (prev.kind === "ready" ? { ...prev, files: snapshot } : prev));
        const msg = err instanceof ApiError ? `${err.status} ${err.message}` : String(err);
        setMoveError(msg);
      }
    },
    [tracker],
  );

  useEffect(() => {
    let cancelled = false;
    refetch().catch((err: unknown) => {
      if (cancelled) return;
      const msg = err instanceof ApiError ? `${err.status} ${err.message}` : String(err);
      setState({ kind: "error", message: msg });
    });
    return () => {
      cancelled = true;
    };
  }, [refetch]);

  useEffect(() => {
    const ws = new DashboardWS(dashboardWsUrl());
    const offState = ws.onState(setConnection);
    const offMsg = ws.onMessage((msg) => {
      if (msg.type === "file_event" && tracker.isEcho(msg.event.contentHash)) return;
      setLastEvent(msg);
      if (msg.type === "file_event") {
        void refetch();
      }
    });
    ws.start();
    return () => {
      offState();
      offMsg();
      ws.stop();
    };
  }, [tracker, refetch]);

  const tasks = state.kind === "ready" ? state.files.filter(isTaskLike) : [];
  const goalCount = state.kind === "ready" ? state.files.filter((f) => f.entity.type === "goal").length : 0;
  const projectCount = state.kind === "ready" ? state.files.filter((f) => f.entity.type === "project").length : 0;

  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <h1 style={styles.h1}>Pepper Dashboard</h1>
        <ConnectionBadge state={connection} />
        <button
          type="button"
          onClick={() => void onGroom()}
          disabled={groom.kind === "running"}
          style={{ ...styles.groomBtn, ...(groom.kind === "running" ? styles.groomBtnRunning : {}) }}
        >
          {groom.kind === "running" ? "Grooming…" : "Groom my day"}
        </button>
      </header>

      <GroomStatus state={groom} />
      {moveError !== null && (
        <p style={{ ...styles.groomMsg, ...styles.groomErr }}>
          Move failed (reverted): {moveError}
        </p>
      )}

      {state.kind === "loading" && <p>Loading vault…</p>}
      {state.kind === "error" && (
        <pre style={styles.error}>
          Could not load /api/tasks:{"\n"}
          {state.message}
        </pre>
      )}
      {state.kind === "ready" && (
        <>
          <p style={styles.summary}>
            {tasks.length} task{tasks.length === 1 ? "" : "s"}, {goalCount} goal{goalCount === 1 ? "" : "s"},{" "}
            {projectCount} project{projectCount === 1 ? "" : "s"}.
            {state.warnings.length > 0 && (
              <span style={styles.warning}>
                {" "}· {state.warnings.length} parse warning{state.warnings.length === 1 ? "" : "s"}
              </span>
            )}
          </p>
          <Kanban tasks={tasks} onMove={onMove} />
        </>
      )}

      {lastEvent !== null && (
        <footer style={styles.footer}>
          last event:{" "}
          <code>
            {lastEvent.type === "file_event"
              ? `${lastEvent.event.kind} ${lastEvent.event.relPath}`
              : `hello (${lastEvent.clients})`}
          </code>
        </footer>
      )}
    </main>
  );
}

function ConnectionBadge({ state }: { state: ConnectionState }) {
  const color = state === "open" ? "#1f8a3d" : state === "connecting" ? "#b07e00" : "#9a1f1f";
  return <span style={{ ...styles.badge, background: color }}>ws: {state}</span>;
}

function GroomStatus({ state }: { state: GroomState }) {
  if (state.kind === "idle") return null;
  if (state.kind === "running") return <p style={styles.groomMsg}>Pepper is thinking…</p>;
  if (state.kind === "error") {
    return <p style={{ ...styles.groomMsg, ...styles.groomErr }}>Groom failed: {state.message}</p>;
  }
  const tag = state.provider === "hermes" ? "Live Hermes" : "Mock";
  return (
    <p style={{ ...styles.groomMsg, ...styles.groomOk }}>
      <strong>{tag}</strong> · {state.summary}{" "}
      {state.count > 0 && (
        <span style={styles.groomHint}>(cards with proposals are outlined in gold)</span>
      )}
    </p>
  );
}

function isTaskLike(f: ApiTaskFile): boolean {
  return f.entity.type === "task" || f.entity.type === "learning-step" || f.entity.type === "routine";
}

/** Apply an optimistic patch to a file. Only known-safe fields are merged. */
function mergeOptimistic(f: ApiTaskFile, taskId: string, patch: MovePatch): ApiTaskFile {
  if (f.id !== taskId) return f;
  const e = f.entity;
  if (e.type !== "task" && e.type !== "learning-step" && e.type !== "routine") return f;
  const nextEntity = {
    ...e,
    order: patch.order,
    ...(patch.status !== undefined ? { status: patch.status } : {}),
  };
  return { ...f, entity: nextEntity as ApiTaskFile["entity"] };
}

const styles: Record<string, CSSProperties> = {
  main: { padding: "2rem", maxWidth: 1400, margin: "0 auto" },
  header: { display: "flex", alignItems: "center", gap: "1rem", marginBottom: "1.5rem" },
  h1: { margin: 0, fontSize: "1.5rem" },
  badge: {
    color: "white",
    padding: "0.15rem 0.6rem",
    borderRadius: "999px",
    fontSize: "0.8rem",
    fontFamily: "ui-monospace, SFMono-Regular, monospace",
  },
  groomBtn: {
    marginLeft: "auto",
    background: "#b07e00",
    color: "white",
    border: "none",
    padding: "0.45rem 0.9rem",
    borderRadius: 6,
    fontSize: "0.9rem",
    fontWeight: 500,
    cursor: "pointer",
  },
  groomBtnRunning: { opacity: 0.6, cursor: "wait" },
  groomMsg: {
    margin: "0.5rem 0 1rem",
    padding: "0.6rem 0.8rem",
    borderRadius: 6,
    fontSize: "0.9rem",
    background: "rgba(176,126,0,0.1)",
    border: "1px solid rgba(176,126,0,0.4)",
  },
  groomOk: { color: "#b07e00" },
  groomErr: {
    background: "rgba(154,31,31,0.1)",
    border: "1px solid rgba(154,31,31,0.5)",
    color: "#9a1f1f",
  },
  groomHint: { opacity: 0.7, fontSize: "0.8rem" },
  summary: { color: "#888", fontSize: "0.9rem" },
  warning: { color: "#b07e00" },
  error: {
    background: "#3a1010",
    color: "#fff",
    padding: "1rem",
    borderRadius: 4,
    whiteSpace: "pre-wrap",
  },
  footer: {
    marginTop: "2rem",
    fontSize: "0.75rem",
    color: "#888",
    fontFamily: "ui-monospace, SFMono-Regular, monospace",
  },
};
