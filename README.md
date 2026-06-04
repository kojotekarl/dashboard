# Pepper Dashboard

A visual work board where **an agent does the upkeep and you just decide.**

Tasks, goals, and routines live as plain markdown files in a vault folder. The dashboard
renders them as a Kanban board. A "groom my day" action asks an agent to propose what you
should focus on today — and you approve or dismiss its suggestions. No data entry, no second
database to maintain.

> Status: early — Kanban view + "groom my day" first. Timeline and calendar views come later.

## The idea

Most task apps store your work in their own database, which is why agents are awkward with
them and why keeping them current becomes the work. Here the **markdown files are the single
source of truth**: the agent reads and writes the same files you do, so there's nothing to sync
and the upkeep can be handed off. The board is just a view over those files.

That makes the agent the point, not a bolt-on: it grooms (sorts, flags what's slipping,
proposes today's focus); you triage (look, approve, drag).

## Quick start

```bash
cp .env.example .env      # defaults work out of the box
# install + run (commands finalized as the app is built)
# the app reads ./sample-vault, so you get a populated board immediately
```

By default `VAULT_PATH=./sample-vault` and `AGENT_PROVIDER=mock`, so it runs with example data
and a no-external-calls agent. Point `VAULT_PATH` at your own vault, or set `AGENT_PROVIDER=hermes`
with a gateway, when you want the real thing.

## "Groom my day"

1. The board shows your cards across columns (Backlog / Today / In Progress / Blocked / Done).
2. Click **Groom my day** — the agent proposes a Today set, each suggestion with a one-line *why*.
3. Suggestions appear as ghosted states on the cards. **Approve** the batch (or dismiss individual
   ones) — approved changes are written back to the markdown files.

A suggestion is stored as a pending diff (`pepper_suggests:`) in the file, so nothing lives
outside the vault.

## Architecture

```
vault (markdown files)  <-- single source of truth
   tasks/  goals/  routines/  projects/
        ^                ^
        | reads/writes   | reads/writes
   dashboard app      agent (groom my day)
   (Kanban view)
```

Two swap-in seams keep it flexible:
- **TaskRepository** — markdown today; a SQLite read-cache can slot in later for speed.
- **AgentProvider** — `MockAgent` (default, offline) or `HermesAgent` (your own gateway).
  Configured by env, so no agent secrets ever live in the code.

## Roadmap

- Timeline (Gantt) and calendar views, plus a combined overlay
- Goals-driven auto-rescheduling
- A typed agent tool layer (MCP) that enforces "propose vs apply" at the boundary
- Scheduled overnight grooming

## License

MIT
