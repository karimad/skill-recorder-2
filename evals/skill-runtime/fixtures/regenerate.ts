// Regenerates the static SKILL.md fixtures used by the skill-runtime evals.
//
// Runtime-conformance scenarios (unlike the skillbuilder plan evals) ship a FIXED,
// already-built skill artifact rather than regenerating one on every run — the same
// "isolate the layer under test" principle the rest of this eval suite follows: a
// runtime-eval failure should point at the runtime, not at builder variance.
//
// Deliberately self-contained (its own fixed analysis, not imported from
// evals/skillbuilder/scenarios.ts) so this harness has no dependency on that file's
// contents. Re-run this script (and re-commit its output) only when the target
// catalogue changes meaningfully.
//
// Run:
//   node --experimental-transform-types --import ../../register.mjs fixtures/regenerate.ts

import { mkdtempSync, renameSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AnalysisSubmission } from "../../../common/analysis";
import { SkillBuilder } from "../../../electron/skillbuilder/builder";
import { seedScenario } from "../../lib/seed";

const here = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_ID = "github-issue-triage-agent-skill";

/** Same recorded task as evals/skillbuilder's github-issue-triage-skill, generalized
 *  against the portable "agent-skill" catalogue instead of Scout. */
const ANALYSIS: AnalysisSubmission = {
  title: "Triage new bug issues",
  intent:
    "Triage newly reported, unassigned bug issues in the northlight-labs/gateway-service GitHub repository: for each " +
    "open issue labeled 'bug' with no assignee, post a comment asking the reporter for exact " +
    "reproduction steps and their version, then add the 'needs-info' label.",
  intentConfidence: "high",
  intentRationale:
    "The browser stayed on github.com/northlight-labs/gateway-service issue pages throughout; the same comment text " +
    "and the same 'needs-info' label were applied to a bug issue.",
  steps: [
    {
      id: "s1",
      title: "Open the repo's open bug issues on GitHub",
      detail:
        "Navigated in Chrome to the northlight-labs/gateway-service issues list filtered to open bug issues with no " +
        "assignee to find reports that still need triage.",
      apps: ["Google Chrome"],
      evidence: [
        "browser.url https://github.com/northlight-labs/gateway-service/issues?q=is%3Aissue+is%3Aopen+label%3Abug+no%3Aassignee",
        "title 'Issues · northlight-labs/gateway-service'",
      ],
      confidence: "high",
    },
    {
      id: "s2",
      title: "Open a new bug report to read it",
      detail: "Opened issue #214 in Chrome to read the reported bug before triaging it.",
      apps: ["Google Chrome"],
      evidence: ["browser.url https://github.com/northlight-labs/gateway-service/issues/214"],
      confidence: "high",
    },
    {
      id: "s3",
      title: "Comment asking for reproduction steps",
      detail:
        "Typed a comment into the issue's comment box and submitted it, asking the reporter for " +
        "exact reproduction steps and the version they are on.",
      apps: ["Google Chrome"],
      evidence: [
        "clipboard 'Thanks for the report! Could you share exact reproduction steps and the version you're on?'",
        "browser.url https://github.com/northlight-labs/gateway-service/issues/214",
      ],
      confidence: "high",
    },
    {
      id: "s4",
      title: "Apply the needs-info label",
      detail:
        "Opened the Labels sidebar on the issue and applied the 'needs-info' label to mark it as " +
        "waiting on the reporter.",
      apps: ["Google Chrome"],
      evidence: ["browser.url https://github.com/northlight-labs/gateway-service/issues/214", "label 'needs-info'"],
      confidence: "medium",
    },
  ],
};

async function main(): Promise<void> {
  const root = mkdtempSync(path.join(os.tmpdir(), "sr-fixture-gen-"));
  process.env.SKILL_RECORDER_SESSIONS_DIR = root;
  seedScenario(root, { id: FIXTURE_ID, platform: "darwin", analysis: ANALYSIS });

  const builder = new SkillBuilder((p) => {
    if (p.message) console.error(`  · ${p.message}`);
  });
  const exportRoot = mkdtempSync(path.join(os.tmpdir(), "sr-fixture-export-"));
  try {
    const plan = await builder.build({ sessionId: FIXTURE_ID, architecture: "agent-skill" });
    const { path: skillPath } = await builder.create(FIXTURE_ID, plan, { kind: "export", dir: exportRoot });

    const destDir = path.join(here, FIXTURE_ID);
    if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true });
    // Renames the whole <exportRoot>/<skillName> directory, not just SKILL.md —
    // safe only because `exportRoot` is a dir we just mkdtemp'd and `builder.create`
    // is the only thing that has written into it, so <skillName> is its sole child.
    renameSync(path.dirname(skillPath), destDir);
    console.error(`Wrote fixture: ${path.join(destDir, "SKILL.md")}`);
  } finally {
    await builder.dispose();
    rmSync(root, { recursive: true, force: true });
    rmSync(exportRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
