# LifeOS as a claude-playbook

This repository doubles as a [claude-playbook](https://github.com/ramazanpolat/claude-playbooks):
an isolated Claude Code instance whose config root is the cloned repo itself. A
playbook install never touches your default `~/.claude` — LifeOS, its hooks,
skills, agents, and your personal USER data all live inside the playbook
directory.

LifeOS ships a payload in `LifeOS/install/`. A deterministic deploy script
(`bin/deploy.ts`) overlays that payload onto the config root. The playbook
self-deploys on first run: the launched session detects an undeployed checkout
and offers to run the deploy for you.

## Install

```sh
claude-playbook install https://github.com/ramazanpolat/LifeOS --name lifeos --alias lifeos
```

This clones the repo to `~/.claude-playbooks/lifeos/` and registers the
`lifeos` alias, which launches Claude Code with `CLAUDE_CONFIG_DIR` pointed at
that directory.

## First run

Launch the playbook:

```sh
lifeos
```

On first launch `runtime/LIFEOS/` does not exist yet, so LifeOS is not deployed.
The session detects this, tells you, and offers to run the deploy — a dry-run
report first, then the apply with your consent.

To deploy by hand instead:

```sh
# dry-run report (no changes)
CLAUDE_CONFIG_DIR=~/.claude-playbooks/lifeos bun ~/.claude-playbooks/lifeos/bin/deploy.ts

# apply
CLAUDE_CONFIG_DIR=~/.claude-playbooks/lifeos bun ~/.claude-playbooks/lifeos/bin/deploy.ts --apply
```

`--apply` deploys the core (settings, hooks, skills, agents, commands, runtime,
the USER scaffold + symlink, and `bun install`). Add `--full` to also apply the
enhancements (statusline, tooltips, spinner verbs). The deploy is idempotent: it
never overwrites files you have modified, and it never touches the `LifeOS/`
payload.

After deploying, restart the `lifeos` session so the freshly written
`settings.json` and `hooks/` load.

## What deploy places where

Everything lands at the playbook config root (`$CLAUDE_CONFIG_DIR`):

| Path | Contents |
|---|---|
| `settings.json` | Claude Code settings for this instance (hooks, statusline wiring) |
| `hooks/` | LifeOS hook scripts |
| `skills/` | LifeOS skills |
| `agents/` | LifeOS subagents |
| `commands/` | LifeOS slash commands |
| `runtime/LIFEOS/` | The LifeOS system tree (DOCUMENTATION, ALGORITHM, PULSE, RULES, TOOLS, the system prompt, …) |
| `USER/` | Your personal LifeOS data; `runtime/LIFEOS/USER` is a symlink into it |

All of these are gitignored — they are per-install runtime state, not part of the
tracked repo.

## Why `runtime/LIFEOS/`, not `LIFEOS/`

macOS uses a case-insensitive filesystem. The tracked payload directory is
`LifeOS/`, and a top-level runtime tree named `LIFEOS/` would collide with it
(the two names are indistinguishable to the filesystem). Deploying the runtime
under `runtime/LIFEOS/` sidesteps the collision while keeping the familiar
`LIFEOS/...` path layout intact one level down. The playbook's `CLAUDE.md`
routing table and `@`-imports reference `runtime/LIFEOS/...` accordingly.

## Isolation guarantees

- Nothing is written to `~/.claude`. The config root is the playbook directory.
- The deploy only writes inside the config root, and only the gitignored runtime
  paths — never the tracked `LifeOS/` payload.
- Your personal data lives in `USER/` inside the playbook directory, not in a
  shared location.

## Updating

```sh
claude-playbook update lifeos
```

This runs `bin/update-playbook.sh`, which refuses if you have local
modifications to tracked files, fast-forwards the checkout (`git pull
--ff-only`), then re-runs `bun bin/deploy.ts --apply` to re-overlay the runtime.
Because the deploy is idempotent and never overwrites user-modified files, your
customizations and USER data survive the update.

## Uninstall

```sh
claude-playbook delete lifeos
```

Warning: your personal LifeOS data lives in `USER/` **inside** the playbook
directory (`~/.claude-playbooks/lifeos/USER/`). Deleting the playbook deletes
that data. Back up `~/.claude-playbooks/lifeos/USER/` first if you want to keep
it.

## Loading the LifeOS system prompt

LifeOS's constitutional layer (response format, verification doctrine,
prohibitions) lives in a system prompt at
`runtime/LIFEOS/LIFEOS_SYSTEM_PROMPT.md`. Claude Code loads it via
`--append-system-prompt-file`. The playbook alias can carry extra `claude` flags,
so the recommended manual tweak is to append the flag to the `lifeos` alias:

```sh
--append-system-prompt-file "$CLAUDE_CONFIG_DIR/runtime/LIFEOS/LIFEOS_SYSTEM_PROMPT.md"
```

With that flag on the alias, every `lifeos` session boots with the full LifeOS
system prompt in addition to the `CLAUDE.md` routing table. Apply it after the
first successful deploy, since the file only exists once `runtime/LIFEOS/` is
in place.
