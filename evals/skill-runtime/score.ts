// Deterministic scoring for the skill-runtime evals — checks the REAL mock-gh
// invocation log and the runtime session's Bash tool trace, not plan text.

import type { BashInvocation } from "./bash-tool";
import type { RuntimeRubric } from "./scenario";

export interface RuntimeCheck {
  name: string;
  pass: boolean;
  detail?: string;
}

export interface RuntimeScoreResult {
  pass: boolean;
  score: number;
  checks: RuntimeCheck[];
}

/**
 * True when every entry in `group` appears as an EXACT argv token on the same log
 * line — not a raw substring. Substring matching would let a call touching issue
 * `2140` or `1214` wrongly satisfy a check written for `214` (and symmetrically
 * false-fail a `forbiddenGhCalls` check for `220` against a line containing `1220`),
 * which defeats the exact thing this eval verifies: that the skill acted on the
 * right issue and only the right issue.
 */
function lineMatchesAll(line: string, group: string[]): boolean {
  const tokens = line.split(/\s+/).filter(Boolean);
  return group.every((needle) => tokens.includes(needle));
}

function anyLineMatchesAll(lines: string[], group: string[]): boolean {
  return lines.some((line) => lineMatchesAll(line, group));
}

/** Parse `allowed-tools` `Bash(<pattern> *)` frontmatter entries into plain command
 *  prefixes, e.g. `"Bash(gh issue list *)"` -> `"gh issue list"`. Non-Bash entries
 *  (`Read`, `Write`, ...) are ignored — this harness only exercises the shell. */
function parseAllowedBashPrefixes(skillMd: string): string[] {
  const prefixes: string[] = [];
  const re = /Bash\(([^)]*?)\s*\*\)/g;
  for (const match of skillMd.matchAll(re)) prefixes.push(match[1].trim());
  return prefixes;
}

/** `gh` subcommand verbs that mutate GitHub state. A benign read-only sanity check
 *  (e.g. `gh repo view` before triaging) isn't the regression this check exists to
 *  catch, and gating on it would make the suite flaky on harmless model variance —
 *  same read-vs-mutating distinction the project's own catalogues already draw
 *  ("Read tools are auto-approved; send/create/update/delete need approval"). */
const MUTATING_GH_VERBS = ["comment", "edit", "create", "close", "reopen", "delete", "merge", "assign", "label"];

function isMutatingGhCommand(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  return tokens[0] === "gh" && MUTATING_GH_VERBS.includes(tokens[2] ?? "");
}

/** Every MUTATING Bash command the session ran must match at least one
 *  `allowed-tools` prefix declared in the fixture's own frontmatter — catches a
 *  regression where the runtime (or a future skill revision) reaches for a
 *  side-effecting command outside what the skill actually declared it needs. */
function checkAllowedTools(bashTrace: BashInvocation[], skillMd: string): RuntimeCheck {
  const prefixes = parseAllowedBashPrefixes(skillMd);
  if (prefixes.length === 0) {
    return { name: "every mutating Bash command matches a declared allowed-tools prefix", pass: true };
  }
  const violations = bashTrace
    .map((b) => b.command.trim())
    .filter((cmd) => isMutatingGhCommand(cmd))
    .filter((cmd) => !prefixes.some((p) => cmd.startsWith(p)));
  return {
    name: "every mutating Bash command matches a declared allowed-tools prefix",
    pass: violations.length === 0,
    detail: violations.length
      ? `commands outside allowed-tools (${prefixes.join(", ")}): ${violations.join(" ; ")}`
      : undefined,
  };
}

export function scoreRuntime(
  ghLogLines: string[],
  bashTrace: BashInvocation[],
  rubric: RuntimeRubric,
  skillMd: string,
): RuntimeScoreResult {
  const checks: RuntimeCheck[] = [];

  for (const group of rubric.mustCallGh) {
    const hit = anyLineMatchesAll(ghLogLines, group);
    checks.push({
      name: `gh called with: ${group.join(" + ")}`,
      pass: hit,
      detail: hit ? undefined : "no mock-gh log line matched all of these",
    });
  }

  for (const group of rubric.forbiddenGhCalls) {
    const hit = anyLineMatchesAll(ghLogLines, group);
    checks.push({
      name: `avoids gh call: ${group.join(" + ")}`,
      pass: !hit,
      detail: hit ? "a forbidden call pattern was made (wrong issue acted on)" : undefined,
    });
  }

  // Substring (not token-exact) is intentional here, unlike the gh-log checks above:
  // these look for a vendor-specific tool NAME that may appear as a prefix of a
  // longer identifier (e.g. "workiq_search_chats" contains "workiq" with no
  // whitespace separating them), so exact-token matching would miss it. The
  // trade-off is the same one evals/skillbuilder/score.ts already accepts for its
  // own `forbidden` list — a rare false positive on an unrelated identifier is a
  // cheap cost next to silently missing real vendor lock-in.
  const commandText = bashTrace.map((b) => b.command).join("\n").toLowerCase();
  for (const bad of rubric.forbiddenInCommands) {
    const hit = commandText.includes(bad.toLowerCase());
    checks.push({
      name: `no command references "${bad}"`,
      pass: !hit,
      detail: hit ? `forbidden token "${bad}" appeared in a Bash command` : undefined,
    });
  }

  checks.push(checkAllowedTools(bashTrace, skillMd));

  checks.push({
    name: "the Bash tool was invoked at least once",
    pass: bashTrace.length > 0,
    detail: bashTrace.length === 0 ? "the session never ran a shell command — the skill wasn't executed" : undefined,
  });

  const passCount = checks.filter((c) => c.pass).length;
  const score = checks.length ? passCount / checks.length : 0;
  return { pass: checks.every((c) => c.pass), score, checks };
}
