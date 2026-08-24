import type { SkillRuntimeScenario } from "./scenario";

/**
 * Runs the real, already-exported github-issue-triage-agent-skill fixture
 * (evals/skill-runtime/fixtures/github-issue-triage-agent-skill/SKILL.md) against a
 * fresh Copilot session whose only tool is a mocked shell. The mock `gh`'s `issue
 * list` only returns the clean #214/#220 pair when the invocation actually filtered
 * by `--label bug` + `no:assignee`; a skill that dropped that filtering gets back a
 * noisier set including #300 (already assigned) and #310 (wrong label) instead. A
 * correct run comments + labels #214 ONLY, leaving #220/#300/#310 untouched — this
 * is the behavioral check PR #53's feedback asked for (does the skill achieve the
 * right task outcome via filtering it actually did), not just "did the plan mention
 * gh" or "did gh get called at all".
 */
const githubIssueTriageRuntime: SkillRuntimeScenario = {
  id: "github-issue-triage-runtime",
  title: "Execute the github-issue-triage-agent-skill fixture against a mocked gh",
  fixtureDir: "github-issue-triage-agent-skill",
  task:
    "This is a sandboxed test environment. You have exactly one tool: Bash. The " +
    "northlight-labs/gateway-service GitHub repository IS set up and accessible through it — do " +
    "not reply with any claim about the repository's existence or accessibility without first " +
    "calling the Bash tool to check; a text-only answer without a preceding Bash tool call is " +
    "automatically wrong in this environment. Call Bash now to triage the new unassigned bug " +
    "issues in that repository.",
  rubric: {
    mustCallGh: [
      ["issue", "comment", "214"],
      ["issue", "edit", "214"],
    ],
    forbiddenGhCalls: [
      ["issue", "comment", "220"],
      ["issue", "edit", "220"],
      ["issue", "comment", "300"],
      ["issue", "edit", "300"],
      ["issue", "comment", "310"],
      ["issue", "edit", "310"],
    ],
    forbiddenInCommands: ["workiq", "m365_", "playwright", "browser_"],
  },
};

export const skillRuntimeScenarios: SkillRuntimeScenario[] = [githubIssueTriageRuntime];
