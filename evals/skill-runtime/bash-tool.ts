// The one capability a runtime-conformance session gets: a real shell, enforced
// against the fixture's OWN declared allowed-tools (not just a mocked PATH) — a
// command that doesn't match a declared pattern is refused before it ever runs, so
// an untrusted or off-spec SKILL.md can't reach a real binary (curl, real gh, ...)
// with real environment/network access. PATH is deliberately minimal too: no
// inherited process.env, so no leaked host secrets/tokens even if enforcement were
// ever bypassed. Modeled on electron/builders/read-tools.ts (custom Tool, not a
// built-in), so every invocation is captured for scoring without parsing
// session-event internals.

import { execFileSync } from "node:child_process";
import type { Tool } from "@github/copilot-sdk";

import { commandMatchesAny, type BashPattern } from "./allowed-tools";

export interface BashInvocation {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface BashToolContext {
  /** Directory prepended to PATH — holds the mock CLI executables for this scenario. */
  mockBinDir: string;
  /** Working directory the shell runs in. */
  cwd: string;
  /** Extra env vars the mocks read (e.g. MOCK_GH_LOG). */
  env?: Record<string, string>;
  /** Commands outside this list are refused before executing. Empty means nothing
   *  is allowed to run — a deliberately fail-closed default for a security gate. */
  allowedPatterns: BashPattern[];
  /** Only commands that actually ran are pushed here, in order, for scoring. */
  trace: BashInvocation[];
  /** Max time a single command may run, in ms. Defaults to 15s. */
  timeoutMs?: number;
  /** Commands refused by the allowed-tools gate — never executed, kept separately
   *  so a refusal (the gate working correctly) is never mistaken for a scoring
   *  violation. Visible for debugging via --keep. */
  deniedTrace: BashInvocation[];
}

/** A single custom "Bash" tool: runs a shell command against a mocked, minimal
 *  environment and records the call + its result. This is deliberately the ONLY
 *  tool the runtime session gets — the point is to prove the skill's own
 *  instructions (and its own declared allowed-tools) are enough. */
export function createBashTool(ctx: BashToolContext): Tool {
  return {
    name: "Bash",
    description: "Execute a shell command and return its stdout/stderr/exit code.",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "The shell command to run." } },
      required: ["command"],
      additionalProperties: false,
    },
    handler: (raw) => {
      const args = raw as { command: string };

      if (!commandMatchesAny(args.command, ctx.allowedPatterns)) {
        const denial: BashInvocation = {
          command: args.command,
          stdout: "",
          stderr: "Permission denied: this command is outside the skill's declared allowed-tools.",
          exitCode: 126,
        };
        ctx.deniedTrace.push(denial);
        return JSON.stringify(denial);
      }

      // Deliberately NOT process.env — a real host secret/token must never be
      // reachable from generated-skill shell commands, even as a fallback if the
      // allowed-tools gate above were ever bypassed by a future change.
      const env = {
        ...ctx.env,
        PATH: `${ctx.mockBinDir}:/usr/bin:/bin`,
        HOME: ctx.cwd,
      };
      let stdout = "";
      let stderr = "";
      let exitCode = 0;
      try {
        stdout = execFileSync("/bin/sh", ["-c", args.command], {
          cwd: ctx.cwd,
          env,
          encoding: "utf8",
          timeout: ctx.timeoutMs ?? 15_000,
        });
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; status?: number; message: string };
        stdout = e.stdout ?? "";
        stderr = e.stderr ?? e.message;
        exitCode = e.status ?? 1;
      }
      const invocation: BashInvocation = { command: args.command, stdout, stderr, exitCode };
      ctx.trace.push(invocation);
      return JSON.stringify(invocation);
    },
  };
}
