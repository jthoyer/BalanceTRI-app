# Session cold start — the first turn is not a measurement

**Who reads this:** any agent that judges what the session *has* — which agents exist,
whether a skill is installed, whether the library is present. `CPO`, `cos`,
`mc-orchestrator` above all, because each opens by taking stock.

## The rule

**Never conclude that something is absent from a reading taken on the first turn of a
fresh session.** A cloud container is still assembling itself while the first turn runs:
the repo checkout, its `.claude/agents/`, and any declared plugin can all register a
moment after the session starts answering. An empty roster on turn 1 is as likely to mean
"too early" as "not there".

Two sightings, both on 2026-09-12, both recovering on the very next turn with nothing
changed in between:

| What was asked | Turn 1 | Turn 2 |
|---|---|---|
| Which agents are available? (fresh cloud session on a repo carrying 16) | **none** | all 16, 22 types total |
| Is the declared plugin loaded? (`enabledPlugins` in user settings) | **no** | yes, all 16 agents |

The first of those very nearly became a published finding that "committed agents don't
reach cloud sessions" — the opposite of the truth.

## What to do instead

- **Read the filesystem, not the roster.** `ls .claude/agents/*.md` is authoritative and
  available immediately. The session's list of usable agent types is not, on turn 1.
- **If a turn-1 reading says "absent", say "not yet confirmed", not "absent".** Re-check on
  a later turn before recording it anywhere that outlives the session.
- **Name which one you took.** A reader cannot tell a resolved negative from a cold-start
  artefact unless you say which turn produced it.

## What this does *not* cover

The **dispatch probe** in `CPO.md` reads whether an `Agent`/`Task` tool exists in the
session's tool list. That is a harness tool, present from turn 1, so a negative there is
genuinely resolved and this file does not soften it. The lag affects the *roster* — which
agent types are listed — not the *tool*. Keep the two apart: conflating them turns a real
finding into an excuse.
