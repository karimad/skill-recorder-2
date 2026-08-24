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

/** True when every substring in `group` appears on the same log line. */
function lineMatchesAll(line: string, group: string[]): boolean {
  return group.every((s) => line.includes(s));
}

function anyLineMatchesAll(lines: string[], group: string[]): boolean {
  return lines.some((line) => lineMatchesAll(line, group));
}

export function scoreRuntime(
  ghLogLines: string[],
  bashTrace: BashInvocation[],
  rubric: RuntimeRubric,
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

  const commandText = bashTrace.map((b) => b.command).join("\n").toLowerCase();
  for (const bad of rubric.forbiddenInCommands) {
    const hit = commandText.includes(bad.toLowerCase());
    checks.push({
      name: `no command references "${bad}"`,
      pass: !hit,
      detail: hit ? `forbidden token "${bad}" appeared in a Bash command` : undefined,
    });
  }

  checks.push({
    name: "the Bash tool was invoked at least once",
    pass: bashTrace.length > 0,
    detail: bashTrace.length === 0 ? "the session never ran a shell command — the skill wasn't executed" : undefined,
  });

  const passCount = checks.filter((c) => c.pass).length;
  const score = checks.length ? passCount / checks.length : 0;
  return { pass: checks.every((c) => c.pass), score, checks };
}
