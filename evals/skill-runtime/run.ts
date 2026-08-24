// Skill-runtime eval harness: takes an already-exported SKILL.md fixture, drops it
// into a fresh Copilot CLI session's skillDirectories (discovery-based — the session
// finds and uses it from the task prompt matching its `description`, the same way a
// real user's project would), gives it a task, and scores the REAL resulting
// behavior against a mocked `gh` — not the builder's plan text.
//
// This is the runtime-conformance layer PR #53's feedback (and #55) asked for:
// generate -> export -> load into a target runtime -> execute -> score, using only
// what's already required for the rest of this eval suite (a signed-in Copilot CLI,
// the already-vendored @github/copilot-sdk) — no new dependency, no new credential.
//
// Run:
//   node --experimental-transform-types --import ./evals/register.mjs evals/skill-runtime/run.ts [flags]
// Flags:
//   --only=slug,slug   run a subset of scenarios
//   --keep             print the temp dirs (artifacts kept for inspection)

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { approveAll, CopilotClient, ToolSet } from "@github/copilot-sdk";

import { copilotConnectionOption, withStartupTimeout } from "../../electron/copilot-cli-path";
import { parseAllowedBashPatterns } from "./allowed-tools";
import { createBashTool, type BashInvocation } from "./bash-tool";
import { skillRuntimeScenarios } from "./scenarios";
import { scoreRuntime, type RuntimeScoreResult } from "./score";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(here, "fixtures");
const MOCKS_DIR = path.join(here, "mocks");
const SESSION_TIMEOUT_MS = 120_000;

interface Flags {
  only: Set<string> | null;
  keep: boolean;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { only: null, keep: false };
  for (const arg of argv) {
    if (arg.startsWith("--only=")) flags.only = new Set(arg.slice(7).split(",").map((s) => s.trim()).filter(Boolean));
    else if (arg === "--keep") flags.keep = true;
  }
  return flags;
}

/** Pull the frontmatter `name:` out of a SKILL.md so the fixture's checked-in
 *  directory name never has to match whatever the builder happened to name it. */
function readSkillName(skillMd: string): string {
  const match = skillMd.match(/^name:\s*(\S+)/m);
  if (!match) throw new Error("Fixture SKILL.md has no `name:` frontmatter field");
  return match[1];
}

interface Result {
  id: string;
  title: string;
  ok: boolean;
  error?: string;
  durationMs: number;
  score?: RuntimeScoreResult;
}

const bar = "─".repeat(64);

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const selected = skillRuntimeScenarios.filter((s) => !flags.only || flags.only.has(s.id));
  if (selected.length === 0) {
    console.error("No scenarios matched", flags.only ? [...flags.only] : "");
    process.exit(2);
  }

  console.error(`\nSkill Recorder — skill-runtime evals`);
  console.error(`${selected.length} scenario(s)`);
  console.error(bar);

  const client = new CopilotClient(copilotConnectionOption());
  await withStartupTimeout(client.start(), "Copilot CLI (SkillRuntime)");
  const auth = await client.getAuthStatus();
  if (!auth.isAuthenticated) {
    console.error("Copilot CLI is not signed in.");
    process.exit(2);
  }
  console.error(`Copilot ready${auth.login ? ` as ${auth.login}` : ""}`);

  const results: Result[] = [];
  for (const scenario of selected) {
    console.error(`\n▶ ${scenario.id} — ${scenario.title}`);
    const started = Date.now();
    const res: Result = { id: scenario.id, title: scenario.title, ok: false, durationMs: 0 };
    const tempDirs: string[] = [];
    try {
      const fixturePath = path.join(FIXTURES_DIR, scenario.fixtureDir, "SKILL.md");
      if (!existsSync(fixturePath)) {
        throw new Error(`Missing fixture: ${fixturePath} (run fixtures/regenerate.ts)`);
      }
      const skillMd = readFileSync(fixturePath, "utf8");
      const skillName = readSkillName(skillMd);

      // Pushed immediately after each mkdtempSync, not batched at the end — if a
      // later call in this sequence throws, the dirs already created above must
      // still be recorded for cleanup, or they leak under /tmp on that failure path.
      const scratchDir = mkdtempSync(path.join(os.tmpdir(), "sr-runtime-scratch-"));
      tempDirs.push(scratchDir);
      const skillsRoot = mkdtempSync(path.join(os.tmpdir(), "sr-runtime-skills-"));
      tempDirs.push(skillsRoot);
      const logDir = mkdtempSync(path.join(os.tmpdir(), "sr-runtime-log-"));
      tempDirs.push(logDir);
      const skillDestDir = path.join(skillsRoot, skillName);
      mkdirSync(skillDestDir, { recursive: true });
      writeFileSync(path.join(skillDestDir, "SKILL.md"), skillMd);

      const mockGhLog = path.join(logDir, "gh.log");
      writeFileSync(mockGhLog, "");

      const trace: BashInvocation[] = [];
      const deniedTrace: BashInvocation[] = [];
      const bashTool = createBashTool({
        mockBinDir: MOCKS_DIR,
        cwd: scratchDir,
        env: { MOCK_GH_LOG: mockGhLog },
        allowedPatterns: parseAllowedBashPatterns(skillMd),
        trace,
        deniedTrace,
      });

      const session = await client.createSession({
        tools: [bashTool],
        // Deliberately no `availableTools` restriction: it composes as an allow-list
        // (unset = everything allowed), and scoping it to just "Bash" earlier disabled
        // every built-in — including whatever loads skills from `skillDirectories` —
        // which silently prevented the skill from ever being read.
        //
        // Exclude every MCP tool: Copilot CLI ships a built-in GitHub MCP connector
        // (github-list_issues, etc.) that resolves repos against the REAL GitHub API,
        // bypassing the shell (and our mock `gh`) entirely — it correctly reported
        // acme/api as nonexistent, since it's a fictional repo. Excluding MCP tools
        // forces genuine shell-only behavior, which is the right simulation of "a
        // generic agent with only a shell, no privileged native GitHub connector".
        excludedTools: new ToolSet().addMcp("*"),
        skillDirectories: [skillsRoot],
        workingDirectory: scratchDir,
        onPermissionRequest: approveAll,
        enableHostGitOperations: false,
        infiniteSessions: { enabled: false },
      });
      try {
        const reply = await session.sendAndWait(scenario.task, SESSION_TIMEOUT_MS);
        if (flags.keep) console.error(`   reply:   ${JSON.stringify(reply.data).slice(0, 500)}`);
      } finally {
        await session.disconnect().catch(() => undefined);
      }

      const ghLogLines = readFileSync(mockGhLog, "utf8").split("\n").filter(Boolean);
      res.score = scoreRuntime(ghLogLines, trace, scenario.rubric, skillMd);
      res.ok = res.score.pass;
      if (flags.keep) {
        console.error(`   scratch: ${scratchDir}`);
        console.error(`   skills:  ${skillsRoot}`);
        console.error(`   gh log:  ${mockGhLog}`);
        for (const d of deniedTrace) console.error(`   denied:  ${d.command}`);
      }
    } catch (err) {
      res.error = err instanceof Error ? err.message : String(err);
    } finally {
      // Clean up unless --keep — otherwise every run (and every CI invocation)
      // leaks 3 temp dirs into /tmp.
      if (!flags.keep) {
        for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
      }
    }
    res.durationMs = Date.now() - started;
    results.push(res);
    printResult(res);
  }

  await client.stop().catch(() => undefined);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = path.join(process.cwd(), "evals", "results", `skill-runtime-${stamp}.json`);
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify({ at: stamp, results }, null, 2));

  console.error(`\n${bar}\nSummary`);
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) {
    const pct = r.score ? `${Math.round(r.score.score * 100)}%` : "  — ";
    const status = r.error ? "ERROR" : r.ok ? "PASS " : "FAIL ";
    console.error(`  ${status}  ${pct.padStart(4)}  ${r.id}${r.error ? `  (${r.error})` : ""}`);
  }
  console.error(`\n  ${passed}/${results.length} scenarios passed`);
  console.error(`  results:   ${path.relative(process.cwd(), outFile)}\n`);

  process.exit(passed === results.length ? 0 : 1);
}

function printResult(r: Result): void {
  if (r.error) {
    console.error(`   ✗ error: ${r.error}`);
    return;
  }
  console.error(`   score: ${Math.round((r.score?.score ?? 0) * 100)}% · ${r.ok ? "PASS" : "FAIL"} · ${(r.durationMs / 1000).toFixed(1)}s`);
  for (const c of r.score?.checks ?? []) {
    const mark = c.pass ? "✓" : "✗";
    console.error(`     ${mark} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }
}

main().catch((err) => {
  console.error("Harness crashed:", err);
  process.exit(3);
});
