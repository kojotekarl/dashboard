/**
 * Lexorank-style fractional ranks as lowercase ASCII strings.
 *
 * Mirror of server/repo/rank.ts — same algorithm so client-computed ranks
 * stay byte-for-byte compatible with what the server validates.
 *
 * Decided in /plan-eng-review (subagent #3): integer order with dnd-kit
 * rewrites N siblings on every drag. Fractional ranks rewrite exactly one.
 */

const A = "a".charCodeAt(0); // 97
const Z = "z".charCodeAt(0); // 122
const MIN_SENTINEL = A - 1;
const MAX_SENTINEL = Z + 1;

function isValidRank(s: string): boolean {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < A || c > Z) return false;
  }
  // Trailing 'a' would imply infinitely many smaller ranks share this prefix.
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

export function generateBetween(left: string | null, right: string | null): string {
  if (left !== null && right !== null && left >= right) {
    throw new Error(`generateBetween: ${JSON.stringify(left)} is not less than ${JSON.stringify(right)}`);
  }
  if (left !== null) assertValidRank(left);
  if (right !== null) assertValidRank(right);

  const out: number[] = [];
  let i = 0;
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
    out.push(lc);
    i++;
  }
  throw new Error("generateBetween: exceeded depth bound — renormalize the column");
}

/**
 * Normalize an unsorted rank — if it doesn't pass `assertValidRank` (e.g. a
 * numeric legacy string like "3", or empty), return a safe fallback. Used
 * only on read; the server writes valid lex ranks on every persist.
 */
export function safeOrder(order: string | undefined): string {
  if (order !== undefined && isValidRank(order)) return order;
  return "n"; // middle-ish placeholder; sort order is still deterministic
}
