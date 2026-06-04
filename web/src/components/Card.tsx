import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { CSSProperties } from "react";
import type { ApiTaskFile } from "../lib/types.ts";

export function Card({ file }: { file: ApiTaskFile }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: file.id,
    data: { type: "card", file },
  });

  const e = file.entity;
  if (e.type !== "task" && e.type !== "learning-step" && e.type !== "routine") return null;
  const hasSuggestion = e.pepper_suggests !== undefined;

  const style: CSSProperties = {
    ...styles.card,
    ...(hasSuggestion ? styles.cardWithSuggestion : {}),
    ...(isDragging ? styles.cardDragging : {}),
    transform: CSS.Translate.toString(transform),
    transition: transition ?? undefined,
  };

  return (
    <article ref={setNodeRef} style={style} {...attributes} {...listeners}>
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

const styles: Record<string, CSSProperties> = {
  card: {
    background: "var(--card-bg, white)",
    border: "1px solid rgba(127,127,127,0.2)",
    borderRadius: 6,
    padding: "0.6rem 0.75rem",
    marginBottom: "0.5rem",
    fontSize: "0.9rem",
    cursor: "grab",
    userSelect: "none",
    touchAction: "none",
  },
  cardWithSuggestion: {
    boxShadow: "0 0 0 2px rgba(176,126,0,0.35)",
  },
  cardDragging: {
    opacity: 0.5,
    cursor: "grabbing",
    boxShadow: "0 4px 14px rgba(0,0,0,0.18)",
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
