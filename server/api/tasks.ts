import type { MarkdownRepository } from "../repo/MarkdownRepository.ts";
import { type ApiTaskFile, serializeFile } from "./wire.ts";

export type { ApiTaskFile };

/** GET /api/tasks → `{ files, warnings }`. Body and contentHash included. */
export async function handleListTasks(repo: MarkdownRepository): Promise<Response> {
  const { files, warnings } = await repo.list();
  return Response.json({
    files: files.map(serializeFile),
    warnings,
  });
}

/**
 * Fields the public PATCH endpoint must never touch. These either rewrite
 * identity (`id`, `type`) or belong to the agent-driven /api/suggestions
 * lifecycle (`pepper_suggests`).
 */
const FORBIDDEN_PATCH_FIELDS = new Set(["id", "type", "pepper_suggests"]);

/** PATCH /api/tasks/:id with a JSON body of frontmatter fields to set. */
export async function handlePatchTask(
  repo: MarkdownRepository,
  id: string,
  body: unknown,
): Promise<Response> {
  if (typeof id !== "string" || id.length === 0) {
    return Response.json({ error: "missing id" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return Response.json({ error: "patch body must be a JSON object" }, { status: 400 });
  }
  const patch = body as Record<string, unknown>;
  if (Object.keys(patch).length === 0) {
    return Response.json({ error: "patch body is empty" }, { status: 400 });
  }
  for (const key of Object.keys(patch)) {
    if (FORBIDDEN_PATCH_FIELDS.has(key)) {
      return Response.json(
        { error: `field "${key}" cannot be patched via /api/tasks` },
        { status: 400 },
      );
    }
  }

  try {
    const updated = await repo.update(id, patch);
    return Response.json(serializeFile(updated));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no file with id/.test(msg)) {
      return Response.json({ error: msg }, { status: 404 });
    }
    return Response.json({ error: msg }, { status: 400 });
  }
}

/** Match `/api/tasks/:id` and return the decoded id. */
export function matchTaskId(pathname: string): string | undefined {
  const m = /^\/api\/tasks\/([^/]+)$/.exec(pathname);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return undefined;
  }
}
