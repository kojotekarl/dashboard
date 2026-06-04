import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./lib/api.ts";
import { OptimisticTracker } from "./lib/optimistic.ts";
import type { ApiTaskFile, ParseWarning, ServerMessage } from "./lib/types.ts";
import { type ConnectionState, DashboardWS } from "./lib/ws.ts";
import { dashboardWsUrl } from "./lib/wsUrl.ts";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; files: ApiTaskFile[]; warnings: ParseWarning[] }
  | { kind: "error"; message: string };

const COLUMN_ORDER = ["backlog", "today", "in-progress", "blocked", "done"] as const;

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

  // Tracker is created once per app instance; never recreated on re-render.
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
      // Record the new contentHashes so the echo dedupe knows about them.
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
      // Drop echoes of our own writes via the contentHash version token.
      if (msg.type === "file_event" && tracker.isEcho(msg.event.contentHash)) return;
      setLastEvent(msg);
      // Hand-edits and other-client writes land here; refresh the board.
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

  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <h1 style={styles.h1}>Pepper Dashboard</h1>
        <ConnectionBadge state={connection} />
        <button
          type="button"
          onClick={() => void onGroom()}
          disabled={groom.kind === "running"}
          style={{
            ...styles.groomBtn,
            ...(groom.kind === "running" ? styles.groomBtnRunning : {}),
          }}
        >
          {groom.kind === "running" ? "Grooming…" : "Groom my day"}
        </button>
      </header>

      <GroomStatus state={groom} />

      {state.kind === "loading" && <p>Loading vault…</p>}
      {state.kind === "error" && (
        <pre style={styles.error}>Could not load /api/tasks:{"\n"}{state.message}</pre>
      )}
      {state.kind === "ready" && <Board files={state.files} warnings={state.warnings} />}

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
      {state.count > 0 && <span style={styles.groomHint}>(scroll the board — cards with proposals are outlined in gold)</span>}
    </p>
  );
}

function ConnectionBadge({ state }: { state: ConnectionState }) {
  const color = state === "open" ? "#1f8a3d" : state === "connecting" ? "#b07e00" : "#9a1f1f";
  return (
    <span style={{ ...styles.badge, background: color }}>
      ws: {state}
    </span>
  );
}

function Board({ files, warnings }: { files: ApiTaskFile[]; warnings: ParseWarning[] }) {
  const tasks = files.filter(
    (f) => f.entity.type === "task" || f.entity.type === "learning-step" || f.entity.type === "routine",
  );
  const others = files.filter(
    (f) => f.entity.type === "goal" || f.entity.type === "project",
  );

  return (
    <div>
      <p style={styles.summary}>
        {tasks.length} task{tasks.length === 1 ? "" : "s"},{" "}
        {others.filter((f) => f.entity.type === "goal").length} goal
        {others.filter((f) => f.entity.type === "goal").length === 1 ? "" : "s"},{" "}
        {others.filter((f) => f.entity.type === "project").length} project
        {others.filter((f) => f.entity.type === "project").length === 1 ? "" : "s"}.
        {warnings.length > 0 && (
          <span style={styles.warning}> · {warnings.length} parse warning{warnings.length === 1 ? "" : "s"}</span>
        )}
      </p>

      <div style={styles.board}>
        {COLUMN_ORDER.map((status) => {
          const inColumn = tasks.filter((f) => "status" in f.entity && f.entity.status === status);
          return (
            <section key={status} style={styles.column}>
              <h2 style={styles.colHead}>
                {status} <span style={styles.colCount}>{inColumn.length}</span>
              </h2>
              {inColumn.length === 0 ? (
                <p style={styles.empty}>—</p>
              ) : (
                inColumn.map((f) => <Card key={f.id} file={f} />)
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function Card({ file }: { file: ApiTaskFile }) {
  const e = file.entity;
  if (e.type !== "task" && e.type !== "learning-step" && e.type !== "routine") return null;
  const hasSuggestion = e.pepper_suggests !== undefined;
  return (
    <article style={{ ...styles.card, ...(hasSuggestion ? styles.cardWithSuggestion : {}) }}>
      <header style={styles.cardHead}>
        <span style={styles.cardPriority}>{e.priority}</span>
        <strong style={styles.cardTitle}>{e.title}</strong>
      </header>
      <div style={styles.cardMeta}>
        {e.project !== null && <span>project: {e.project}</span>}
        {e.goal !== null && <span> · goal: {e.goal}</span>}
        {e.due !== null && <span> · due: {e.due}</span>}
      </div>
      {hasSuggestion && (
        <div style={styles.suggestion}>
          Pepper suggests: <code>{JSON.stringify(e.pepper_suggests!.patch)}</code> —{" "}
          {e.pepper_suggests!.reason}
        </div>
      )}
    </article>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: { padding: "2rem", maxWidth: 1400, margin: "0 auto" },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "1rem",
    marginBottom: "1.5rem",
  },
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
    borderRadius: "6px",
    fontSize: "0.9rem",
    fontWeight: 500,
    cursor: "pointer",
  },
  groomBtnRunning: { opacity: 0.6, cursor: "wait" },
  groomMsg: {
    margin: "0.5rem 0 1rem",
    padding: "0.6rem 0.8rem",
    borderRadius: "6px",
    fontSize: "0.9rem",
    background: "rgba(176,126,0,0.1)",
    border: "1px solid rgba(176,126,0,0.4)",
  },
  groomOk: { color: "#b07e00" },
  groomErr: { background: "rgba(154,31,31,0.1)", border: "1px solid rgba(154,31,31,0.5)", color: "#9a1f1f" },
  groomHint: { opacity: 0.7, fontSize: "0.8rem" },
  summary: { color: "#888", fontSize: "0.9rem" },
  warning: { color: "#b07e00" },
  board: {
    display: "grid",
    gridTemplateColumns: "repeat(5, 1fr)",
    gap: "0.75rem",
  },
  column: {
    background: "rgba(127,127,127,0.07)",
    borderRadius: "8px",
    padding: "0.75rem",
    minHeight: 200,
  },
  colHead: {
    margin: "0 0 0.75rem",
    fontSize: "0.85rem",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "#888",
    display: "flex",
    justifyContent: "space-between",
  },
  colCount: { fontWeight: "normal", opacity: 0.6 },
  empty: { color: "#aaa", fontSize: "0.85rem", margin: 0 },
  card: {
    background: "var(--card-bg, white)",
    border: "1px solid rgba(127,127,127,0.2)",
    borderRadius: "6px",
    padding: "0.6rem 0.75rem",
    marginBottom: "0.5rem",
    fontSize: "0.9rem",
  },
  cardWithSuggestion: {
    boxShadow: "0 0 0 2px rgba(176,126,0,0.35)",
  },
  cardHead: { display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.3rem" },
  cardPriority: {
    fontSize: "0.7rem",
    background: "rgba(127,127,127,0.18)",
    padding: "0.1rem 0.4rem",
    borderRadius: "3px",
    fontFamily: "ui-monospace, SFMono-Regular, monospace",
  },
  cardTitle: { fontSize: "0.95rem" },
  cardMeta: { color: "#888", fontSize: "0.78rem" },
  suggestion: {
    marginTop: "0.4rem",
    paddingTop: "0.4rem",
    borderTop: "1px dashed rgba(176,126,0,0.4)",
    fontSize: "0.78rem",
    color: "#b07e00",
  },
  error: {
    background: "#3a1010",
    color: "#fff",
    padding: "1rem",
    borderRadius: "4px",
    whiteSpace: "pre-wrap",
  },
  footer: {
    marginTop: "2rem",
    fontSize: "0.75rem",
    color: "#888",
    fontFamily: "ui-monospace, SFMono-Regular, monospace",
  },
};
