// The one capability a runtime-conformance session gets: a real shell, scoped to a
// mocked PATH so the skill's `gh`/`curl`/etc. calls hit fixtures instead of the
// network. Modeled on electron/builders/read-tools.ts (custom Tool, not a built-in),
// so every invocation is captured for scoring without parsing session-event internals.

import { execFileSync } from "node:child_process";
import type { Tool } from "@github/copilot-sdk";

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
  /** Every invocation is pushed here, in order, for scoring. */
  trace: BashInvocation[];
}

/** A single custom "Bash" tool: runs a shell command against a mocked PATH and
 *  records the call + its result. This is deliberately the ONLY tool the runtime
 *  session gets — the point is to prove the skill's own instructions are enough. */
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
      const env = {
        ...process.env,
        ...ctx.env,
        PATH: `${ctx.mockBinDir}:${process.env.PATH ?? ""}`,
      };
      let stdout = "";
      let stderr = "";
      let exitCode = 0;
      try {
        stdout = execFileSync("/bin/sh", ["-c", args.command], {
          cwd: ctx.cwd,
          env,
          encoding: "utf8",
          timeout: 15_000,
        });
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; status?: number; message: string };
        stdout = e.stdout ?? "";
        stderr = e.stderr ?? e.message;
        exitCode = e.status ?? 1;
      }
      ctx.trace.push({ command: args.command, stdout, stderr, exitCode });
      return JSON.stringify({ stdout, stderr, exitCode });
    },
  };
}
