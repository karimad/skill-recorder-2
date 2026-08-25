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

/**
 * Shell metacharacters that let a single "allowed" command smuggle in a second,
 * unchecked one (command chaining/substitution/redirection/piping). None of the
 * fixtures' declared patterns need these to invoke `gh`, so the safest rule is to
 * refuse them outright rather than try to parse and validate every clause of a
 * compound shell command.
 */
const SHELL_METACHARACTERS = /[;&|`\n<>]|\$\(/;

export function hasShellMetacharacters(command: string): boolean {
  return SHELL_METACHARACTERS.test(command);
}

/**
 * True when `text` matches the whole command, or — for a prefix pattern — matches
 * up to a token boundary (whitespace or end of string) right after the prefix.
 * A plain `String.startsWith` would let `gh issue comment` (declared as
 * `Bash(gh issue comment *)`) match `gh issue commentXYZ`, since that string also
 * starts with the prefix text with no separating space.
 */
function matchesPattern(command: string, p: BashPattern): boolean {
  if (p.exact) return command === p.text;
  if (!command.startsWith(p.text)) return false;
  const next = command[p.text.length];
  return next === undefined || /\s/.test(next);
}

export function commandMatchesAny(command: string, patterns: BashPattern[]): boolean {
  const trimmed = command.trim();
  if (hasShellMetacharacters(trimmed)) return false;
  return patterns.some((p) => matchesPattern(trimmed, p));
}
