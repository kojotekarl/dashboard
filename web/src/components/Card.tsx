import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { CSSProperties } from "react";
import type { ApiTaskFile } from "../lib/types.ts";

/**
 * Presentation-only card. No sortable hooks, no listeners. Used by Card
 * (in-list, sortable) AND by Kanban's <DragOverlay> (free-floating, anchored
 * to the cursor). Sharing one render path keeps the dragged clone visually
 * identical to its in-list source.
 */
export function CardBody({
  file,
  variant = "rest",
}: {
  file: ApiTaskFile;
  /** "rest" = normal in-list. "placeholder" = source slot during drag. "overlay" = the floating clone. */
  variant?: "rest" | "placeholder" | "overlay";
}) {
  const e = file.entity;
  if (e.type !== "task" && e.type !== "learning-step" && e.type !== "routine") return null;
  const hasSuggestion = e.pepper_suggests !== undefined;

  const style: CSSProperties = {
    ...styles.card,
    ...(hasSuggestion ? styles.cardWithSuggestion : {}),
    ...(variant === "placeholder" ? styles.cardPlaceholder : {}),
    ...(variant === "overlay" ? styles.cardOverlay : {}),
  };

  return (
    <article style={style}>
      <header style={styles.head}>
        <span style={styles.priority}>{e.priority}</span>
        <strong style={styles.title}>{e.title}</strong>
      </header>
      <div style={styles.meta}>
        {e.project !== null && e.project !== undefined && <span>project: {e.project}</span>}
        {e.goal !== null && e.goal !== undefined && <span> · goal: {e.goal}</span>}
        {e.due !== null && e.due !== undefined && <span> · due: {String(e.due).slice(0, 10)}</span>}
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

/** In-list, sortable wrapper. Renders CardBody and attaches drag handles. */
export function Card({ file }: { file: ApiTaskFile }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: file.id,
    data: { type: "card", file },
  });

  // While dragging, the floating clone (DragOverlay in Kanban) becomes the
  // visible drag. The source becomes a low-opacity placeholder so the slot
  // is preserved in the column layout.
  const wrapperStyle: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition: transition ?? undefined,
    cursor: isDragging ? "grabbing" : "grab",
    // Avoid double opacity (CardBody also dims): only the wrapper handles it
    // during drag so the source slot is clearly "reserved" but readable.
  };

  return (
    <div ref={setNodeRef} style={wrapperStyle} {...attributes} {...listeners}>
      <CardBody file={file} variant={isDragging ? "placeholder" : "rest"} />
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  card: {
    background: "var(--card-bg, white)",
    border: "1px solid rgba(127,127,127,0.2)",
    borderRadius: 6,
    padding: "0.6rem 0.75rem",
    marginBottom: "0.5rem",
    fontSize: "0.9rem",
    userSelect: "none",
    touchAction: "none",
  },
  cardWithSuggestion: {
    boxShadow: "0 0 0 2px rgba(176,126,0,0.35)",
  },
  cardPlaceholder: {
    opacity: 0.35,
    background: "rgba(127,127,127,0.06)",
    borderStyle: "dashed",
    boxShadow: "none",
  },
  cardOverlay: {
    boxShadow: "0 12px 28px rgba(0,0,0,0.28)",
    transform: "rotate(1.5deg)",
    cursor: "grabbing",
  },
  head: { display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.3rem" },
  priority: {
    fontSize: "0.7rem",
    background: "rgba(127,127,127,0.18)",
    padding: "0.1rem 0.4rem",
    borderRadius: 3,
    fontFamily: "ui-monospace, SFMono-Regular, monospace",
  },
  title: { fontSize: "0.95rem" },
  meta: { color: "#888", fontSize: "0.78rem" },
  suggestion: {
    marginTop: "0.4rem",
    paddingTop: "0.4rem",
    borderTop: "1px dashed rgba(176,126,0,0.4)",
    fontSize: "0.78rem",
    color: "#b07e00",
  },
};
