import assert from "node:assert/strict";
import test from "node:test";

import type { NerEntity, NerPipeline } from "./ner-model";
import { runNer } from "./ner";

/** Build a stub pipeline returning fixed entities (no weights, no native deps). */
function stub(entities: NerEntity[]): NerPipeline {
  return (async () => entities) as unknown as NerPipeline;
}

test("maps PER/LOC/ORG to categories and drops MISC", async () => {
  const text = "Ada met Grace at Microsoft in London about Bitcoin";
  const pipe = stub([
    { entity_group: "PER", word: "Ada", start: 0, end: 3, score: 0.99 },
    { entity_group: "ORG", word: "Microsoft", start: 17, end: 26, score: 0.97 },
    { entity_group: "LOC", word: "London", start: 30, end: 36, score: 0.98 },
    { entity_group: "MISC", word: "Bitcoin", start: 43, end: 50, score: 0.99 },
  ]);
  const matches = await runNer(text, pipe);
  const cats = matches.map((m) => m.category).sort();
  assert.deepEqual(cats, ["location", "org", "person"]);
  assert.ok(!matches.some((m) => m.value === "Bitcoin"));
});

test("drops entities below the confidence gate", async () => {
  const pipe = stub([
    { entity_group: "PER", word: "Ada", start: 0, end: 3, score: 0.5 },
    { entity_group: "PER", word: "Grace", start: 8, end: 13, score: 0.95 },
  ]);
  const matches = await runNer("Ada and Grace", pipe);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].value, "Grace");
});

test("falls back to locating the word when char offsets are absent", async () => {
  const pipe = stub([{ entity_group: "PER", word: "Ada Lovelace", score: 0.99 }]);
  const matches = await runNer("engineer Ada Lovelace shipped it", pipe);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].value, "Ada Lovelace");
  assert.equal(matches[0].start, 9);
});

test("is non-throwing: a pipeline error yields no matches", async () => {
  const boom = (async () => {
    throw new Error("model exploded");
  }) as unknown as NerPipeline;
  const matches = await runNer("Ada Lovelace", boom);
  assert.deepEqual(matches, []);
});

test("returns nothing for blank text without invoking the model", async () => {
  let called = false;
  const pipe = (async () => {
    called = true;
    return [];
  }) as unknown as NerPipeline;
  const matches = await runNer("   ", pipe);
  assert.deepEqual(matches, []);
  assert.equal(called, false);
});
