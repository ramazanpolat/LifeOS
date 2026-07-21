# LifeOS 7.1.1 — LifeOS (the Life Operating System)

> **LifeOS is the Life OS. The DA is the principal's AI assistant. Pulse is the Life Dashboard.**
> Canonical thesis: `runtime/LIFEOS/DOCUMENTATION/LifeOs/LifeOsThesis.md`. Everyone running LifeOS names their own DA. LifeOS targets AS3 on the LifeOS Maturity Model, with lineage from "The Real Internet of Things" (2016).

## Playbook bootstrap

This is the LifeOS claude-playbook — an isolated Claude Code instance whose config root (`$CLAUDE_CONFIG_DIR`) is this checkout. LifeOS self-deploys from the payload in `LifeOS/install/` into the config root via `bin/deploy.ts`; nothing is written outside this directory.

- If `runtime/LIFEOS/` does not exist, LifeOS is **not deployed yet**. Tell the user, then offer the dry-run report: `bun "$CLAUDE_CONFIG_DIR/bin/deploy.ts"`. With their consent, apply it: `bun "$CLAUDE_CONFIG_DIR/bin/deploy.ts" --apply`.
- After a deploy, suggest restarting the session so the deployed `settings.json` and `hooks/` are loaded.
- If `runtime/LIFEOS/` already exists, LifeOS is deployed — proceed normally.

@runtime/LIFEOS/DOCUMENTATION/ARCHITECTURE_SUMMARY.md
# Identity @-imports below are ACTIVE in this playbook build. Upstream ships them commented out and the agentic `/lifeos-setup` (via `Tools/ActivateImports.ts`) uncomments them; here they are pre-activated. Claude Code silently skips a missing @-import, so they dangle harmlessly until deploy scaffolds runtime/LIFEOS/USER/. This CLAUDE.md is a static file — deploy never mutates it.
# Claude Code does not follow transitive @-imports, so each must be listed here directly.
@runtime/LIFEOS/USER/TELOS/PRINCIPAL_TELOS.md
@runtime/LIFEOS/USER/PRINCIPAL/PRINCIPAL_IDENTITY.md
@runtime/LIFEOS/USER/DIGITAL_ASSISTANT/DA_IDENTITY.md
@runtime/LIFEOS/USER/PROJECTS.md
@runtime/LIFEOS/USER/CONFIG/OPERATIONAL_RULES.md

## Constitutional layer

Constitutional rules, the unified response format, verification doctrine, hard prohibitions, security protocol, and operational rules all live in the system prompt: `runtime/LIFEOS/LIFEOS_SYSTEM_PROMPT.md`. When this file and the system prompt disagree, the system prompt wins.

This file is the **routing table** — it tells you where everything lives. The only mandatory startup `@`-import shipped with public LifeOS is `ARCHITECTURE_SUMMARY`. The five identity files (`PRINCIPAL_TELOS`, `PRINCIPAL_IDENTITY`, `DA_IDENTITY`, `PROJECTS`, `OPERATIONAL_RULES`) are activated above: in upstream they ship commented out and the agentic `/lifeos-setup` (via `Tools/ActivateImports.ts`) uncomments them once the principal's USER scaffold is populated; in this playbook build they are already active, so they resolve automatically the moment deploy scaffolds `runtime/LIFEOS/USER/` and stay silently skipped before that. Claude Code does not follow transitive `@`-imports from inside imported files, so each identity file must be listed here at top level. Everything below is **on-demand** lookup. Paths are relative to the playbook config root (`$CLAUDE_CONFIG_DIR`) unless noted.

## LifeOS System (paths under `runtime/LIFEOS/DOCUMENTATION/` unless noted)

- **Life OS thesis** — `LifeOs/LifeOsThesis.md` (canonical source of truth)
- **Life OS schema** — `LifeOs/LifeOsSchema.md` (biography-flat, PascalCase, frontmatter contract)
- **System prompt** — `runtime/LIFEOS/LIFEOS_SYSTEM_PROMPT.md` (loaded via `--append-system-prompt-file`; home of the constitutional rules and response format)
- **System architecture** — `LifeosSystemArchitecture.md` (master doc)
- **Architecture summary** — `ARCHITECTURE_SUMMARY.md` (loaded via @-import)
- Algorithm (the unified thinking system) — `Algorithm/AlgorithmSystem.md`
- Memory — `Memory/MemorySystem.md`
- Skills — `Skills/SkillSystem.md`
- Hooks — `Hooks/HookSystem.md`
- Agents — `Agents/AgentSystem.md`
- Delegation — `Delegation/DelegationSystem.md`
- Security — `Security/README.md`
- Notifications — `Notifications/NotificationSystem.md`
- Observability — `Observability/ObservabilitySystem.md`
- Pulse — `Pulse/PulseSystem.md`
- Pulse metadata catalog (badges/strips/panels) — `Pulse/PulseMetadata.md`
- DA subsystem (design) — `Pulse/DaSubsystem.md`
- CLI tools (Algorithm + Arbol) — `Tools/Cli.md`
- CLI-first architecture — `Tools/CliFirstArchitecture.md`
- Configuration — `Config/ConfigSystem.md`
- Containment policy — `Tools/Containment.md`
- Arbol (cloud execution) — `Arbol/ArbolSystem.md`
- Feed — `Feed/FeedSystem.md`
- Fabric — `Fabric/FabricSystem.md`
- Freshness convention (`pai-freshness-v1`) — `Freshness/FreshnessSystem.md`
- Terminal tabs — `Pulse/TerminalTabs.md`
- Tools reference — `Tools/Tools.md`
- ISA — `ISA/IsaSystem.md`
- ISA format spec — `ISA/IsaFormat.md`
- Testing doctrine — `Testing/TestingDoctrine.md`
- System/user boundary — `SystemUserBoundary.md` (which files are SYSTEM, which are USER, how the boundary is enforced)
- AI writing patterns (system-level reference) — `Writing/AIWritingPatterns.md`
- Browser automation — `Skill("Interceptor")` (real Chrome, mandatory for verification)
- Claude Code knowledge — `Agent(subagent_type="claude-code-guide")`

## Principal — Identity & Voice (paths under `runtime/LIFEOS/USER/`)

Populated during `/lifeos-setup`. Typical layout:

- Principal identity — `PRINCIPAL/PRINCIPAL_IDENTITY.md` (canonical, @-imported)
- Career & resume — `PRINCIPAL/RESUME.md`
- Writing style — `PRINCIPAL/WRITINGSTYLE.md`
- Pronunciations — `PRINCIPAL/PRONUNCIATIONS.json` (TTS rules — Pulse VoiceServer reads this)
- Contacts — `CONTACTS.md`
- Definitions — `DEFINITIONS.md`
- Core content themes — `CANONICAL_CONTENT.md`

## Principal — Life Goals

- TELOS (single source of truth, unified H2 sections) — `runtime/LIFEOS/USER/TELOS/TELOS.md`
- Auto-generated derivative — `runtime/LIFEOS/USER/TELOS/PRINCIPAL_TELOS.md`
- Dimension percentages — `runtime/LIFEOS/USER/TELOS/LIFEOS_STATE.json` (Pulse rings + statusline read from this)
- Freshness convention — see `runtime/LIFEOS/DOCUMENTATION/Freshness/FreshnessSystem.md`

## Principal — Work (paths under `runtime/LIFEOS/USER/`)

- Business — `BUSINESS/`
- Health — `HEALTH/`
- Finances — `FINANCES/`
- Integration configs — `INTEGRATIONS/*.yaml`
- Work system — `WORK/config.yaml`
- Secrets — `.env` at the playbook config root (`$CLAUDE_CONFIG_DIR/.env`; canonical; see OPERATIONAL_RULES.md)

## Project-Specific Rules

Drop project-scoped CLAUDE.md files alongside each project (e.g. `~/code/your-project/CLAUDE.md`) for rules that only apply inside that codebase. Claude Code merges them with this global file when sessions start in that directory. Use them for invariants that bite repeatedly — "always use the X helper, never bare Y" — so the rule lives next to the code it governs.
