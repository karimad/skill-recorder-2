// Scenario model for the **skill-runtime** evals — the layer skillbuilder evals
// deliberately don't cover: does an actually-exported SKILL.md get discovered and
// executed correctly by a real target runtime, not just "does the builder's plan
// text mention the right tool". See evals/skill-runtime/README.md.

export interface RuntimeRubric {
  /** Each group is a set of substrings that must ALL appear on the same mock-gh-log
   *  line (order-independent, so argument reordering doesn't make this brittle). */
  mustCallGh: string[][];
  /** Each group is a set of substrings that must NOT all appear together on any one
   *  mock-gh-log line (e.g. acting on an issue that should have been skipped). */
  forbiddenGhCalls: string[][];
  /** None of these may appear in any Bash tool command the session ran — signals of
   *  an invented/vendor-specific tool rather than the plain shell instructions in the
   *  skill body. */
  forbiddenInCommands: string[];
}

export interface SkillRuntimeScenario {
  /** Slug used for result keys. */
  id: string;
  title: string;
  /** Directory name under evals/skill-runtime/fixtures/ holding the fixed SKILL.md. */
  fixtureDir: string;
  /** The prompt given to the fresh runtime session. */
  task: string;
  rubric: RuntimeRubric;
}
