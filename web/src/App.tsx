import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BatchReviewModal, type SuggestionRow } from "./components/BatchReviewModal.tsx";
import { Kanban, type MovePatch } from "./components/Kanban.tsx";
import { api, ApiError } from "./lib/api.ts";
import { OptimisticTracker } from "./lib/optimistic.ts";
import type { AgentProviderName, ApiTaskFile, ParseWarning, ServerMessage } from "./lib/types.ts";
import { type ConnectionState, DashboardWS } from "./lib/ws.ts";
import { dashboardWsUrl } from "./lib/wsUrl.ts";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; files: ApiTaskFile[]; warnings: ParseWarning[] }
  | { kind: "error"; message: string };

type GroomState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ok"; summary: string; provider: AgentProviderName; count: number }
  | { kind: "error"; message: string };

export function App() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [connection, setConnection] = useState<ConnectionState>("closed");
  const [lastEvent, setLastEvent] = useState<ServerMessage | null>(null);
  const [groom, setGroom] = useState<GroomState>({ kind: "idle" });
  const [moveError, setMoveError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalBusy, setModalBusy] = useState(false);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  // Provider of the most recent groom, kept across the modal lifetime so the
  // badge stays accurate even after the user closes and re-opens it.
  const [lastProvider, setLastProvider] = useState<AgentProviderName | null>(null);

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

  // ─── pending suggestions derived from current state ─────────────
  const pendingRows = useMemo<SuggestionRow[]>(() => {
    if (state.kind !== "ready") return [];
    const out: SuggestionRow[] = [];
    for (const f of state.files) {
      const e = f.entity;
      const sugg = "pepper_suggests" in e ? e.pepper_suggests : undefined;
      if (sugg === undefined) continue;
      out.push({
        taskId: f.id,
        taskTitle: e.title,
        patch: sugg.patch,
        reason: sugg.reason,
        baseVersion: sugg.base_version,
        provider: sugg.provider,
        contentHash: f.contentHash,
      });
    }
    return out;
  }, [state]);

  // Auto-close modal when nothing remains to review.
  useEffect(() => {
    if (modalOpen && pendingRows.length === 0) setModalOpen(false);
  }, [modalOpen, pendingRows.length]);

  // ─── handlers ──────────────────────────────────────────────────

  const onGroom = useCallback(async () => {
    setGroom({ kind: "running" });
    setRowErrors({});
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
      setLastProvider(res.provider);
      if (res.suggestions.length > 0) setModalOpen(true);
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? `${err.status} ${err.message}` : String(err);
      setGroom({ kind: "error", message: msg });
    }
  }, [refetch, tracker]);

  const replaceFile = useCallback((updated: ApiTaskFile) => {
    setState((prev) =>
      prev.kind === "ready"
        ? { ...prev, files: prev.files.map((f) => (f.id === updated.id ? updated : f)) }
        : prev,
    );
  }, []);

  const clearRowError = useCallback((taskId: string) => {
    setRowErrors((prev) => {
      if (!(taskId in prev)) return prev;
      const { [taskId]: _drop, ...rest } = prev;
      return rest;
    });
  }, []);

  const onApprove = useCallback(
    async (taskId: string) => {
      clearRowError(taskId);
      setModalBusy(true);
      try {
        const updated = await api.approveSuggestion(taskId);
        tracker.record(updated.contentHash);
        replaceFile(updated);
      } catch (err: unknown) {
        if (err instanceof ApiError && err.status === 409) {
          // Suggestion is stale — server already explained which hash mismatched.
          // Refetch so the modal can show the updated row as stale.
          await refetch();
          setRowErrors((prev) => ({ ...prev, [taskId]: "Stale — the file changed since this was proposed." }));
        } else {
          const msg = err instanceof ApiError ? `${err.status} ${err.message}` : String(err);
          setRowErrors((prev) => ({ ...prev, [taskId]: msg }));
        }
      } finally {
        setModalBusy(false);
      }
    },
    [clearRowError, refetch, replaceFile, tracker],
  );

  const onDismiss = useCallback(
    async (taskId: string) => {
      clearRowError(taskId);
      setModalBusy(true);
      try {
        const updated = await api.dismissSuggestion(taskId);
        tracker.record(updated.contentHash);
        replaceFile(updated);
      } catch (err: unknown) {
        const msg = err instanceof ApiError ? `${err.status} ${err.message}` : String(err);
        setRowErrors((prev) => ({ ...prev, [taskId]: msg }));
      } finally {
        setModalBusy(false);
      }
    },
    [clearRowError, replaceFile, tracker],
  );

  const onApproveAll = useCallback(async () => {
    setRowErrors({});
    setModalBusy(true);
    try {
      const res = await api.approveAll();
      if (res.ok) {
        for (const f of res.applied) tracker.record(f.contentHash);
        setState((prev) => {
          if (prev.kind !== "ready") return prev;
          const byId = new Map(res.applied.map((f) => [f.id, f] as const));
          return { ...prev, files: prev.files.map((f) => byId.get(f.id) ?? f) };
        });
      } else if ("stale" in res) {
        // Pre-validation rejected — no writes happened. Refetch + mark stale rows.
        await refetch();
        const errs: Record<string, string> = {};
        for (const s of res.stale) errs[s.taskId] = "Stale — dismiss this row or refresh.";
        setRowErrors(errs);
      } else {
        // Mid-loop partial-failure path (server returned applied + remaining).
        for (const f of res.applied) tracker.record(f.contentHash);
        await refetch();
        setRowErrors({ "__batch__": res.error });
      }
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? `${err.status} ${err.message}` : String(err);
      setRowErrors({ "__batch__": msg });
    } finally {
      setModalBusy(false);
    }
  }, [refetch, tracker]);

  const onDismissAll = useCallback(async () => {
    // The server has no batch-dismiss endpoint. Dismiss is always safe
    // (no staleness gate, no patch applied), so doing it in parallel is fine.
    setRowErrors({});
    setModalBusy(true);
    const ids = pendingRows.map((r) => r.taskId);
    try {
      const results = await Promise.allSettled(ids.map((id) => api.dismissSuggestion(id)));
      const next: Record<string, string> = {};
      for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        if (r.status === "fulfilled") {
          tracker.record(r.value.contentHash);
        } else {
          const id = ids[i]!;
          const e = r.reason as unknown;
          next[id] = e instanceof ApiError ? `${e.status} ${e.message}` : String(e);
        }
      }
      await refetch();
      setRowErrors(next);
    } finally {
      setModalBusy(false);
    }
  }, [pendingRows, refetch, tracker]);

  const onMove = useCallback(
    async (taskId: string, patch: MovePatch) => {
      const snapshot = filesRef.current;
      if (snapshot === null) return;
      setState((prev) =>
        prev.kind === "ready"
          ? { ...prev, files: prev.files.map((f) => mergeOptimistic(f, taskId, patch)) }
          : prev,
      );
      setMoveError(null);

      try {
        const updated = await api.patchTask(taskId, patch);
        tracker.record(updated.contentHash);
        replaceFile(updated);
      } catch (err: unknown) {
        setState((prev) => (prev.kind === "ready" ? { ...prev, files: snapshot } : prev));
        const msg = err instanceof ApiError ? `${err.status} ${err.message}` : String(err);
        setMoveError(msg);
      }
    },
    [replaceFile, tracker],
  );

  // ─── effects ───────────────────────────────────────────────────

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

  // ─── render ────────────────────────────────────────────────────

  const tasks = state.kind === "ready" ? state.files.filter(isTaskLike) : [];
  const goalCount = state.kind === "ready" ? state.files.filter((f) => f.entity.type === "goal").length : 0;
  const projectCount = state.kind === "ready" ? state.files.filter((f) => f.entity.type === "project").length : 0;
  const batchError = rowErrors["__batch__"];

  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <h1 style={styles.h1}>Pepper Dashboard</h1>
        <ConnectionBadge state={connection} />
        {pendingRows.length > 0 && !modalOpen && (
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            style={styles.reviewBtn}
          >
            Review {pendingRows.length} suggestion{pendingRows.length === 1 ? "" : "s"}
          </button>
        )}
        <button
          type="button"
          onClick={() => void onGroom()}
          disabled={groom.kind === "running"}
          style={{
            ...styles.groomBtn,
            ...(groom.kind === "running" ? styles.groomBtnRunning : {}),
            ...(pendingRows.length > 0 && !modalOpen ? {} : styles.groomBtnFirst),
          }}
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

      <BatchReviewModal
        open={modalOpen}
        rows={pendingRows}
        provider={lastProvider ?? (pendingRows[0]?.provider ?? null)}
        busy={modalBusy}
        errors={rowErrors}
        onApprove={(id) => void onApprove(id)}
        onDismiss={(id) => void onDismiss(id)}
        onApproveAll={() => void onApproveAll()}
        onDismissAll={() => void onDismissAll()}
        onClose={() => setModalOpen(false)}
      />
      {batchError !== undefined && !modalOpen && (
        <p style={{ ...styles.groomMsg, ...styles.groomErr }}>Batch error: {batchError}</p>
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
        <span style={styles.groomHint}>(review opened — approve or dismiss each)</span>
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
  reviewBtn: {
    marginLeft: "auto",
    background: "transparent",
    color: "#b07e00",
    border: "1px solid #b07e00",
    padding: "0.45rem 0.9rem",
    borderRadius: 6,
    fontSize: "0.9rem",
    fontWeight: 500,
    cursor: "pointer",
  },
  groomBtn: {
    background: "#b07e00",
    color: "white",
    border: "none",
    padding: "0.45rem 0.9rem",
    borderRadius: 6,
    fontSize: "0.9rem",
    fontWeight: 500,
    cursor: "pointer",
  },
  groomBtnFirst: { marginLeft: "auto" },
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
