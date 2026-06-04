import type { TaskFile } from "../repo/TaskRepository.ts";

/**
 * Wire-shape projection of a TaskFile. Hides the absolute on-disk path from
 * clients (only `relPath` goes out) and keeps the response minimal.
 *
 * `contentHash` is the version token clients use to dedupe their own
 * optimistic updates against echoes from the file watcher.
 */
export type ApiTaskFile = {
  id: string;
  relPath: string;
  entity: TaskFile["entity"];
  body: string;
  contentHash: string;
};

export function serializeFile(file: TaskFile): ApiTaskFile {
  return {
    id: file.id,
    relPath: file.relPath,
    entity: file.entity,
    body: file.body,
    contentHash: file.contentHash,
  };
}
