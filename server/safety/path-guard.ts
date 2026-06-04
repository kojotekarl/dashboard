import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

/**
 * Thrown when a candidate path would escape its vault root or is a symlink.
 *
 * Decided in /plan-eng-review (codex C1 — Hermes --yolo trust boundary):
 * the server is the sole writer to the vault, but a malicious or buggy
 * agent could try to redirect operations outside via symlinks or paths
 * with `..` segments. This module is the single chokepoint that prevents
 * that, regardless of where the path originated (id lookup, watcher event,
 * agent-returned suggestion).
 */
export class PathSandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathSandboxError";
  }
}

/**
 * Compute the canonical absolute path of the vault root. Resolves symlinks
 * in the path itself (on macOS `/tmp` is a symlink to `/private/tmp`, which
 * would otherwise produce false positives on every check).
 *
 * Call ONCE in the repo constructor and pass the result to assertUnderVault.
 * Throws if the root doesn't exist.
 */
export function canonicalizeVaultRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new PathSandboxError(`vault root unreadable: ${root} (${msg})`);
  }
}

export type GuardOptions = {
  /** Set when the candidate is allowed not to exist yet (e.g., a tmp file before write). */
  mayNotExist?: boolean;
  /** Allow symlinks. Default false. Used by tests and never in production code paths. */
  allowSymlinks?: boolean;
};

/**
 * Assert that `candidate` resolves to a path under `canonicalRoot`. Returns
 * the canonical absolute path. Throws PathSandboxError if:
 *   - resolution escapes the root via ../ or absolute traversal,
 *   - the leaf is a symlink (lstat — never follow).
 *
 * `canonicalRoot` must already be canonicalized (see canonicalizeVaultRoot).
 * For paths that don't exist yet (atomic-write tmp), pass mayNotExist: true.
 */
export function assertUnderVault(
  canonicalRoot: string,
  candidate: string,
  options: GuardOptions = {},
): string {
  const absolute = isAbsolute(candidate) ? candidate : resolve(canonicalRoot, candidate);

  // Canonical path resolution. For existing files we can realpath the whole
  // thing; for non-existent leaves (atomic-write tmp files), the LEAF doesn't
  // exist yet but its parent directory does — canonicalize the parent and
  // re-attach the basename. This handles macOS's /tmp -> /private/tmp.
  let canonical: string;
  let exists = true;
  try {
    canonical = realpathSync(absolute);
  } catch {
    exists = false;
    try {
      const parentReal = realpathSync(dirname(absolute));
      canonical = join(parentReal, basename(absolute));
    } catch {
      // Even the parent doesn't exist. Fall back to the resolved string;
      // the inclusion check below will still reject it if it's outside.
      canonical = absolute;
    }
  }

  if (!exists && options.mayNotExist !== true) {
    throw new PathSandboxError(`path does not exist: ${candidate}`);
  }

  // Inclusion check: canonical must be canonicalRoot or under it.
  const rootWithSep = canonicalRoot.endsWith(sep) ? canonicalRoot : canonicalRoot + sep;
  if (canonical !== canonicalRoot && !canonical.startsWith(rootWithSep)) {
    throw new PathSandboxError(`path escapes vault: ${candidate} -> ${canonical}`);
  }

  // Symlink check on the leaf — must be a regular file/directory in the vault.
  // We use lstat (does NOT follow), so a symlink whose realpath landed inside
  // the vault is still rejected. The realpath check above closes the case
  // where it landed outside; this case closes "looks inside but is a symlink".
  if (options.allowSymlinks !== true && exists) {
    try {
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new PathSandboxError(`path is a symlink: ${candidate}`);
      }
    } catch (err: unknown) {
      if (err instanceof PathSandboxError) throw err;
      // Other lstat failures (rare): treat as a soft deny so we never write
      // through a state we can't inspect.
      const msg = err instanceof Error ? err.message : String(err);
      throw new PathSandboxError(`could not lstat ${candidate}: ${msg}`);
    }
  }

  return canonical;
}
