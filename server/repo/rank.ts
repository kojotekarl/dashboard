/**
 * Lexorank-style fractional ranks as lowercase ASCII strings.
 *
 * Sort `order` field lexicographically. `generateBetween(left, right)` returns
 * a new rank strictly between `left` and `right` (null = unbounded).
 *
 * Decided in /plan-eng-review (subagent #3): integer order with dnd-kit
 * rewrites N siblings on every drag. Fractional ranks rewrite exactly one.
 */

const A = "a".charCodeAt(0); // 97
const Z = "z".charCodeAt(0); // 122
const MIN_SENTINEL = A - 1; // less than every real char
const MAX_SENTINEL = Z + 1; // greater than every real char

function isValidRank(s: string): boolean {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < A || c > Z) return false;
  }
  // Must not end in 'a' — that would imply "infinitely many smaller ranks
  // share this prefix", which breaks midpoint generation.
  if (s.charCodeAt(s.length - 1) === A) return false;
  return true;
}

export function assertValidRank(s: string): void {
  if (!isValidRank(s)) {
    throw new Error(`invalid rank: ${JSON.stringify(s)}`);
  }
}

export function compareRanks(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Return a rank strictly between `left` and `right`.
 * Either side may be null (unbounded). When both are null, returns "n".
 * Throws if left >= right.
 */
export function generateBetween(left: string | null, right: string | null): string {
  if (left !== null && right !== null && left >= right) {
    throw new Error(`generateBetween: ${JSON.stringify(left)} is not less than ${JSON.stringify(right)}`);
  }
  if (left !== null) assertValidRank(left);
  if (right !== null) assertValidRank(right);

  const out: number[] = [];
  let i = 0;
  // Cap iterations to a sane bound; deeper than this means callers should renormalize.
  for (let iter = 0; iter < 64; iter++) {
    const lc = left !== null && i < left.length ? left.charCodeAt(i) : MIN_SENTINEL;
    const rc = right !== null && i < right.length ? right.charCodeAt(i) : MAX_SENTINEL;

    if (lc === rc) {
      out.push(lc);
      i++;
      continue;
    }
    if (rc - lc > 1) {
      out.push(Math.floor((lc + rc) / 2));
      return String.fromCharCode(...out);
    }
    // No midpoint between lc and rc — append lc and keep extending on its right.
    // (rc - lc === 1, so we sit just above lc and grow further to the right.)
    out.push(lc);
    i++;
  }
  throw new Error("generateBetween: exceeded depth bound — renormalize the column");
}

/**
 * Seed N evenly-spaced ranks. v1 uses single chars 'b'..'y' (24 slots).
 * If you actually have >24 items in a single rank-ordered column on day one,
 * grow this by repeatedly bisecting via `generateBetween` — but the simpler
 * code matters more than the corner case here.
 */
export function generateInitial(count: number): string[] {
  if (count <= 0) return [];
  if (count > 24) {
    throw new Error(`generateInitial: max 24 in v1, asked for ${count}`);
  }
  const start = "b".charCodeAt(0); // skip 'a' (invalid suffix)
  return Array.from({ length: count }, (_, i) => String.fromCharCode(start + i));
}
