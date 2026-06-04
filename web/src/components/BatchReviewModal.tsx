import type { CSSProperties } from "react";
import { useState } from "react";
import type { AgentProviderName } from "../lib/types.ts";

export type SuggestionRow = {
  taskId: string;
  taskTitle: string;
  patch: Record<string, unknown>;
  reason: string;
  baseVersion: string;
  provider: AgentProviderName;
  /** Current contentHash of the file. Stale if !== baseVersion. */
  contentHash: string;
};

export type BatchReviewModalProps = {
  open: boolean;
  rows: SuggestionRow[];
  /** Provider tag for the banner. Null when the modal is opened without a fresh groom. */
  provider: AgentProviderName | null;
  /** True while at least one server call is in flight from this modal. */
  busy: boolean;
  /** Per-row error keyed by taskId. Cleared on next successful action for that row. */
  errors: Record<string, string>;
  onApprove: (taskId: string) => void;
  onDismiss: (taskId: string) => void;
  onApproveAll: () => void;
  onDismissAll: () => void;
  onClose: () => void;
};

export function BatchReviewModal(props: BatchReviewModalProps) {
  const {
    open, rows, provider, busy, errors,
    onApprove, onDismiss, onApproveAll, onDismissAll, onClose,
  } = props;

  if (!open) return null;

  const staleIds = new Set(rows.filter((r) => r.baseVersion !== r.contentHash).map((r) => r.taskId));
  const anyStale = staleIds.size > 0;

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div style={styles.dialog} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header style={styles.header}>
          <h2 style={styles.title}>Agent's suggestions</h2>
          {provider !== null && (
            <span style={{ ...styles.providerBadge, ...(provider === "hermes" ? styles.providerHermes : styles.providerMock) }}>
              {provider === "hermes" ? "Live Hermes" : "Mock"}
            </span>
          )}
          <span style={styles.count}>{rows.length} pending</span>
          <button type="button" onClick={onClose} style={styles.closeBtn} aria-label="Close">×</button>
        </header>

        {rows.length === 0 ? (
          <p style={styles.empty}>Nothing pending. Click "Groom my day" to ask the agent for fresh proposals.</p>
        ) : (
          <ul style={styles.rows}>
            {rows.map((r) => {
              const isStale = staleIds.has(r.taskId);
              const rowError = errors[r.taskId];
              return (
                <li key={r.taskId} style={{ ...styles.row, ...(isStale ? styles.rowStale : {}) }}>
                  <div style={styles.rowMain}>
                    <strong style={styles.rowTitle}>{r.taskTitle}</strong>
                    <div style={styles.rowPatch}>
                      <code>{JSON.stringify(r.patch)}</code>
                    </div>
                    <div style={styles.rowReason}>{r.reason}</div>
                    {isStale && (
                      <div style={styles.staleNote}>
                        Stale — the file changed since this was proposed. Dismiss to clear.
                      </div>
                    )}
                    {rowError !== undefined && <div style={styles.rowError}>{rowError}</div>}
                  </div>
                  <div style={styles.rowActions}>
                    <button
                      type="button"
                      onClick={() => onApprove(r.taskId)}
                      disabled={busy || isStale}
                      style={{ ...styles.approveBtn, ...(busy || isStale ? styles.btnDisabled : {}) }}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => onDismiss(r.taskId)}
                      disabled={busy}
                      style={{ ...styles.dismissBtn, ...(busy ? styles.btnDisabled : {}) }}
                    >
                      Dismiss
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {rows.length > 0 && (
          <footer style={styles.footer}>
            <button
              type="button"
              onClick={onApproveAll}
              disabled={busy || anyStale}
              title={anyStale ? "One or more suggestions are stale. Dismiss them first or refresh." : undefined}
              style={{ ...styles.approveAllBtn, ...(busy || anyStale ? styles.btnDisabled : {}) }}
            >
              Approve all ({rows.length - staleIds.size})
            </button>
            <ConfirmButton
              label={`Dismiss all (${rows.length})`}
              confirmLabel="Confirm dismiss all"
              disabled={busy}
              onConfirm={onDismissAll}
              style={styles.dismissAllBtn!}
              disabledStyle={styles.btnDisabled!}
            />
            <button type="button" onClick={onClose} style={styles.closeFooterBtn}>Close</button>
          </footer>
        )}
      </div>
    </div>
  );
}

/**
 * Two-click confirmation for destructive batch actions. First click flips the
 * label to "Confirm dismiss all"; a 3s timeout reverts to the original label.
 * Keeps the user from nuking a whole batch with one accidental click.
 */
function ConfirmButton({
  label, confirmLabel, disabled, onConfirm, style, disabledStyle,
}: {
  label: string;
  confirmLabel: string;
  disabled: boolean;
  onConfirm: () => void;
  style: CSSProperties;
  disabledStyle: CSSProperties;
}) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else {
          setArmed(true);
          setTimeout(() => setArmed(false), 3000);
        }
      }}
      style={{ ...style, ...(disabled ? disabledStyle : {}), ...(armed ? styles.armed : {}) }}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}

const styles: Record<string, CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(0, 0, 0, 0.55)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "2rem",
    zIndex: 1000,
  },
  dialog: {
    background: "var(--modal-bg, #fff)",
    color: "var(--modal-fg, #111)",
    borderRadius: 10,
    width: "min(720px, 100%)",
    maxHeight: "85vh",
    display: "flex",
    flexDirection: "column",
    boxShadow: "0 24px 60px rgba(0,0,0,0.4)",
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    padding: "1rem 1.25rem",
    borderBottom: "1px solid rgba(127,127,127,0.2)",
  },
  title: { margin: 0, fontSize: "1.1rem" },
  providerBadge: {
    fontSize: "0.7rem",
    padding: "0.15rem 0.5rem",
    borderRadius: 999,
    color: "white",
    fontFamily: "ui-monospace, SFMono-Regular, monospace",
  },
  providerHermes: { background: "#1f8a3d" },
  providerMock: { background: "#b07e00" },
  count: { fontSize: "0.85rem", color: "#888" },
  closeBtn: {
    marginLeft: "auto",
    background: "transparent",
    border: "none",
    fontSize: "1.5rem",
    lineHeight: 1,
    cursor: "pointer",
    color: "inherit",
    padding: "0 0.25rem",
  },
  empty: { padding: "2rem", textAlign: "center", color: "#888" },
  rows: {
    listStyle: "none",
    margin: 0,
    padding: "0.5rem 0",
    overflowY: "auto",
    flex: "1 1 auto",
  },
  row: {
    display: "flex",
    alignItems: "flex-start",
    gap: "1rem",
    padding: "0.85rem 1.25rem",
    borderBottom: "1px solid rgba(127,127,127,0.12)",
  },
  rowStale: {
    background: "rgba(154,31,31,0.06)",
  },
  rowMain: { flex: "1 1 auto", minWidth: 0 },
  rowTitle: { display: "block", fontSize: "0.95rem", marginBottom: "0.2rem" },
  rowPatch: {
    fontSize: "0.78rem",
    fontFamily: "ui-monospace, SFMono-Regular, monospace",
    color: "#b07e00",
    marginBottom: "0.2rem",
  },
  rowReason: { fontSize: "0.85rem", color: "#666" },
  staleNote: {
    marginTop: "0.35rem",
    fontSize: "0.78rem",
    color: "#9a1f1f",
    fontWeight: 500,
  },
  rowError: {
    marginTop: "0.35rem",
    fontSize: "0.78rem",
    color: "#9a1f1f",
  },
  rowActions: { display: "flex", gap: "0.4rem", flexShrink: 0 },
  approveBtn: {
    background: "#1f8a3d",
    color: "white",
    border: "none",
    padding: "0.35rem 0.7rem",
    borderRadius: 5,
    fontSize: "0.85rem",
    cursor: "pointer",
  },
  dismissBtn: {
    background: "transparent",
    color: "var(--modal-fg, #444)",
    border: "1px solid rgba(127,127,127,0.4)",
    padding: "0.35rem 0.7rem",
    borderRadius: 5,
    fontSize: "0.85rem",
    cursor: "pointer",
  },
  btnDisabled: { opacity: 0.5, cursor: "not-allowed" },
  footer: {
    display: "flex",
    gap: "0.5rem",
    padding: "0.85rem 1.25rem",
    borderTop: "1px solid rgba(127,127,127,0.2)",
    background: "rgba(127,127,127,0.04)",
  },
  approveAllBtn: {
    background: "#1f8a3d",
    color: "white",
    border: "none",
    padding: "0.5rem 1rem",
    borderRadius: 6,
    fontSize: "0.9rem",
    fontWeight: 500,
    cursor: "pointer",
  },
  dismissAllBtn: {
    background: "transparent",
    color: "#9a1f1f",
    border: "1px solid rgba(154,31,31,0.5)",
    padding: "0.5rem 1rem",
    borderRadius: 6,
    fontSize: "0.9rem",
    cursor: "pointer",
  },
  closeFooterBtn: {
    marginLeft: "auto",
    background: "transparent",
    border: "1px solid rgba(127,127,127,0.4)",
    color: "inherit",
    padding: "0.5rem 1rem",
    borderRadius: 6,
    fontSize: "0.9rem",
    cursor: "pointer",
  },
  armed: { background: "#9a1f1f", color: "white", borderColor: "#9a1f1f" },
};
