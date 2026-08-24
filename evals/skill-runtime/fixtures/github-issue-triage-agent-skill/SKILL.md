---
name: github-triage-unassigned-bugs
description: "Use when asked to triage, sweep, or process new/unassigned bug reports in a GitHub repo — for each open issue labeled 'bug' with no assignee, ask the reporter for repro steps/version and label it 'needs-info'."
allowed-tools:
  - Bash(gh issue list *)
  - Bash(gh issue comment *)
  - Bash(gh issue edit *)
  - Bash(gh issue view *)
---

## When to use

Use this skill when asked to triage, sweep, or process newly reported bug issues in a GitHub repo — specifically to find open issues labeled `bug` that have no assignee, and make sure each one has been asked for reproduction details and marked as waiting on the reporter.

This is a repeatable, repo-wide sweep: it must handle every matching issue found at run time, not just one.

## Procedure

1. **List unassigned open bug issues.** Run:
   ```
   gh issue list --repo northlight-labs/gateway-service --label bug --search "no:assignee" --state open --json number,title,labels
   ```
   This gives the full, current set of open, unassigned bug issues — the collection to iterate over.

2. **Filter out already-triaged issues.** From the JSON result, drop any issue whose `labels` already include `needs-info` — it's already been asked for info, so re-commenting would be noisy and redundant. What remains is the set that genuinely still needs triage. If this set is empty, skip straight to the report step and say so.

3. **For each remaining issue, post the triage comment.** For every issue number left after filtering, run:
   ```
   gh issue comment <number> --repo northlight-labs/gateway-service --body "Thanks for the report! Could you share exact reproduction steps and the version you're on?"
   ```
   This asks the reporter for exact reproduction steps and the version they're on, using the same wording each time for consistency.

4. **For each remaining issue, apply the needs-info label.** Immediately after commenting on an issue, run:
   ```
   gh issue edit <number> --repo northlight-labs/gateway-service --add-label "needs-info"
   ```
   This marks the issue as waiting on the reporter so it won't be re-triaged on the next sweep and is easy to filter out later.

   Do the comment-then-label pair for each issue in the filtered set before moving to the next issue, so a failure partway through only affects that one issue and is easy to spot.

5. **Report results.** Summarize how many issues were triaged (commented on + labeled) in this run, listing each one's number and title. If no issues matched the filter (or all were already labeled `needs-info`), say so explicitly instead of silently doing nothing.

## Edge cases

- **No matching issues**: report zero triaged, don't error out.
- **`gh` not authenticated or repo inaccessible**: surface the error from the `gh` command rather than guessing; don't retry silently.
- **An issue closed or got an assignee between steps 1 and 3/4**: `gh issue comment`/`gh issue edit` will still succeed against a specific issue number; if a command fails for one issue, report the failure for that issue and continue with the rest rather than aborting the whole sweep.
