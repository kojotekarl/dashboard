import {
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { useState } from "react";
import { compareRanks, generateBetween, safeOrder } from "../lib/rank.ts";
import type { ApiTaskFile, TaskStatus } from "../lib/types.ts";
import { Column, COLUMN_ORDER, statusFromColId } from "./Column.tsx";

export type MovePatch = { status?: TaskStatus; order: string };

export type KanbanProps = {
  /** Task-like files only (task / learning-step / routine). App pre-filters. */
  tasks: ApiTaskFile[];
  onMove: (taskId: string, patch: MovePatch) => void;
};

type TaskLikeFile = ApiTaskFile & {
  entity: {
    type: "task" | "learning-step" | "routine";
    id: string;
    title: string;
    status: TaskStatus;
    priority: ApiTaskFile["entity"]["priority"];
    order: string;
    pepper_suggests?: ApiTaskFile["entity"]["pepper_suggests"];
  };
};

function isTaskLike(file: ApiTaskFile): file is TaskLikeFile {
  const t = file.entity.type;
  return t === "task" || t === "learning-step" || t === "routine";
}

export function Kanban({ tasks, onMove }: KanbanProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const sensors = useSensors(
    // distance:5 means a 5px move is needed before drag fires — lets clicks
    // / tap-to-focus on cards still work without becoming drag starts.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const byStatus = groupByStatus(tasks);

  const onDragStart = (e: DragStartEvent): void => {
    setDraggingId(String(e.active.id));
  };

  const onDragEnd = (e: DragEndEvent): void => {
    setDraggingId(null);
    const { active, over } = e;
    if (over === null) return;
    if (active.id === over.id) return;

    const activeFile = tasks.find((f) => f.id === active.id);
    if (activeFile === undefined || !isTaskLike(activeFile)) return;
    const sourceStatus = activeFile.entity.status;

    // Resolve target column.
    let targetStatus: TaskStatus | null = statusFromColId(String(over.id));
    if (targetStatus === null) {
      const overFile = tasks.find((f) => f.id === over.id);
      if (overFile === undefined || !isTaskLike(overFile)) return;
      targetStatus = overFile.entity.status;
    }

    // Target column's siblings, sorted by current rank, with the dragged card removed.
    const siblings = (byStatus.get(targetStatus) ?? []).filter((f) => f.id !== active.id);

    // Resolve insert index.
    let insertIdx: number;
    if (String(over.id).startsWith("col-")) {
      insertIdx = siblings.length; // dropped on the column container = append
    } else {
      const idx = siblings.findIndex((f) => f.id === over.id);
      if (idx === -1) {
        insertIdx = siblings.length;
      } else {
        // Insert position depends on direction of drag. The over rectangle
        // tells us whether we're above or below its center.
        const overRect = e.over?.rect;
        const activeRect = e.active.rect.current.translated;
        const above =
          activeRect !== null && overRect !== undefined
            ? activeRect.top < overRect.top + overRect.height / 2
            : true;
        insertIdx = above ? idx : idx + 1;
      }
    }

    const leftRank: string | null = insertIdx === 0 ? null : safeOrder(siblings[insertIdx - 1]!.entity.order);
    const rightFile = siblings[insertIdx];
    const rightRank: string | null = rightFile === undefined ? null : safeOrder(rightFile.entity.order);

    let newRank: string;
    try {
      newRank = generateBetween(leftRank, rightRank);
    } catch (err) {
      console.error("kanban: generateBetween failed", { leftRank, rightRank, err });
      return;
    }

    const patch: MovePatch = { order: newRank };
    if (targetStatus !== sourceStatus) patch.status = targetStatus;
    onMove(String(active.id), patch);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDraggingId(null)}
    >
      <div style={styles.board}>
        {COLUMN_ORDER.map((status) => (
          <Column key={status} status={status} files={byStatus.get(status) ?? []} />
        ))}
      </div>
      {draggingId !== null && <span style={styles.srOnly}>Dragging {draggingId}</span>}
    </DndContext>
  );
}

function groupByStatus(tasks: ApiTaskFile[]): Map<TaskStatus, TaskLikeFile[]> {
  const out = new Map<TaskStatus, TaskLikeFile[]>();
  for (const status of COLUMN_ORDER) out.set(status, []);
  for (const f of tasks) {
    if (!isTaskLike(f)) continue;
    out.get(f.entity.status)?.push(f);
  }
  // Sort each column by its rank so drag-targets match what the user sees.
  for (const list of out.values()) {
    list.sort((a, b) => compareRanks(safeOrder(a.entity.order), safeOrder(b.entity.order)));
  }
  return out;
}

const styles: Record<string, React.CSSProperties> = {
  board: {
    display: "grid",
    gridTemplateColumns: "repeat(5, 1fr)",
    gap: "0.75rem",
  },
  srOnly: {
    position: "absolute",
    width: 1,
    height: 1,
    padding: 0,
    overflow: "hidden",
    clip: "rect(0 0 0 0)",
    whiteSpace: "nowrap",
    border: 0,
  },
};
