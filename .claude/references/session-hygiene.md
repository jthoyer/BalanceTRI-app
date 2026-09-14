# Session hygiene — compact and clear, on purpose

**Who reads this:** any agent that persists a Stage Register or Handoff Note (the `mc-*` playbook, `multi-actor-research`, `multi-actor-strategy`), and any agent that runs a continuous session across several unrelated pieces of work (`CPO`, `cos`).

## The rule

Longer sessions cost more even with prompt caching — the transcript still gets carried and re-processed on every turn. Two commands manage that, and neither is something an agent calls itself; both are user-issued CLI actions, so an agent's job is to name the moment and prompt for them, not to invoke them.

- **`/compact` mid-task, at a checkpoint where the work needed to resume is already written down** — a Stage Register on disk, a Handoff Note, a closed step. Compacting after that point loses nothing: the persisted record, not the transcript, is what the next stage reads from.
- **`/clear` when switching to a new task** — a request that shares nothing with the one just finished inherits no useful context from it. Carrying a finished task's transcript into an unrelated one is pure cost with no resumability benefit to show for it.

## What that looks like in practice

- The moment a Stage Register (or equivalent close-out) lands on disk, say so and name it as a safe checkpoint: "Stage 2 closed, register at `<path>` — safe to `/compact` here."
- Don't prompt for `/compact` before the register exists. That is the one case where compacting genuinely costs resumability, not just tokens.
- When a new, unrelated request arrives in the same session, recommend `/clear` rather than continuing in a transcript the new request doesn't need.
- State it once per checkpoint. Repeating the reminder every turn is its own noise cost.

## Why this file is short

The mechanism these commands replace already existed here as the "Compress-and-Carry-Forward Prompt" in the `multi-actor-research`/`multi-actor-strategy` stage-register references — paste the register into a fresh conversation by hand. `/compact` and `/clear` are the same idea, built into the CLI, and cheaper to invoke than to explain. That manual path still works when the tooling isn't available; this file just says to reach for the built-in one first.
