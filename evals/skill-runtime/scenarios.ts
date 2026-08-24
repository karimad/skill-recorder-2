import type { SkillRuntimeScenario } from "./scenario";

/**
 * Runs the real, already-exported github-issue-triage-agent-skill fixture
 * (evals/skill-runtime/fixtures/github-issue-triage-agent-skill/SKILL.md) against a
 * fresh Copilot session whose only tool is a mocked shell. The mock `gh` returns two
 * issues: #214 (unassigned bug, not yet triaged) and #220 (unassigned bug, already
 * labeled needs-info). A correct run comments + labels #214 and leaves #220 alone —
 * this is the behavioral check PR #53's feedback asked for (does the skill achieve
 * the right task outcome), not just "did the plan mention gh".
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
    ],
    forbiddenInCommands: ["workiq", "m365_", "playwright", "browser_"],
  },
};

export const skillRuntimeScenarios: SkillRuntimeScenario[] = [githubIssueTriageRuntime];
