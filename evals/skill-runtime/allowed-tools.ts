// Shared allowed-tools pattern parsing for the skill-runtime harness. Used by both
// bash-tool.ts (real enforcement — reject before executing) and score.ts (a
// redundant post-hoc safety net, in case enforcement code and scoring code ever
// drift apart). Single source of parsing logic so both agree on what "allowed"
// means.

export interface BashPattern {
  /** The literal command text to match against. */
  text: string;
  /** True when `text` must match the WHOLE command; false when it's a prefix
   *  (declared with a trailing `*` in the frontmatter, e.g. `Bash(gh issue list *)`). */
  exact: boolean;
}

/**
 * Parse every `Bash(...)` entry out of a SKILL.md's `allowed-tools` frontmatter.
 * Handles both prefix patterns (`Bash(gh issue list *)`) and exact patterns with no
 * trailing wildcard (`Bash(gh issue view)`) — a naive regex that only matches
 * entries ending in `*)` silently drops the latter with no warning, which is worse
 * than treating them as (correctly) exact.
 */
export function parseAllowedBashPatterns(skillMd: string): BashPattern[] {
  const patterns: BashPattern[] = [];
  const re = /Bash\(([^)]*)\)/g;
  for (const match of skillMd.matchAll(re)) {
    const raw = match[1].trim();
    if (raw.endsWith("*")) {
      patterns.push({ text: raw.slice(0, -1).trim(), exact: false });
    } else {
      patterns.push({ text: raw, exact: true });
    }
  }
  return patterns;
}

export function commandMatchesAny(command: string, patterns: BashPattern[]): boolean {
  const trimmed = command.trim();
  return patterns.some((p) => (p.exact ? trimmed === p.text : trimmed.startsWith(p.text)));
}
