# Review gates — shared by the review-class agents

**Read this before writing your first finding.** It holds the parts of a review pass that are identical across agents: the bar a finding must clear, the proof a top-severity finding must carry, and the catalogue of things that look like defects and are not.

**Who reads this:** `mc-reviewer`, `code-improver`, `security-auditor`, `watchdog`. Each keeps its own mandate, severity vocabulary and output format — this file governs only the *gate*, not the job.

**Who deliberately does not:** `investigator`. Its Iron Law (no fix without a demonstrated root cause, every claim backed by evidence you produced) is a stricter gate than §1, and §4 is a catalogue of reasons *not to report* — the wrong instinct to hand an agent chasing a defect that is already known to be real. Pointing it here would add a weaker rule and a contrary instinct. If that judgement is ever revisited, revisit it here.

**Why it is one file.** Four agents applying four drifting copies of the same gate is the duplication `watchdog` exists to catch. One file, four pointers. When the gate changes, it changes once. (The reference library this was drawn from gets this exactly backwards: it pastes an identical eight-line *defence boilerplate* into 67 of its 68 agent files, while the material below — the part worth propagating — appears in two files and one file respectively. Duplicated where it costs, absent where it pays.)

---

## 1. The pre-report gate

Answer all four before a finding gets written down. Any "no" or "not sure" means downgrade the severity or drop it.

1. **Can I cite the exact line?** File and line number. "Somewhere in the auth layer" is not a finding — nobody can act on it and nobody can refute it.
2. **Can I name the concrete failure?** Input, state, observable bad outcome. If you cannot name the trigger, you are pattern-matching on shape, not reviewing behaviour.
3. **Have I read the surrounding context?** Callers, imports, types, tests. Most apparent defects are already handled one frame up, narrowed by a type, or pinned by a test as deliberate.
4. **Is the severity defensible?** A missing docstring is never top severity. One `any` in a test fixture is never critical. Severity inflation destroys trust faster than a missed finding does, because it teaches the reader to skim.

## 2. Top-severity findings carry proof

Anything you tag at your agent's highest severity — `HIGH`, `CRITICAL`, `blocks merge` — must include three things:

- the exact snippet and its line number;
- the specific failure scenario: input, state, outcome;
- **why the existing guards do not catch it** — the types, the validation layer, the framework default, the test that already covers it.

The third is the one reviewers skip and the one that does the work. A finding that cannot say why the type system, the validator or the framework fails to stop it is usually a finding that they do stop. Missing any of the three: demote or drop.

## 3. Zero findings is a valid result

A clean pass is a real outcome, and saying so plainly is a real deliverable. Do not manufacture findings to justify the dispatch.

Padding is the primary failure mode of an automated reviewer, and it takes four recognisable forms: filler nits, speculative "consider using X", hypothetical edge cases with no named trigger, and restated linter rules. Each one costs the reader attention they will not have for the finding that mattered.

The corollary matters as much: a report that is entirely low-severity should say so in its summary rather than presenting nits as a review.

## 4. Common false positives

These are the patterns an LLM reviewer habitually mis-flags. **Each entry is a conditional skip, not a blanket exemption** — the condition names the check you owe before skipping. Skipping without running the check is the same defect as flagging without evidence, pointed the other way.

| Looks like | Skip it when | The check you owe first |
|---|---|---|
| "Consider adding error handling" | The error path is handled by the caller or the framework — error middleware, error boundary, top-level `try`/`catch`, an upstream `.catch` | Find the handler. Name it in your notes. If you cannot find one, it is a finding |
| "Missing input validation" | The function is internal and its callers already validate | Trace **at least one** real caller. Not "presumably validated upstream" |
| "Magic number" | It is a well-known constant — HTTP status codes, `1000` ms, `60`, `24`, `1024`, index `0` / `-1` — or a single-use local whose name already says what it means | Read the variable name. If the name explains it, the number is not magic |
| "Function too long" | It is an exhaustive `switch`, a config object, a test table, or generated code | Length is not complexity. Count branches, not lines |
| "Missing docstring / JSDoc" | Single-purpose internal helper whose name and signature are self-describing | Would a reader of the call site be confused? If not, skip |
| "Possible null dereference" | The preceding line narrows the type, or an `if` guard is in scope | Trace the type flow. Do not pattern-match on `?.` |
| "N+1 query" | Fixed-cardinality loop (iterating a four-member enum), or the path already batches | Establish that N grows with input. If N is bounded and small, skip |
| "Missing `await`" | The call is deliberately detached — logging, metrics, a background queue push | Look for a `void` prefix or a comment saying so. Absent both, it is a finding |
| "Should use types / should be TypeScript" | The file is in a language the project chose | Never propose a stack change as a review finding |
| "Hardcoded value" | It is in a test fixture, example, or documentation snippet | Tests are *supposed* to hardcode their expectations |
| Security theatre | `Math.random()` in a non-cryptographic context (animation, jitter, sampling); `eval` in a plugin system that is explicitly a code-loading surface | Name the threat. No threat, no finding |
| "Prefer `const`" | The variable is reassigned | Read the whole function first |

**The senior-engineer test.** When tempted to flag one of the above anyway, ask: *would a senior engineer on this team actually change this in review?* If no, it does not go in the report.

## 5. What this file does not license

- It is not permission to skip a check because a finding *resembles* a row above. The condition column is binding.
- It is not a ceiling on severity. A row here can still be a real defect in a specific codebase — the catalogue tells you to verify, not to disbelieve.
- It does not replace your agent's own mandate, boundaries, or output format. Where this file and your definition disagree on scope, your definition wins; where they disagree on the evidence bar, this file wins.
- It does not apply to a *completeness gap* — a case that was never written has no failure scenario by construction. Gaps meet their bar by naming the missing case and what closing it would take, and are reported as their own category, not as defects.
