# PA Dashboard

A visual task board where **an agent grooms and you decide.** Tasks, goals,
and routines live as plain markdown files in a vault folder. The dashboard
renders them as a Kanban board. A "Groom my day" action asks an agent to
propose what you should focus on today — and you approve or dismiss its
suggestions. No data entry, no second database to maintain.

> Built as a vibe-coded weekly project for an Agentic-AI class. Public repo;
> personal data and absolute paths are kept out by `.gitignore` and an
> automated [privacy lint](#privacy-lint).

## Quick start

```bash
bun install
bun run dev            # boots server (3000) + Vite (5173) together
# then open http://127.0.0.1:5173
```

The default boot uses `./sample-vault` and a deterministic `MockAgent`,
so you see a populated board with three columns of work the moment the
page loads. Click **Groom my day** to watch the agent propose changes;
the batch-review modal opens with Approve / Dismiss for each row.

## How it works

```
   ┌─────────────────────────────────────────────────────────────┐
   │  vault (markdown files — the single source of truth)         │
   │     tasks/  goals/  routines/  projects/                     │
   └──────────────────▲──────────────────────────▲────────────────┘
                      │ atomic write             │ direct read
       ┌──────────────┴───────────────┐          │
       │  Bun server                  │          │
       │   - MarkdownRepository       │          │
       │   - chokidar watcher → WS    │          │
       │   - /api (tasks, agent,      │          │
       │     suggestions)             │          │
       │   - path sandbox + token     │          │
       │     auth + CSRF              │          │
       └────────────┬─────────────────┘          │
                    │ JSON Suggestion[]          │ read-only
       ┌────────────▼──────────────────┐         │
       │  AgentProvider                │         │
       │   MockAgent (default)         │         │
       │   HermesAgent (subprocess     │         │
       │     `hermes -z`)              │         │
       └───────────────────────────────┘         │
                                                  │
                  ┌───────────────────────────────┴─────────┐
                  │  Web UI (React + Vite + dnd-kit)         │
                  │   - Kanban with drag-drop                │
                  │   - Groom button + batch-review modal    │
                  │   - WS auto-reconcile + optimistic state │
                  └──────────────────────────────────────────┘
```

A suggestion is stored in the target file's frontmatter as
`agent_suggests: {patch, reason, base_version, provider, created_at}`.
Approving applies the patch + clears the suggestion in one atomic write.
Dismissing also stamps `agent_dismissed_at` so the agent doesn't propose
the same thing again for 24 hours.

## Configuration

All env vars live in `.env` (gitignored). Defaults work for localhost dev.

| Variable | Default | Purpose |
|---|---|---|
| `VAULT_PATH` | `./sample-vault` | Vault directory the dashboard reads/writes |
| `PORT` | `3000` | Server port |
| `BIND_HOST` | `127.0.0.1` | Server bind address; non-loopback requires `DASHBOARD_TOKEN` |
| `DASHBOARD_TOKEN` | unset | Required for LAN exposure (see [LAN access](#lan-access)) |
| `AGENT_PROVIDER` | `mock` | `mock` or `hermes` |
| `HERMES_BIN` | auto-detect | Path to the `hermes` binary |
| `HERMES_TIMEOUT_MS` | `90000` | Max time per agent call before SIGKILL |
| `LOG_LEVEL` | `info` | `info` or `debug` |

Copy `.env.example` to `.env` to get a commented template.

## Using your own vault (recommended once you start grooming for real)

Don't groom against the committed `sample-vault/` — every `Groom my day`
click writes `agent_suggests:` blocks into the files, which then show
up as dirty in `git status`. Use a separate dev vault:

```bash
cp -R sample-vault dev-vault
echo "VAULT_PATH=./dev-vault" >> .env
bun run dev
```

`dev-vault/`, `private-vault/`, and `real-vault/` are all gitignored.

## Live Hermes agent

The `MockAgent` ships in this repo so anyone can clone-and-run the demo
without external setup. To switch to a real LLM agent via
[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent):

```bash
# hermes must be installed and authenticated; verify with `hermes status`
echo "AGENT_PROVIDER=hermes" >> .env
bun run dev
```

The server probes `hermes --version` at startup; if it can't find the
binary, it logs a warning and the `MockAgent` fallback kicks in
automatically when groom is invoked. There is a 3-strike circuit breaker
so a wedged Hermes never hangs the dashboard — three consecutive
failures and the server uses the mock until it's restarted.

## LAN access (Mac Mini → MacBook)

The server refuses to bind a non-localhost host without a token. To
expose the dashboard on your local network:

```bash
# .env (server side)
BIND_HOST=0.0.0.0
DASHBOARD_TOKEN=$(openssl rand -hex 32)

# web/.env (build the bundle with the matching client token)
echo "VITE_DASHBOARD_TOKEN=<same token as above>" > web/.env
bun run web:build
bun run server:start    # serve the built bundle however you prefer
```

Once a token is set:
- `GET` endpoints stay open (the board can render for any viewer)
- `POST` / `PATCH` / `DELETE` require `X-Dashboard-Token` matching the env var
- `/api/ws` upgrade requires `?token=<token>` on the URL
- Cross-site mutating requests are rejected via `Sec-Fetch-Site` /
  `Origin` checks (CSRF defense)

## Scripts

```bash
bun run dev            # server + web together (Ctrl-C tears down both)
bun run server:dev     # server only (watch mode)
bun run web:dev        # vite only
bun run web:build      # production bundle
bun run typecheck      # server + web TS check
bun run lint           # privacy lint over ./sample-vault
bun test               # run the test suite (138 tests)
```

## Privacy lint

`scripts/privacy-lint.ts` scans the committed vault for personal-data
leaks (first names, hostnames, absolute paths). It runs as a regular
test in the suite — every `bun test` also asserts the public fixtures
are clean. The denylist lives in the script itself; edit it if you
fork this for your own vault.

## Architecture decisions

The full set of decisions and rationales lives in the
[design doc](#) (kept locally in `~/.gstack/projects/`, outside the
repo so it doesn't drift). The user-visible commitments:

- **Files are the single source of truth.** Agents read/write the same
  markdown you do. No second store to keep in sync.
- **Lex ranks** (`a..z` strings) for column order, so a drag rewrites
  exactly one card's `order` field instead of N siblings.
- **`contentHash` excludes `agent_suggests`** so writing a suggestion
  doesn't invalidate its own base version. Approving compares
  `agent_suggests.base_version` against the file's current hash; if
  the file drifted (e.g., you dragged it after grooming), the suggestion
  is marked stale.
- **Server is the sole writer of `agent_suggests:`.** The agent returns
  typed `Suggestion[]`; the server validates and writes. Closes Hermes's
  `--yolo` trust boundary at the code level, not the prompt level.
- **Atomic writes via tmp + rename** plus a watcher self-write window so
  the server's own writes don't echo back through the file watcher and
  clobber the UI's optimistic state.
- **Path sandbox** at every read and write: `assertUnderVault` rejects
  paths that escape via `..` or symlinks pointing outside (or, defense
  in depth, even pointing inside).

## Roadmap

Current scope is the class submission: Kanban + Groom + batch
approve/dismiss + drag + WS reconcile + path/auth hardening. Parked
for follow-ups:

- Timeline (Gantt) view
- Calendar view
- Cron grooming (Hermes scheduler hosts the recurring job)
- A task-vault MCP server so Hermes can call typed tools instead of
  raw file edits
- SQLite cache for fast queries on bigger vaults
- gbrain integration

## License

MIT.
