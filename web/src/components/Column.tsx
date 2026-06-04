import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { CSSProperties } from "react";
import type { ApiTaskFile, TaskStatus } from "../lib/types.ts";
import { Card } from "./Card.tsx";

export type ColumnId = `col-${TaskStatus}`;

export const COLUMN_ORDER: readonly TaskStatus[] = [
  "backlog",
  "today",
  "in-progress",
  "blocked",
  "done",
];

export function colIdFor(status: TaskStatus): ColumnId {
  return `col-${status}`;
}

/** Inverse of colIdFor — returns the status if the id is a column id, else null. */
export function statusFromColId(id: string): TaskStatus | null {
  if (!id.startsWith("col-")) return null;
  const tail = id.slice("col-".length);
  return (COLUMN_ORDER as readonly string[]).includes(tail) ? (tail as TaskStatus) : null;
}

export function Column({
  status,
  files,
}: {
  status: TaskStatus;
  files: ApiTaskFile[];
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: colIdFor(status),
    data: { type: "column", status },
  });

  return (
    <section
      ref={setNodeRef}
      style={{
        ...styles.column,
        ...(isOver ? styles.columnOver : {}),
      }}
    >
      <h2 style={styles.head}>
        {status} <span style={styles.count}>{files.length}</span>
      </h2>
      <SortableContext items={files.map((f) => f.id)} strategy={verticalListSortingStrategy}>
        {files.length === 0 ? (
          <p style={styles.empty}>—</p>
        ) : (
          files.map((f) => <Card key={f.id} file={f} />)
        )}
      </SortableContext>
    </section>
  );
}

const styles: Record<string, CSSProperties> = {
  column: {
    background: "rgba(127,127,127,0.07)",
    borderRadius: 8,
    padding: "0.75rem",
    minHeight: 200,
    transition: "background 120ms",
  },
  columnOver: {
    background: "rgba(176,126,0,0.12)",
    outline: "2px dashed rgba(176,126,0,0.5)",
    outlineOffset: -4,
  },
  head: {
    margin: "0 0 0.75rem",
    fontSize: "0.85rem",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "#888",
    display: "flex",
    justifyContent: "space-between",
  },
  count: { fontWeight: "normal", opacity: 0.6 },
  empty: { color: "#aaa", fontSize: "0.85rem", margin: 0 },
};
