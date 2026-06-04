import type { AgentProvider, Suggestion } from "../agent/AgentProvider.ts";
import type { MarkdownRepository } from "../repo/MarkdownRepository.ts";
import { type ApiTaskFile, serializeFile } from "./wire.ts";

/**
 * Embedded form of a suggestion as it lives in the file's frontmatter.
 * snake_case to match the YAML the user (and Obsidian) will see.
 */
function toEmbedded(s: Suggestion): Record<string, unknown> {
  return {
    patch: s.patch,
    reason: s.reason,
    base_version: s.baseVersion,
    provider: s.provider,
    created_at: s.createdAt,
  };
}

export type ApiGroomedSuggestion = Suggestion & { file: ApiTaskFile };

export type ApiGroomResponse = {
  summary: string | undefined;
  provider: AgentProvider["name"];
  suggestions: ApiGroomedSuggestion[];
};

/**
 * POST /api/agent/groom
 *
 * Run the configured agent over the current vault, then write each
 * resulting Suggestion as `pepper_suggests:` on its target file.
 *
 * pepper_suggests is excluded from contentHash by design, so writing it
 * does NOT bump the file's base version — which means rerunning groom
 * (or later approving) won't trip the staleness gate just because we
 * stamped the suggestion onto the file.
 */
export async function handleGroom(
  repo: MarkdownRepository,
  agent: AgentProvider,
): Promise<Response> {
  const { files } = await repo.list();
  const result = await agent.groom({ files, now: new Date() });

  const out: ApiGroomedSuggestion[] = [];
  for (const suggestion of result.suggestions) {
    try {
      const updated = await repo.update(suggestion.taskId, {
        pepper_suggests: toEmbedded(suggestion),
      });
      out.push({ ...suggestion, file: serializeFile(updated) });
    } catch (err: unknown) {
      // A suggestion targeting a deleted/renamed file is recoverable; skip it
      // and surface in the response so the client can show "couldn't apply N".
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`groom: dropping suggestion for ${suggestion.taskId}: ${msg}`);
    }
  }

  const body: ApiGroomResponse = {
    summary: result.summary,
    provider: agent.name,
    suggestions: out,
  };
  return Response.json(body);
}

