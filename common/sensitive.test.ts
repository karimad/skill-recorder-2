import assert from "node:assert/strict";
import test from "node:test";

import {
  luhnValid,
  maskValue,
  redactText,
  redactedSnippet,
  scanText,
  shannonEntropy,
  type SensitiveCategory,
} from "./sensitive";

/** Categories present in a scan result. */
function categories(text: string): SensitiveCategory[] {
  return scanText(text).map((m) => m.category);
}

test("flags known secret and token formats", () => {
  assert.ok(categories("token ghp_" + "a".repeat(36)).includes("api-key"));
  assert.ok(categories("AKIA" + "1".repeat(16) + " is the key").includes("api-key"));
  assert.ok(categories("key=AIza" + "b".repeat(35)).includes("api-key"));
  assert.ok(categories("xoxb-" + "1".repeat(12) + "-" + "1".repeat(12) + "-" + "a".repeat(24)).includes("api-key"));
  assert.ok(categories("sk_live_" + "0123456789abcdef").includes("api-key"));
  assert.ok(categories("use sk-" + "A1b2C3d4E5f6G7h8I9j0").includes("api-key"));
});

test("flags private-key blocks and JWTs", () => {
  assert.ok(
    categories("-----BEGIN RSA PRIVATE KEY-----\nMIIE...").includes("private-key"),
  );
  assert.ok(categories("-----BEGIN OPENSSH PRIVATE KEY-----").includes("private-key"));
  const jwt =
    "eyJ" + "a".repeat(24) + "." + "eyJ" + "b".repeat(24) + "." + "c".repeat(32);
  assert.ok(categories(`Authorization: Bearer ${jwt}`).includes("jwt"));
});

test("flags credentials in URLs and key=value assignments", () => {
  assert.ok(categories("clone https://alice:s3cr3tP@ss@github.com/x").includes("password"));
  assert.ok(categories("PASSWORD=hunter2!!").includes("password"));
  assert.ok(categories('{"client_secret": "abcd1234efgh"}').includes("password"));
  assert.ok(categories("api_key: 9f8e7d6c5b4a3210").includes("password"));
});

test("ignores placeholder / empty credential values", () => {
  assert.equal(scanText("password=null").length, 0);
  assert.equal(scanText("password=<your-password>").length, 0);
  assert.equal(scanText("token = ****").length, 0);
  assert.equal(scanText("secret: changeme").length, 0);
  assert.equal(scanText("password=${DB_PASSWORD}").length, 0);
});

test("flags emails, valid cards, and SSNs", () => {
  assert.ok(categories("mail me at jane.doe@example.com please").includes("email"));
  // Visa test number (passes Luhn).
  assert.ok(categories("card 4111 1111 1111 1111 expires soon").includes("credit-card"));
  assert.ok(categories("ssn 123-45-6789 on file").includes("ssn"));
});

test("credit-card detector rejects non-Luhn digit runs and phone-like numbers", () => {
  assert.ok(!categories("order 4111 1111 1111 1112 shipped").includes("credit-card"));
  assert.ok(!categories("call 415-555-0132 today").includes("credit-card"));
  assert.ok(!categories("build 1234567890 completed").includes("credit-card"));
});

test("ssn detector rejects invalid area/group/serial", () => {
  assert.ok(!categories("000-45-6789").includes("ssn"));
  assert.ok(!categories("666-45-6789").includes("ssn"));
  assert.ok(!categories("900-45-6789").includes("ssn"));
  assert.ok(!categories("123-00-6789").includes("ssn"));
  assert.ok(!categories("123-45-0000").includes("ssn"));
});

test("does not flag ordinary prose, URLs, or commit hashes", () => {
  assert.equal(scanText("Opened the quarterly planning doc and reviewed the roadmap.").length, 0);
  assert.equal(scanText("Visited https://github.com/microsoft/skill-recorder/issues").length, 0);
  assert.equal(scanText("git checkout 9c1e6f2a4b7d8e0f1a2b3c4d5e6f7a8b9c0d1e2f").length, 0);
  assert.equal(scanText("The meeting is at 3pm in room 204 with the design team.").length, 0);
});

test("high-entropy catch-all flags random mixed tokens but not hex hashes", () => {
  assert.ok(categories("value Gh7Kp2Zx9Qw4Lm8Rt1Yb6Vn3Cs5Df0").includes("high-entropy"));
  // 64-char lowercase hex (e.g. a sha256) has no uppercase/symbol → spared.
  assert.equal(categories("a".repeat(4) + "0123456789abcdef".repeat(4)).includes("high-entropy"), false);
});

test("overlapping matches collapse to the strongest single finding", () => {
  const ghp = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
  const matches = scanText(`token=${ghp}`);
  // The specific GitHub-token detector wins over the generic assignment/entropy ones.
  assert.equal(matches.length, 1);
  assert.equal(matches[0].label, "GitHub token");
});

test("maskValue never returns the original and hides the middle", () => {
  const secret = "ghp_" + "ABCDEFGHIJKLMNOP";
  const masked = maskValue(secret);
  assert.notEqual(masked, secret);
  assert.ok(!masked.includes("CDEFGHIJKLMN"));
  assert.ok(masked.includes("••••"));
  assert.equal(maskValue("short"), "••••");
  assert.equal(maskValue(""), "");
});

test("redactText masks every match in place and leaves the rest intact", () => {
  const text = "email jane@example.com and key ghp_" + "Z".repeat(36);
  const matches = scanText(text);
  const redacted = redactText(text, matches);
  assert.ok(redacted.startsWith("email "));
  assert.ok(!redacted.includes("jane@example.com"));
  assert.ok(!redacted.includes("ghp_" + "Z".repeat(36)));
  assert.ok(redacted.includes("••••"));
});

test("redactedSnippet returns trimmed, masked context", () => {
  const text = "run: export API_KEY=SuperSecretValue1234 && deploy now to prod";
  const [match] = scanText(text);
  const snippet = redactedSnippet(text, match);
  assert.ok(!snippet.includes("SuperSecretValue1234"));
  assert.ok(snippet.includes("••••"));
});

test("entropy and Luhn helpers behave", () => {
  assert.ok(shannonEntropy("aaaaaaaa") < 1);
  assert.ok(shannonEntropy("Gh7Kp2Zx9Qw4Lm8Rt1Yb6Vn3Cs5Df0") > 3.6);
  assert.ok(luhnValid("4111111111111111"));
  assert.ok(!luhnValid("4111111111111112"));
  assert.ok(!luhnValid("abcd"));
});
