import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { scanSessionForSensitive } from "./scanner";

const STARTED_AT = 10_000;

// Fake, non-real credentials shaped to trip specific detectors.
const GH_TOKEN = "ghp_" + "a".repeat(36);
const URL_CREDS = "svc:hunter2pass";
const ASSIGN_VALUE = "ABCD1234EFGH5678IJKL";
const CARD = "4111 1111 1111 1111"; // Luhn-valid Visa test number
const EMAIL = "dev@internal.example.com";

function event(seq: number, offsetMs: number, type: string, payload: Record<string, unknown>) {
  return JSON.stringify({
    seq,
    t: offsetMs,
    epoch: STARTED_AT + offsetMs,
    type,
    source: "test",
    payload,
  });
}

async function seedSession(root: string, id: string): Promise<void> {
  const dir = path.join(root, id);
  await mkdir(dir, { recursive: true });

  await writeFile(
    path.join(dir, "session.json"),
    JSON.stringify({ id, startedAt: STARTED_AT, stoppedAt: STARTED_AT + 9_000 }),
  );

  const lines = [
    event(1, 1_000, "app.activate", {
      app: "Chrome",
      title: "Internal Dashboard",
      url: `https://${URL_CREDS}@db.internal.example.com/health`,
    }),
    event(2, 1_500, "clipboard.change", { textPreview: `card ${CARD} for the test account` }),
    event(3, 2_000, "terminal.command", { command: `export API_KEY=${ASSIGN_VALUE} && deploy` }),
    event(4, 3_000, "terminal.command", { command: `echo ${GH_TOKEN}` }),
    event(5, 2_500, "marker", { note: `ping ${EMAIL} about this` }),
    event(6, 4_000, "app.title-change", { app: "Chrome", title: "Nothing sensitive here" }),
    // Same GitHub token again, later — should dedupe into one finding (occurrences: 2).
    event(7, 5_000, "terminal.command", { command: `echo ${GH_TOKEN}` }),
  ];
  await writeFile(path.join(dir, "events.jsonl"), lines.join("\n") + "\n");

  await writeFile(
    path.join(dir, "narration.json"),
    JSON.stringify({
      version: 1,
      language: "en",
      segments: [
        { atMs: 6_000, text: `my email is ${EMAIL}` },
        { atMs: 7_000, text: "nothing to see here" },
      ],
    }),
  );
}

test("scanner finds sensitive details across every outgoing source and redacts them", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "skill-recorder-sensitive-"));
  const previousRoot = process.env.SKILL_RECORDER_SESSIONS_DIR;
  process.env.SKILL_RECORDER_SESSIONS_DIR = root;

  try {
    const id = "scan-test";
    await seedSession(root, id);

    const report = scanSessionForSensitive(id);

    assert.equal(report.sessionId, id);
    assert.equal(report.totalFindings, 6);
    assert.equal(report.highSeverityCount, 4); // 2 passwords + gh token + card
    assert.deepEqual(report.counts, {
      password: 2,
      "api-key": 1,
      "credit-card": 1,
      email: 2,
    });

    const bySource = (src: string) => report.findings.filter((f) => f.source === src);
    assert.equal(bySource("url").length, 1);
    assert.equal(bySource("command").length, 2);
    assert.equal(bySource("clipboard").length, 1);
    assert.equal(bySource("note").length, 1);
    assert.equal(bySource("narration").length, 1);

    // Same token in two commands collapses to one finding seen twice, timed at
    // the earliest occurrence (offset 3_000, not the later 5_000).
    const token = report.findings.find((f) => f.label === "GitHub token");
    assert.ok(token, "expected a GitHub token finding");
    assert.equal(token.occurrences, 2);
    assert.equal(token.atMs, 3_000);
    assert.equal(token.severity, "high");

    // Findings sort high-severity first.
    assert.equal(report.findings[0].severity, "high");

    // Nothing raw ever leaves the scanner — only masked values + redacted context.
    const serialized = JSON.stringify(report);
    for (const raw of [GH_TOKEN, URL_CREDS, ASSIGN_VALUE, CARD, EMAIL, "hunter2pass"]) {
      assert.ok(!serialized.includes(raw), `report must not contain raw value: ${raw}`);
    }
    for (const f of report.findings) {
      assert.match(f.redactedValue, /•/, "redacted value should be masked");
    }
  } finally {
    if (previousRoot === undefined) delete process.env.SKILL_RECORDER_SESSIONS_DIR;
    else process.env.SKILL_RECORDER_SESSIONS_DIR = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("scanner returns a clean report when nothing sensitive is present", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "skill-recorder-sensitive-"));
  const previousRoot = process.env.SKILL_RECORDER_SESSIONS_DIR;
  process.env.SKILL_RECORDER_SESSIONS_DIR = root;

  try {
    const id = "clean-test";
    const dir = path.join(root, id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "session.json"),
      JSON.stringify({ id, startedAt: STARTED_AT, stoppedAt: STARTED_AT + 1_000 }),
    );
    await writeFile(
      path.join(dir, "events.jsonl"),
      event(1, 500, "marker", { note: "reviewed the onboarding docs" }) + "\n",
    );

    const report = scanSessionForSensitive(id);
    assert.equal(report.totalFindings, 0);
    assert.equal(report.highSeverityCount, 0);
    assert.deepEqual(report.counts, {});
    assert.deepEqual(report.findings, []);
  } finally {
    if (previousRoot === undefined) delete process.env.SKILL_RECORDER_SESSIONS_DIR;
    else process.env.SKILL_RECORDER_SESSIONS_DIR = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("scanner is defensive: missing artifacts yield an empty report, not a throw", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "skill-recorder-sensitive-"));
  const previousRoot = process.env.SKILL_RECORDER_SESSIONS_DIR;
  process.env.SKILL_RECORDER_SESSIONS_DIR = root;

  try {
    const id = "empty-test";
    await mkdir(path.join(root, id), { recursive: true });
    const report = scanSessionForSensitive(id);
    assert.equal(report.totalFindings, 0);
    assert.deepEqual(report.findings, []);
  } finally {
    if (previousRoot === undefined) delete process.env.SKILL_RECORDER_SESSIONS_DIR;
    else process.env.SKILL_RECORDER_SESSIONS_DIR = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
