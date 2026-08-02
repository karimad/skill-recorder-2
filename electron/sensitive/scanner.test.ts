import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { NerEntity, NerPipeline } from "./ner-model";
import { buildRedactor, scanSession } from "./scanner";

const STARTED_AT = 10_000;

// Fake, non-real values shaped to trip specific detectors.
const GH_TOKEN = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"; // 36 body chars
const CARD = "4111 1111 1111 1111"; // Luhn-valid Visa test number
const EMAIL = "dev@internal.example.com";
const PERSON = "Ada Lovelace";

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
    event(1, 1_500, "clipboard.change", { textPreview: `card ${CARD} for the test account` }),
    event(2, 3_000, "terminal.command", { command: `echo ${GH_TOKEN}` }),
    event(3, 2_500, "marker", { note: `met with ${PERSON} to review; ping ${EMAIL}` }),
    event(4, 4_000, "app.title-change", { app: "Chrome", title: "Nothing sensitive here" }),
    // Same GitHub token again, later — should dedupe into one finding (occurrences: 2).
    event(5, 5_000, "terminal.command", { command: `echo ${GH_TOKEN}` }),
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

/** A deterministic NER stub: flags PERSON wherever it appears, no weights/native deps. */
const personPipeline: NerPipeline = (async (text: string): Promise<NerEntity[]> => {
  const idx = text.indexOf(PERSON);
  if (idx < 0) return [];
  return [{ entity_group: "PER", word: PERSON, start: idx, end: idx + PERSON.length, score: 0.99 }];
}) as unknown as NerPipeline;

async function withSessionRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "skill-recorder-sensitive-"));
  const previousRoot = process.env.SKILL_RECORDER_SESSIONS_DIR;
  process.env.SKILL_RECORDER_SESSIONS_DIR = root;
  try {
    await fn(root);
  } finally {
    if (previousRoot === undefined) delete process.env.SKILL_RECORDER_SESSIONS_DIR;
    else process.env.SKILL_RECORDER_SESSIONS_DIR = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
}

test("scanSession detects secrets + structured PII across sources and returns raw values", async () => {
  await withSessionRoot(async (root) => {
    const id = "scan-test";
    await seedSession(root, id);

    const { report, values } = await scanSession(id);

    assert.equal(report.sessionId, id);

    // Secretlint finds the GitHub token; the two commands collapse to one finding
    // seen twice, timed at the earliest occurrence (3_000, not 5_000).
    const token = report.findings.find((f) => f.label === "GitHub token");
    assert.ok(token, "expected a GitHub token finding");
    assert.equal(token.occurrences, 2);
    assert.equal(token.atMs, 3_000);
    assert.equal(token.severity, "high");

    // Structured PII (deterministic, in-repo).
    assert.ok(report.findings.some((f) => f.category === "credit-card"), "expected a card finding");
    assert.ok(report.findings.some((f) => f.category === "email"), "expected an email finding");

    // Findings sort high-severity first.
    assert.equal(report.findings[0].severity, "high");

    // Raw values are returned to the main process (for the redactor) but never in
    // the report itself.
    assert.ok(values.includes(GH_TOKEN));
    assert.ok(values.includes(CARD));
    assert.ok(values.includes(EMAIL));

    const serialized = JSON.stringify(report);
    for (const raw of [GH_TOKEN, CARD, EMAIL]) {
      assert.ok(!serialized.includes(raw), `report must not contain raw value: ${raw}`);
    }
    for (const f of report.findings) {
      assert.match(f.redactedValue, /•/, "redacted value should be masked");
    }
  });
});

test("scanSession applies the injected NER pipeline (Advanced protection)", async () => {
  await withSessionRoot(async (root) => {
    const id = "ner-test";
    await seedSession(root, id);

    const withoutNer = await scanSession(id);
    assert.ok(!withoutNer.report.findings.some((f) => f.category === "person"));
    assert.ok(!withoutNer.values.includes(PERSON));

    const withNer = await scanSession(id, { nerPipeline: personPipeline });
    const person = withNer.report.findings.find((f) => f.category === "person");
    assert.ok(person, "expected a person finding when NER is enabled");
    assert.equal(person.label, "Person name");
    assert.ok(withNer.values.includes(PERSON));
  });
});

test("buildRedactor masks every detected value, longest first, and is a no-op when empty", async () => {
  const redact = buildRedactor([GH_TOKEN, EMAIL, "ab"]); // "ab" below MIN_REDACT_LEN, ignored
  const text = `token ${GH_TOKEN} mail ${EMAIL} ab`;
  const out = redact(text);
  assert.ok(!out.includes(GH_TOKEN));
  assert.ok(!out.includes(EMAIL));
  assert.ok(out.includes("••••"));
  assert.ok(out.includes(" ab")); // short value left untouched

  const noop = buildRedactor([]);
  assert.equal(noop("nothing to redact here"), "nothing to redact here");
});

test("scanSession returns a clean result when nothing sensitive is present", async () => {
  await withSessionRoot(async (root) => {
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

    const { report, values } = await scanSession(id);
    assert.equal(report.totalFindings, 0);
    assert.deepEqual(report.findings, []);
    assert.deepEqual(values, []);
  });
});

test("scanSession is defensive: missing artifacts yield an empty result, not a throw", async () => {
  await withSessionRoot(async (root) => {
    const id = "empty-test";
    await mkdir(path.join(root, id), { recursive: true });
    const { report, values } = await scanSession(id);
    assert.equal(report.totalFindings, 0);
    assert.deepEqual(report.findings, []);
    assert.deepEqual(values, []);
  });
});
