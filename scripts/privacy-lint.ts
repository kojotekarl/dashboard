#!/usr/bin/env bun
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

/**
 * Scan a directory tree for substrings / regex matches we never want to ship
 * in a public class repo. Defends the committed sample-vault (and other
 * tracked text files) against accidental leaks of personal data.
 *
 * Decided in /plan-eng-review (subagent #10 — privacy lint).
 *
 * Run as:
 *
 *   bun run lint           — scan ./sample-vault with the default denylist
 *   bun run lint <dir>     — scan a custom directory
 *
 * Exits 1 on any hit. Used both as a CLI gate and as a regular test in
 * tests/privacy-lint.test.ts.
 */

export type Pattern = {
  pattern: RegExp;
  /** Human label shown in the report. */
  label: string;
};

export type Hit = {
  file: string;
  line: number;
  pattern: string;
  snippet: string;
};

/**
 * Default denylist. Kept as named patterns so the report shows WHICH leak
 * fired, not just "regex 7 matched". When you fork this repo for your own
 * vault, edit this list — the patterns are about what should never appear
 * in public fixtures, not universals.
 */
export const DEFAULT_DENYLIST: readonly Pattern[] = [
  { pattern: /\bstefan\b/i, label: "stefan (personal first name)" },
  { pattern: /\bzoidberg\b/i, label: "zoidberg (personal hostname)" },
  { pattern: /weltenreisender/i, label: "weltenreisender (personal handle)" },
  { pattern: /kojotekarl(-dashboard)?/i, label: "kojotekarl (GH handle, project slug)" },
  { pattern: /\/Users\/[a-z]+/, label: "/Users/<name> absolute home path" },
  // Common Mac Mini-shape leaks via hostname suffixes
  { pattern: /\.local\b/i, label: "Bonjour .local hostname" },
];

/** File extensions worth scanning — text only. */
const SCAN_EXTENSIONS: ReadonlySet<string> = new Set([".md", ".txt", ".yaml", ".yml", ".json", ".toml"]);

/** Hard-skipped directories. node_modules etc. */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".vite",
  "coverage",
]);

async function* walk(dir: string): AsyncGenerator<string> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".") && name !== "." && name !== "..") continue;
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let s: { isDirectory: () => boolean; isFile: () => boolean };
    try {
      s = await stat(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      yield* walk(full);
    } else if (s.isFile()) {
      yield full;
    }
  }
}

function hasScanExt(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return SCAN_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

export async function scanForLeaks(
  rootDir: string,
  denylist: readonly Pattern[] = DEFAULT_DENYLIST,
): Promise<Hit[]> {
  const hits: Hit[] = [];
  for await (const path of walk(rootDir)) {
    if (!hasScanExt(path)) continue;
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      for (const { pattern, label } of denylist) {
        if (pattern.test(line)) {
          hits.push({
            file: relative(process.cwd(), path),
            line: i + 1,
            pattern: label,
            snippet: line.trim().slice(0, 200),
          });
        }
      }
    }
  }
  return hits;
}

function formatReport(hits: Hit[]): string {
  if (hits.length === 0) return "no leaks found";
  const lines = [`found ${hits.length} potential leak${hits.length === 1 ? "" : "s"}:`];
  for (const h of hits) {
    lines.push(`  ${h.file}:${h.line}  [${h.pattern}]`);
    lines.push(`    ${h.snippet}`);
  }
  return lines.join("\n");
}

// ─── CLI entry ─────────────────────────────────────────────────────

if (import.meta.main) {
  const root = process.argv[2] ?? "./sample-vault";
  const hits = await scanForLeaks(root);
  console.log(formatReport(hits));
  process.exit(hits.length > 0 ? 1 : 0);
}
