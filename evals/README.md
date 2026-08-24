# Skill Recorder — Evals

Repeatable evals for the part of the system with real variance: the multi-turn
**Copilot describer** that turns captured signals into an *overall intent* + an
*ordered list of steps*. Each eval feeds the describer a fixed, synthetic
recording and scores its analysis against a rubric.

## Why fixture-based (not live capture)

The evals are **deterministic and video-less on purpose**. Live capture (driving
real apps, recording the screen) is flaky and slow, and it's not the part we're
trying to measure. By materializing a fixed event stream we isolate the describer
so a run is repeatable and fast (~15–25s per scenario), and a failure points at
the model/instructions, not at capture flakiness. The events are authored to
mirror what the real collectors emit for the same task, so a scenario is a
faithful stand-in for a real recording. Matching **mock pages** live in
`evals/mocks/` for when you *do* want a real end-to-end capture (see below).

## Run

```bash
npm run eval                       # all scenarios
npm run eval -- --only=web-to-spreadsheet
npm run eval -- --judge            # also run the semantic LLM judge
npm run eval -- --keep             # print the temp sessions dir (artifacts kept)
npm run eval -- --model=<model-id> # override the describer model
```

Requires GitHub Copilot CLI to be signed in (same auth the app uses). Exit code
is non-zero if any scenario fails. Full results are written to
`evals/results/<timestamp>.json` (git-ignored).

Under the hood the runner uses Node's TypeScript support
(`--experimental-transform-types`) plus a tiny resolution hook
(`evals/register.mjs` → `evals/hooks.mjs`) that (1) resolves the project's
extensionless imports to `.ts` and (2) swaps the one `electron` import for a
headless stub (`evals/electron-stub.mjs`). No bundler, runs the real app source.

## How a run works

For each scenario the harness:

1. **Materializes** a synthetic session (`session.json` + `events.jsonl`) into an
   isolated temp sessions root (via the `SKILL_RECORDER_SESSIONS_DIR` override, so
   your real sessions are never touched).
2. Runs the **real pipeline** — `processSession()` builds `bundle.json` +
   `description.md` exactly as the app does after Stop.
3. Runs the **real describer** — `new Describer().analyze(id)`, the same agent the
   app uses (reads the timeline/events, pulls frames only if ambiguous, calls
   `submit_analysis`).
4. **Scores** the analysis against the scenario's rubric.

## Scoring

`scoring.ts` is deterministic and LLM-free — the primary pass/fail signal:

- **intent keywords** — the intent sentence names the right subject.
- **step count** — within an expected range (catches over/under-segmentation).
- **expected apps** — the right applications appear.
- **ordered actions** — key actions appear as an ordered subsequence across steps
  (validates the reconstructed order, e.g. *open page → copy → into spreadsheet*).
- **must-mention** — specific copied values/entities are surfaced.
- **forbidden noise** — recorder bracketing (the Skill Recorder app), permission
  dialogs, and tracking-param hops must **not** appear as steps. Scoped to step
  titles/apps + intent, so the agent isn't penalized for *explaining* that it
  correctly ignored noise.

A forbidden-noise hit fails the scenario outright; otherwise pass = ≥80% of checks.

`--judge` adds an optional second opinion: a separate Copilot agent grades
faithfulness 0–5 against the scenario's ground truth (`judge.ts`). Off by default
to keep runs deterministic.

## Scenarios

Business, repeatable knowledge-work patterns (`evals/scenarios/`):

| id | task |
|----|------|
| `web-to-spreadsheet` | Copy pricing figures from a web page into a spreadsheet |
| `invoice-extract` | Extract invoice rows from a web table into a spreadsheet |
| `research-compile` | Research two articles and compile quotes into a note |
| `directory-lookup` | Collect contact details from a directory into a spreadsheet |
| `irrelevant-detour` | Research habit articles with a mid-task off-task recipe detour the intent rules out (Chrome + TextEdit) |
| `expense-report` | Reconcile card charges against receipts and file an expense report (Chrome + Preview + Expensify) |
| `release-notes` | Compile release notes from merged PRs, then version + deploy (Terminal + GitHub + editor) |
| `lead-to-crm` | Qualify inbound leads and enter them into the CRM (Mail + LinkedIn + Salesforce) |
| `windows-deploy` | Deploy a web app to Azure and log the live URL, on Windows (Edge + Windows Terminal/pwsh + Excel) |

The last three are longer, multi-app **business processes** — they loop over several
records, mix a native app with the browser and/or terminal, and end in a submit /
deploy / commit step — stress-testing segmentation and app attribution beyond the
simple copy→paste flows.

`irrelevant-detour` guards a different judgment: a **confident intent must exclude
off-task activity**. Its stream is a clean habit-research flow with a brief hop to a
cooking-recipe page (a different host, so it segments into its own step) that has no
copy and no follow-up. Because the overall intent is unambiguous, the describer must
recognize the recipe detour as irrelevant and drop it — the rubric fails outright if
`recipe`/`allrecipes`/`cookie`/`chocolate` surfaces as a step title/app or in the intent.

Each also exercises the describer's judgment: **pastes are inferred** (a paste
emits no event), **recorder start/stop bracketing is dropped**, **tracking
params are merged**, and **off-task detours the intent rules out are excluded**.

## Add a scenario

Create `evals/scenarios/<id>.ts` exporting a `Scenario`, and add it to
`evals/scenarios/index.ts`. Build the event stream with the helpers in
`scenario.ts` (`recorder`, `visit`, `appActivate`, `clipboard`, `terminal`,
`marker`), and describe a good result in `rubric`. Keep `truth` accurate — it's
what the `--judge` grades against.

```ts
export const myScenario: Scenario = {
  id: "my-task",
  title: "…",
  truth: "What the user actually did, in plain language.",
  build: () => [ recorder(0), ...visit(1500, "Google Chrome", url, title), clipboard(4000, "…"), recorder(8000) ],
  rubric: { intentKeywordsAny: [["…"]], expectedApps: ["chrome"], orderedActions: [["…"]], forbidden: ["skill recorder"] },
};
```

## Builder evals (`evals/builder/`)

A second, smaller harness that guards the **final stage** — the builder that
generalizes an approved analysis into a Scout artifact — rather than the
describer. It exists because of a real regression: when generalizing GitHub work,
the builder preferred driving the **browser (Playwright)** instead of the **`gh`
CLI**, even though Scout runs on the user's own Mac/Windows device where `gh` is
installed and authenticated.

```bash
npm run eval:builder                       # all builder scenarios
npm run eval:builder -- --only=github-issue-triage
npm run eval:builder -- --keep             # print the temp sessions dir
npm run eval:builder -- --model=<model-id> # override the builder model
```

**How it isolates the builder.** Each scenario seeds a **fixed, approved
`Analysis`** (plus a minimal valid `bundle.json`) into a temp sessions dir, then
runs the real `AutomationBuilder.build()` for a chosen `architecture` and
`platform` (macOS or Windows). Seeding a frozen analysis removes describer
variance, so a failure points squarely at the builder's instructions/catalogue.
Only the plan's **steps** (`label` + `prompt`) are scored — the summary and
generalization prose are intentionally excluded, so the builder isn't penalized
for *explaining* which tool it avoided.

**Rubric** (`score.ts`): a scenario passes only if the steps satisfy every
`mustUseAny` group (each group is a set of synonyms; at least one must appear) and
contain **none** of the `forbidden` tokens — all case-insensitive substring
matches over the step `label` + `prompt` text. A forbidden hit fails the scenario
outright.

**Coverage.** Ten scenarios (`scenarios.ts` + `native-tool-scenarios.ts`), spanning
macOS and Windows. Two guard the original **gh-vs-browser** regression directly
(GitHub issue triage · darwin, stale-PR nudge · win32); the other eight mirror the
describer eval set (`evals/scenarios/*`) so the generalization stage is guarded for
every task type. Each rubric encodes the right native capability for its task, in
one of two flavours:

- **Native-tool-wins, browser forbidden** — the task maps to an unambiguous
  first-class CLI/tool, so the browser is a genuine wrong answer. `release-notes`
  and the two GitHub scenarios require `gh` (merged PRs, issues, PRs) and forbid
  `browser_`/`playwright`; `windows-deploy` requires the `az` CLI (+ the `xlsx`
  skill for the log) and forbids the browser. These are the strong "prefer the
  device CLI over the UI" guards.
- **Assert the native path, don't forbid a legitimate browser** — for web-read
  tasks (`web-to-spreadsheet`, `invoice-extract`, `research-compile`) the rubric
  requires `web_fetch` (and the `xlsx`/`docx` skill for the output) but does **not**
  forbid the browser: preferring `web_fetch` while documenting a browser fallback
  for a page that may need a login is exactly what we want, and a pure-browser
  regression is still caught because `web_fetch` would be absent. Genuinely
  browser-driven tasks (`expense-report` → Amex/Expensify, `lead-to-crm` →
  Salesforce/LinkedIn have no CLI/API) don't forbid the browser at all; instead
  they pin the one sub-step that *is* native — reading the local PDF receipts
  (`view`/pdf), and reading the mailbox via `workiq_*` rather than the Mail UI.

This is the suite that drove the catalogue fix in
`electron/architectures/catalogues/scout-catalogue.ts` (prefer first-class device CLIs — above
all `gh` — over the browser, platform-aware for zsh/bash vs PowerShell). When you
add a describer scenario, add the matching builder scenario so the pair stays in
lockstep.

## Skill builder evals (`evals/skillbuilder/`)

A sibling of the automation builder harness that guards the **`SkillBuilder`** —
the stage that turns an approved analysis into a reusable `SKILL.md` plan. Where
the automation harness scores free-text step prompts for native-tool choice, this
one scores the richer **plan structure** the builder now proposes.

```bash
npm run eval:skill                       # all skill scenarios
npm run eval:skill -- --only=price-tracker-skill
npm run eval:skill -- --keep             # print the temp sessions dir
npm run eval:skill -- --model=<model-id> # override the builder model
```

Both builder harnesses share the same seeding (`evals/lib/seed.ts`): a fixed,
approved `Analysis` + a minimal `bundle.json` per scenario, so a failure points at
the builder, not the describer.

**Rubric** (`score.ts`) — beyond the `mustUseAny` / `forbidden` native-tool checks,
each scenario asserts the shape of the proposed `SkillPlan`:

- **fixed values** — `minValues` requires the plan to declare at least that many fixed
  `values`, and the scorer additionally checks that every `{{token}}` a step references
  resolves to a declared value (no stale/unknown tokens survive to the artifact).
- **typed steps** — `minCalculations` / `minActions` require the procedure to be
  split into `calculation` (no side effect) and `action` (changes the world) steps.

**Coverage.** Five scenarios. Two target **Scout**: `price-tracker-skill` (a canonical
page URL → a fixed **value** referenced as `{{…}}`, `web_fetch` + the `xlsx` skill,
calculations then an append) and `github-issue-triage-skill` (the gh-vs-browser case as a
skill —
must use `gh`, forbid the browser, and drive the mutating comment/label actions). Three
target **Cowork** (Microsoft 365 Copilot), whose catalogue has **no browser automation**
— each asserts the right M365 `server/Tool` is reached for while playwright/`click` and
the web hosts are forbidden: `cowork-teams-digest` (read a channel then post via
`m365_teams`), `cowork-outlook-reply` (triage the mailbox then reply via `outlook`), and
`cowork-calendar-schedule` (find a slot then book via `outlook_calendar`).

## Sensitive detection + redaction evals (`evals/sensitive/`)

Guards the **on-device sanitization pipeline** that runs before anything is sent to
GitHub Copilot on Analyze: the two detection layers (secretlint secrets · our
in-repo structured-PII regex) and the two redaction seams (masking outgoing
**text** channels, and OCR + blur of on-screen values in **frames** under Advanced
protection).

```bash
npm run eval:sensitive                 # all cases (text + frames)
npm run eval:sensitive -- --only=jwt,frame-card-split
npm run eval:sensitive -- --verbose    # also print the redacted text / blur summary
```

Unlike the describer/builder harnesses this one is **fully deterministic — no LLM,
no model weights, no network** (exit code non-zero on any failure). secretlint and
our regex run for real; the frame layer supplies OCR words + boxes directly (no
tesseract/sharp) so the box-mapping is exercised offline.

**Corpus.**
- `corpus.ts` — one outgoing text string per case with two ground-truth lists:
  `mustRedact` (values that must be masked — recall) and `mustKeep` (ordinary text
  that must survive — precision). Covers every secret type, each structured-PII
  detector **and its validators** (Luhn-invalid card / invalid-area SSN are *not*
  flagged), a check that personal names are **not** redacted (the names layer was
  dropped), multi-detector strings, and clean prose/URLs/hashes.
- `frames.ts` — synthetic OCR word layouts with the sensitive words flagged. Covers
  a secret/email on screen, a card split across four OCR tokens (all four blur), a
  session value known from clean text blurred across OCR words (cross-feed), and a
  clean frame (nothing blurred).

**Rubric** (`score.ts`): a text case runs the real detectors → `redactText` and
checks every `mustRedact` value is gone from the output while every `mustKeep`
value survives (clean cases must yield zero findings). A frame case runs the real
`sensitiveFrameBoxes` and checks exactly the sensitive words' boxes are selected.
The summary reports aggregate **recall** (sensitive detail masked/blurred) and
**precision** (ordinary content kept).

### Opt-in real-image OCR eval (`ocr-images.ts`)

The deterministic frame eval above feeds *synthetic* OCR words, so it can't catch
the real leak vector: Tesseract **misreading** on-screen text badly enough that a
value is never detected (and the frame ships unblurred). This separate, **non-hermetic**
harness closes that gap end-to-end — it renders text to actual JPEGs with `sharp`,
runs the **real `Ocr` engine** + the shared detectors via `sensitiveFrameBoxes`, and
checks each sensitive line gets a blur box while clean lines are left alone.

```bash
npm run eval:sensitive:ocr             # renders text → JPEG, real Tesseract (English)
npm run eval:sensitive:ocr -- --keep   # also print each case's recognized OCR text
```

It is **not** part of `eval:sensitive`: it needs the tesseract WASM core, `sharp`
with system fonts, and a one-time `tessdata_fast` download per language (cached in
the git-ignored `evals/.cache/tessdata/`). When the environment can't support it
(no fonts / no network / OCR can't read a probe image) it **self-skips with exit 0**
rather than failing. Scoring is layout-based and OCR-jitter tolerant: each line is
rendered in its own fixed-height band, recall = "a blur box lands on a sensitive
line", precision = "no box lands on a clean line". Cases cover a GitHub token, a
credit card + email, a known-value cross-feed, and a Latin email amid Japanese text
read with **English-only** traineddata (the ASCII value is recognized and blurred
even though the surrounding Japanese OCRs to garbage — validating the eng-only
product decision).

## Skill runtime evals (`evals/skill-runtime/`)

A different kind of guard than the three harnesses above: those score the
**builder's proposed plan** (tool mentions, structure) — none of them ever
generate → export → load → execute a real `SKILL.md` in a target runtime and
check the resulting behavior. This harness closes that gap. It exists because a
plan that *mentions* `gh` correctly doesn't prove the exported artifact actually
gets discovered and executed correctly — the builder could propose a perfect
plan and still ship a skill that a real runtime never loads, or that drifts from
its own declared procedure once it's an independent file on disk.

```bash
npm run eval:skill-runtime                         # all runtime scenarios
npm run eval:skill-runtime -- --only=github-issue-triage-runtime
npm run eval:skill-runtime -- --keep               # print temp dirs + denied Bash attempts
```

Uses only what's already required for the rest of this suite — a signed-in
Copilot CLI, the already-vendored `@github/copilot-sdk` — no new dependency, no
new credential.

**How a run works.** Unlike the builder harnesses, this one does **not**
regenerate a skill per run: it ships a FIXED, already-built `SKILL.md` as a
static fixture (`fixtures/<id>/SKILL.md`, checked in), so a runtime-eval failure
points at the runtime, not at builder variance — the same "isolate the layer
under test" principle the rest of this suite already follows. For each scenario:

1. Reads the fixture and its frontmatter `name:`.
2. Writes it into a temp `skillDirectories` root a **fresh** Copilot session
   (separate from any builder session) is pointed at.
3. Gives the session exactly one tool — a custom `Bash`, scoped to a mocked
   `PATH` (`mocks/`) — and sends the scenario's task prompt.
4. Scores the REAL resulting mock-CLI invocations against the rubric, not
   anything the model merely said.

**Fixtures are provenance-tracked, not hand-written.** `fixtures/regenerate.ts`
runs the real `SkillBuilder` against a fixed analysis and exports the result —
re-run it (and re-commit the output) only when the target catalogue changes
meaningfully; never hand-edit a fixture's `SKILL.md` directly, or it stops being
evidence that the builder pipeline actually produces this artifact.

**Mocks are real executables, not stubs that always agree.** `mocks/gh`
(checked in, mirrors `evals/mocks/*.html` for a CLI instead of a web page)
actually simulates GitHub-side filtering: `issue list` only returns the clean,
intended result set when the invocation's flags actually ask for the right
filter — an invocation that dropped its own filtering gets back a noisier set
including issues a correct filter would have excluded. A skill that doesn't
genuinely filter, only appears to, fails visibly instead of passing by luck.

**Security.** The custom `Bash` tool enforces the fixture's own declared
`allowed-tools` frontmatter *before* executing anything — a command outside the
declared patterns is refused (never reaches `/bin/sh`) rather than merely
flagged after the fact, and the child process never inherits the host's real
environment or `PATH`. This matters because the whole point of this harness is
running a generated artifact whose exact shell commands weren't authored by
you — treat it accordingly if you add a scenario that needs a broader mock
surface (`curl`, other CLIs): widen `mocks/`, never widen what the Bash tool
will execute unchecked.

**Rubric** (`score.ts`): `mustCallGh` / `forbiddenGhCalls` groups match exact
argv tokens on the mock's invocation log (not raw substrings — a check for issue
`214` must not accidentally match `2140`); `forbiddenInCommands` is intentionally
substring-based, since it's hunting for a vendor-specific tool name that may
appear as a prefix of a longer identifier (`workiq_search_chats` contains
`workiq`); and a redundant post-hoc check confirms every *mutating* Bash command
that ran matches a declared `allowed-tools` pattern (redundant because the Bash
tool already enforces this — a violation here would mean enforcement itself has
a bug). Read-only reconnaissance (e.g. an occasional `gh repo view` before
triaging) is exempt from that last check on purpose: gating on it would fail the
suite on harmless model variance rather than a real regression.

**Coverage.** One scenario today, `github-issue-triage-runtime`, executing the
`github-issue-triage-agent-skill` fixture (the `agent-skill`/generic-target
catalogue) against four mock issues: one the skill must act on, and three it
must correctly leave alone for three different reasons (already triaged,
already assigned, wrong label) — a broader behavioral bar than "did it call
`gh`".

### Add a runtime scenario

1. If you need a new fixture, add a fixed `AnalysisSubmission` to
   `fixtures/regenerate.ts` (or a new regenerate script) and run it to produce a
   real `fixtures/<id>/SKILL.md` — don't hand-write one.
2. If the skill needs a CLI this suite doesn't mock yet, add a real executable
   under `mocks/` (see `mocks/gh` for the shape: log every invocation, branch on
   the actual flags, return canned-but-realistic data).
3. Add a `SkillRuntimeScenario` to `scenarios.ts`: the fixture's directory name,
   a task prompt, and a rubric. Prefer asserting exact behavior (which calls
   must/must-not appear) over "some tool was called".
4. Run `npm run eval:skill-runtime -- --only=<your-id> --keep` a few times
   before committing — LLM runs have real variance, so confirm the rubric holds
   up across repeats, not just once.

## Mock pages (`evals/mocks/`)

Static, self-contained HTML fixtures matching the scenarios (`pricing.html`,
`invoices.html`, `directory.html`, `article-habits.html`, `article-focus.html`;
open `index.html` as a launcher). They're **safe** — nothing submits or sends.

Use them for an optional **real** end-to-end capture: open a page in a browser,
copy a value, paste it into TextEdit/Numbers *while the recorder is running*, then
Stop and Analyze. This never performs an irreversible action (no emails, no
messages, no saving over files). The synthetic scenarios reference the same
pages/values, so a live capture should reconstruct the same intent + steps.
