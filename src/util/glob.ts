/**
 * Tiny glob matching for model ids.
 * `*` matches any run of characters (including `/`), `?` matches one.
 * Full-match semantics: `anthropic/*` matches `anthropic/claude-sonnet-4-5`
 * but not `openai/gpt-5`.
 */

const cache = new Map<string, RegExp>();

export function globToRegExp(pattern: string): RegExp {
  const hit = cache.get(pattern);
  if (hit) return hit;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const source = `^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`;
  const re = new RegExp(source);
  cache.set(pattern, re);
  return re;
}

export function globMatch(pattern: string, value: string): boolean {
  if (pattern === value) return true;
  return globToRegExp(pattern).test(value);
}

export function findMatches(pattern: string, values: readonly string[]): string[] {
  return values.filter((v) => globMatch(pattern, v));
}

/** True when the pattern contains no wildcard, i.e. it is an exact id. */
export function isExact(pattern: string): boolean {
  return !/[*?]/.test(pattern);
}
