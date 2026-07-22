#!/usr/bin/env bun
/**
 * deploy.ts — LifeOS claude-playbook deployer.
 *
 * The repo checkout root IS a Claude Code config dir (a "claude-playbook":
 * CLAUDE_CONFIG_DIR = checkout root). This script deterministically deploys the
 * upstream payload staged under `LifeOS/install/` INTO the checkout root.
 *
 *   <CR>  = absolute checkout root (dirname of this bin/ dir — NO --config-root
 *           flag; the script always operates on its own repo root).
 *   <RT>  = <CR>/runtime/LIFEOS  (the runtime tree; NOT <CR>/LIFEOS, because the
 *           filesystem is case-insensitive and a top-level LIFEOS/ would collide
 *           with the payload dir LifeOS/).
 *
 * CLI:
 *   bun bin/deploy.ts            dry-run: print the plan, write nothing.
 *   bun bin/deploy.ts --apply    deploy core.
 *   bun bin/deploy.ts --apply --full   also wire statusLine + spinner enhancements.
 *
 * Idempotent: every copy goes through copyMissing (never overwrites); the
 * path-rewrite and token-substitution passes are no-ops on already-deployed
 * files; an existing settings.json is left untouched.
 *
 * Reuses the upstream engine (InstallEngine.ts) for copyMissing / mergeHooks /
 * substituteTree / setupUserSeparation / checkSymlinkContract. It does NOT shell
 * out to DeployCore / InstallSettings / InstallHooks — their targets hard-code
 * <configRoot>/LIFEOS and ~/.claude, both wrong for this layout.
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  checkSymlinkContract,
  copyMissing,
  mergeHooks,
  setupUserSeparation,
  substituteTree,
} from "../LifeOS/Tools/InstallEngine";

// ── paths ─────────────────────────────────────────────────────────────
const CR = dirname(import.meta.dir); // checkout root = parent of bin/
const RT = join(CR, "runtime", "LIFEOS");
const PAYLOAD = join(CR, "LifeOS", "install");
const REAL_HOME = homedir();

// ── args ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const FULL = argv.includes("--full");

// ── engineering-log output helpers ────────────────────────────────────
function log(msg = ""): void {
  console.log(msg);
}
function die(msg: string): never {
  console.error(`\nFATAL: ${msg}`);
  process.exit(1);
}

/** expandLeadingHome — reimplemented (importing InstallSettings.ts would run its
 * top-level main() + process.exit). Expands a LEADING $HOME/${HOME}/~ segment. */
function expandLeadingHome(value: string, home: string): string {
  if (!home) return value;
  if (value === "$HOME" || value === "${HOME}" || value === "~") return home;
  if (value.startsWith("$HOME/")) return home + value.slice("$HOME".length);
  if (value.startsWith("${HOME}/")) return home + value.slice("${HOME}".length);
  if (value.startsWith("~/")) return home + value.slice(1);
  return value;
}

// ── path-rewrite rules (longest-first) ────────────────────────────────
// STRHOME: home token in a shell/string/path context ($HOME, ${HOME},
//          ${process.env.HOME}, ~).
// HOMETOK: home token in a JS constructor context (homedir(), os.homedir(),
//          process.env.HOME[!], or any UPPER_SNAKE identifier ending in HOME —
//          e.g. HOME, DEFAULT_HOME — optionally with a `|| '...'` fallback).
// Boundaries anchor `.claude`/`LIFEOS` to a real segment end (/, quote, ws,
// backtick, EOL) — never `-`, so `.claude-playbooks` and already-rewritten
// absolute roots never match (idempotency + no corruption of unrelated paths).
const STRHOME = "(?:\\$\\{HOME\\}|\\$HOME|\\$\\{process\\.env\\.HOME!?\\}|~)";
// HOMETOK matches a home value in a JS expression: homedir()/os.homedir(),
// process.env.HOME[!], or a bare identifier that IS the home dir — lowercase
// `home` or any UPPER_SNAKE name ending in HOME (HOME, DEFAULT_HOME) — each
// optionally with a `|| '...'` fallback. Bounded so `chrome`, `.home`,
// `atHOME`, `process.env.HOME` (as bare id) never mis-match.
const HOMETOK =
  "(?:(?:os\\.)?homedir\\(\\)|process\\.env\\.HOME!?|(?<![.\\w$])(?:home|[A-Z_]*HOME)(?![.\\w]))" +
  "(?:\\s*\\|\\|\\s*['\"][^'\"]*['\"])?";
// Segment boundary: `.claude`/`LIFEOS` must NOT be followed by `-` (so
// `.claude-playbooks` and any already-rewritten absolute root never match →
// idempotency), `.` (so a sibling `.claude.json` is left intact), or a word
// char (so `.claudeX` / `LIFEOS_Foo` are left intact). Everything else —
// `/`, quotes, whitespace, backtick, `)`, `*`, `,`, EOL — is a valid end.
const BOUND = "(?![-.\\w])";

interface Rule {
  name: string;
  re: RegExp;
  rep: (m: string, ...g: string[]) => string;
}
const RULES: Rule[] = [
  // R1 — string/shell form, LIFEOS runtime dir → <RT>
  { name: "R1", re: new RegExp(STRHOME + "/\\.claude/LIFEOS" + BOUND, "g"), rep: () => RT },
  // R2 — JS constructor, same-arg string ".claude/LIFEOS..." → "<RT>..."
  { name: "R2", re: new RegExp(HOMETOK + "\\s*,\\s*(['\"])\\.claude/LIFEOS" + BOUND, "g"), rep: (_m, q) => q + RT },
  // R2c — JS string-concat, home + "/.claude/LIFEOS..." → "<RT>..."
  { name: "R2c", re: new RegExp(HOMETOK + "\\s*\\+\\s*(['\"])/\\.claude/LIFEOS" + BOUND, "g"), rep: (_m, q) => q + RT },
  // R3 — JS constructor, separate args ".claude","LIFEOS" → "<RT>"
  { name: "R3", re: new RegExp(HOMETOK + "\\s*,\\s*['\"]\\.claude['\"]\\s*,\\s*['\"]LIFEOS['\"]", "g"), rep: () => '"' + RT + '"' },
  // R2b — JS constructor, non-LIFEOS ".claude" → "<CR>" (also collapses the
  //       first arg of ".claude","sub",... forms; runs AFTER R2/R2c/R3 so
  //       LIFEOS cases are already consumed)
  { name: "R2b", re: new RegExp(HOMETOK + "\\s*,\\s*(['\"])\\.claude" + BOUND, "g"), rep: (_m, q) => q + CR },
  // R2d — JS string-concat, home + "/.claude..." (non-LIFEOS) → "<CR>..."
  { name: "R2d", re: new RegExp(HOMETOK + "\\s*\\+\\s*(['\"])/\\.claude" + BOUND, "g"), rep: (_m, q) => q + CR },
  // R4 — string/shell form, non-LIFEOS .claude → <CR>
  { name: "R4", re: new RegExp(STRHOME + "/\\.claude" + BOUND, "g"), rep: () => CR },
  // Rrel — relative-import fixup. Upstream ships `../../../.claude/hooks/...`
  //        assuming the runtime sits directly under the config root (~/.claude/
  //        LIFEOS/...). In this layout the runtime is one level deeper
  //        (<CR>/runtime/LIFEOS/...), so the same `../` chain already lands on
  //        <CR>; dropping the `.claude/` segment retargets the config-root
  //        subdir (hooks/skills/agents/commands). Not a home-token form — a
  //        structural fixup for the runtime/ wrapper.
  { name: "Rrel", re: /((?:\.\.\/){2,})\.claude\/((?:hooks|skills|agents|commands)\/)/g, rep: (_m, up, sub) => up + sub },
  // RrelL — relative-import fixup for the LIFEOS runtime. Upstream ships bare
  //        `../LIFEOS/...` / `../../LIFEOS/...` from hooks (and `${import.meta.dir}
  //        /../LIFEOS/...`), assuming the runtime sits directly under the config
  //        root (~/.claude/LIFEOS/...). Those `../` chains are calibrated to land
  //        on the config root, so in this layout — where the runtime is one level
  //        deeper at <CR>/runtime/LIFEOS/ — a `LIFEOS/` segment that terminates a
  //        `../` chain must gain a `runtime/` segment. Unlike Rrel these carry no
  //        `.claude/` segment, so Rrel never matched them. Idempotent: once
  //        rewritten to `../runtime/LIFEOS/`, the `../` chain is followed by
  //        `runtime/` (not `LIFEOS/`), so it can never re-match. Bounded on
  //        `LIFEOS/` (trailing slash) so `LIFEOS_SYSTEM_PROMPT.md` etc. are safe.
  { name: "RrelL", re: /((?:\.\.\/)+)LIFEOS\//g, rep: (_m, up) => up + "runtime/LIFEOS/" },
  // RrelH — the mirror of Rrel/RrelL: bare relative imports FROM the runtime
  //        tree back INTO a config-root subdir (hooks|skills|agents|commands).
  //        Upstream ships two shapes of runtime→hooks import: a `.claude/`-
  //        qualified one (`../../../.claude/hooks/...`, which Rrel retargets) and
  //        a BARE one (`../../hooks/...`) that Rrel never matched. Because the
  //        runtime lives one level deeper here (<CR>/runtime/LIFEOS/... vs
  //        upstream ~/.claude/LIFEOS/...), the bare `../` chain lands inside
  //        <CR>/runtime/ instead of <CR>, so it no longer reaches the subdir
  //        (module-resolution error at hook/tool runtime). The correct `../`
  //        count is file-depth-dependent, so instead of guessing it we retarget
  //        to the ABSOLUTE deployed location — the same absolute-baking idiom the
  //        R1–R4 rules already use. Idempotent (no `../` remains, so it can never
  //        re-match) and depth-independent. The deployed hooks/ tree has zero
  //        matches for this pattern, so only runtime files are affected; it runs
  //        after Rrel so a `.claude/`-qualified form is absolutized too (same
  //        target). BOUND-free on the subdir because a trailing `/` already
  //        anchors it to a real path segment.
  { name: "RrelH", re: /(?:\.\.\/)+(hooks|skills|agents|commands)\//g, rep: (_m, sub) => CR + "/" + sub + "/" },
  // R6a — config-root-relative "LIFEOS/..." path strings. Upstream's two-step
  //        idiom (`const CLAUDE = join(HOME, ".claude"); join(CLAUDE,
  //        "LIFEOS/TOOLS")`) defeats R1–R4: the first statement rewrites to the
  //        absolute <CR>, but the second join carries no `.claude` literal, so
  //        the "LIFEOS/..." segment survives and resolves to <CR>/LIFEOS —
  //        which on a case-insensitive FS IS the tracked LifeOS/ payload dir
  //        (MemoryHealthCheck then reports its required tools "missing" and
  //        writes its health log INTO the payload tree). Any quoted path
  //        starting with `LIFEOS/` in deployed code/prose means the runtime
  //        tree, which lives at runtime/LIFEOS here. Idempotent: rewritten
  //        strings start `runtime/`, so the quote is no longer followed by
  //        `LIFEOS/`. `@LIFEOS/...` imports (`@` between quote and LIFEOS) and
  //        `LIFEOS_*` identifiers (no `/`) never match.
  { name: "R6a", re: /(['"`])LIFEOS\//g, rep: (_m, q) => q + "runtime/LIFEOS/" },
  // R6b — the separate-arg spelling of R6a: `join(PAI, 'LIFEOS', 'MEMORY',
  //        ...)`. Anchored to a join/resolve/pathResolve call earlier on the
  //        same line (variable-length lookbehind, supported by Bun's V8) so a
  //        display-string "LIFEOS" outside a path expression can't match; the
  //        quoted arg must be followed by `,` or `)`. Idempotent: the rewritten
  //        arg is 'runtime/LIFEOS', which no longer matches quote-LIFEOS-quote.
  { name: "R6b", re: /(?<=\b(?:join|resolve|pathResolve)\([^\n]*)(['"])LIFEOS\1(?=\s*[,)])/g, rep: (_m, q) => q + "runtime/LIFEOS" + q },
];

/** Apply all rewrite rules to a string; return the new text + replacement count. */
function rewriteText(content: string): { text: string; count: number } {
  let count = 0;
  let text = content;
  for (const { re, rep } of RULES) {
    text = text.replace(re, (...args: any[]) => {
      count++;
      // args = [match, g1?, ..., offset, whole]; strip trailing offset+string
      const groups = args.slice(0, -2) as [string, ...string[]];
      return rep(...groups);
    });
  }
  return { text, count };
}

// ── generic fs helpers ────────────────────────────────────────────────
const TEXT_EXT = new Set([".ts", ".js", ".sh", ".json", ".md", ".yaml", ".yml", ".toml", ".txt"]);
const WALK_SKIP = new Set(["node_modules", ".git", ".DS_Store"]);

function* walkFiles(dir: string, skip: Set<string> = WALK_SKIP): Generator<string> {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) continue; // never follow symlinks (e.g. runtime/LIFEOS/USER)
    if (e.isDirectory()) yield* walkFiles(p, skip);
    else if (e.isFile()) yield p;
  }
}

/** copyMissing is destructive; this mirrors its count for dry-run planning. */
function countMissing(src: string, dst: string): number {
  const engineSkip = new Set(["node_modules", ".git", "MEMORY"]);
  let n = 0;
  const walk = (s: string, d: string): void => {
    if (!existsSync(s)) return;
    if (lstatSync(s).isFile()) {
      if (!existsSync(d)) n++;
      return;
    }
    for (const e of readdirSync(s, { withFileTypes: true })) {
      if (engineSkip.has(e.name)) continue;
      const sp = join(s, e.name);
      const dp = join(d, e.name);
      if (e.isDirectory()) walk(sp, dp);
      else if (e.isFile() && !existsSync(dp)) n++;
    }
  };
  walk(src, dst);
  return n;
}

// ── summary bookkeeping ───────────────────────────────────────────────
interface StepRow {
  step: string;
  copied: number | string;
  skipped: number | string;
  rewritten: number | string;
  note?: string;
}
const summary: StepRow[] = [];
function row(step: string, copied: number | string, skipped: number | string = "", rewritten: number | string = "", note = ""): void {
  summary.push({ step, copied, skipped, rewritten, note });
}

// ── payload preflight (loud on any missing required source) ───────────
function requireDir(p: string, label: string): void {
  if (!existsSync(p) || !statSync(p).isDirectory()) die(`required payload directory missing: ${label} (${p}). The LifeOS/install payload is incomplete — nothing was deployed.`);
}
function requireFile(p: string, label: string): void {
  if (!existsSync(p) || !statSync(p).isFile()) die(`required payload file missing: ${label} (${p}). The LifeOS/install payload is incomplete — nothing was deployed.`);
}

function preflight(): void {
  requireDir(PAYLOAD, "LifeOS/install");
  requireDir(join(PAYLOAD, "skills"), "install/skills");
  requireDir(join(PAYLOAD, "LIFEOS"), "install/LIFEOS");
  requireDir(join(PAYLOAD, "hooks"), "install/hooks");
  requireDir(join(PAYLOAD, "agents"), "install/agents");
  requireDir(join(PAYLOAD, "commands"), "install/commands");
  requireDir(join(PAYLOAD, "USER"), "install/USER");
  requireFile(join(PAYLOAD, "settings.system.json"), "install/settings.system.json");
  requireFile(join(PAYLOAD, "hooks", "hooks.json"), "install/hooks/hooks.json");
  requireFile(join(PAYLOAD, "package.json"), "install/package.json");
  requireFile(join(PAYLOAD, "LIFEOS", "VERSION"), "install/LIFEOS/VERSION");
  if (FULL) requireFile(join(PAYLOAD, "settings.enhancements.json"), "install/settings.enhancements.json");
  if (existsSync(join(CR, "LifeOS", "SKILL.md")) === false) die(`missing LifeOS/SKILL.md — cannot create the skills/LifeOS loader symlink.`);
}

// ── settings.json build (create-only) ─────────────────────────────────
const STRIP_SESSIONSTART = /SettingsBackport|MergeSettings/;

function buildSettings(): { json: string; rewrites: number; strippedHooks: number } {
  const system = JSON.parse(readFileSync(join(PAYLOAD, "settings.system.json"), "utf8")) as Record<string, any>;
  const hooksJson = JSON.parse(readFileSync(join(PAYLOAD, "hooks", "hooks.json"), "utf8")) as { hooks: Record<string, any> };

  // Merge shipped hooks into the (empty) system hooks.
  const merged = mergeHooks((system.hooks ?? {}) as any, hooksJson.hooks as any).merged as Record<string, any[]>;

  // Strip the SessionStart entry that regenerates settings.json at runtime via
  // SettingsBackport/MergeSettings (hard-codes ~/.claude + reads files this
  // layout doesn't have). Keep FreshnessCache + the http :31337 guards.
  let strippedHooks = 0;
  for (const grp of merged.SessionStart ?? []) {
    if (Array.isArray(grp.hooks)) {
      const before = grp.hooks.length;
      grp.hooks = grp.hooks.filter((h: any) => !(typeof h.command === "string" && STRIP_SESSIONSTART.test(h.command)));
      strippedHooks += before - grp.hooks.length;
    }
  }
  system.hooks = merged;

  // Claude Code ≥2.1.x no longer matches Write(path) permission rules — file
  // editing is covered by Edit(path) rules only, and each shipped Write(X)
  // has an Edit(X) twin. Drop the Write rules (kept, they print a startup
  // warning per rule); convert any twinless stragglers to Edit.
  if (system.permissions && typeof system.permissions === "object") {
    for (const bucket of ["allow", "deny", "ask"]) {
      const rules = (system.permissions as Record<string, unknown>)[bucket];
      if (!Array.isArray(rules)) continue;
      const out: string[] = [];
      for (const r of rules as string[]) {
        if (typeof r === "string" && r.startsWith("Write(")) {
          const twin = "Edit(" + r.slice("Write(".length);
          if (!rules.includes(twin) && !out.includes(twin)) out.push(twin);
          continue;
        }
        out.push(r);
      }
      (system.permissions as Record<string, unknown>)[bucket] = out;
    }
  }

  if (FULL) {
    // Match upstream DeployComponents.ts statusLine shape: {type,command,refreshInterval}.
    system.statusLine = { type: "command", command: join(RT, "LIFEOS_StatusLine.sh"), refreshInterval: 1 };
    const enh = JSON.parse(readFileSync(join(PAYLOAD, "settings.enhancements.json"), "utf8")) as Record<string, any>;
    if (enh.spinnerVerbs !== undefined) system.spinnerVerbs = enh.spinnerVerbs;
    if (enh.spinnerTipsOverride !== undefined) system.spinnerTipsOverride = enh.spinnerTipsOverride;
  }

  // Serialize → path-rewrite the whole document → parse back → expand any
  // remaining leading $HOME/~ in env values (harness injects env verbatim, so
  // they MUST be absolute) → reserialize.
  const serialized = JSON.stringify(system, null, 2);
  const { text: rewritten, count } = rewriteText(serialized);
  const obj = JSON.parse(rewritten) as Record<string, any>;
  if (obj.env && typeof obj.env === "object") {
    for (const [k, v] of Object.entries(obj.env)) {
      if (typeof v === "string") obj.env[k] = expandLeadingHome(v, REAL_HOME);
    }
  }
  return { json: JSON.stringify(obj, null, 2) + "\n", rewrites: count, strippedHooks };
}

// ── main ──────────────────────────────────────────────────────────────
function main(): void {
  const version = readFileSync(join(PAYLOAD, "LIFEOS", "VERSION"), "utf8").trim();
  const bunBin = process.execPath; // this script runs under bun
  const bunDir = dirname(bunBin);

  log("LifeOS playbook deploy");
  log("======================");
  log(`mode           : ${APPLY ? (FULL ? "APPLY --full" : "APPLY") : "DRY-RUN (no writes)"}`);
  log(`checkout root  : ${CR}`);
  log(`runtime (<RT>) : ${RT}`);
  log(`payload        : ${PAYLOAD}`);
  log(`version        : ${version}`);
  log(`real home      : ${REAL_HOME}`);
  log(`bun            : ${bunBin}`);

  // CLAUDE_CONFIG_DIR sanity: warn (don't fail) if it points elsewhere.
  const ccd = process.env.CLAUDE_CONFIG_DIR;
  if (ccd) {
    let differs = true;
    try {
      differs = realpathSync(ccd) !== realpathSync(CR);
    } catch {
      differs = ccd !== CR;
    }
    if (differs) log(`WARNING        : CLAUDE_CONFIG_DIR=${ccd} != checkout root ${CR} — deploying to the checkout root regardless.`);
  }
  log("");

  preflight();

  if (!APPLY) {
    planDryRun(version);
    return;
  }
  applyDeploy(version, bunBin, bunDir);
}

// ── dry-run planning ──────────────────────────────────────────────────
function planDryRun(version: string): void {
  log("PLAN (dry-run — nothing is written):");
  log("");

  // 1 skills + LifeOS symlink
  const nSkills = countMissing(join(PAYLOAD, "skills"), join(CR, "skills"));
  log(`  1. skills         copyMissing install/skills → skills/            (would copy ${nSkills} file(s))`);
  const skillLink = join(CR, "skills", "LifeOS");
  log(`     skills/LifeOS  symlink → ../LifeOS                             (${existsSync(skillLink) ? "exists — skip" : "would create"})`);
  row("1 skills", nSkills, "", "", "loader symlink skills/LifeOS");

  // 2 runtime
  let nRuntime = 0;
  const runtimeSkip = new Set(["USER", "MEMORY", "node_modules", ".git"]);
  for (const e of readdirSync(join(PAYLOAD, "LIFEOS"), { withFileTypes: true })) {
    if (runtimeSkip.has(e.name)) continue;
    nRuntime += countMissing(join(PAYLOAD, "LIFEOS", e.name), join(RT, e.name));
  }
  log(`  2. runtime        copyMissing install/LIFEOS/* (−USER,MEMORY) → runtime/LIFEOS/   (would copy ${nRuntime} file(s))`);
  row("2 runtime", nRuntime);

  // 3 MEMORY scaffold
  const memSubs = ["WORK", "KNOWLEDGE", "LEARNING", "STATE", "OBSERVABILITY", "SKILLS"];
  const memMissing = memSubs.filter((s) => !existsSync(join(RT, "MEMORY", s))).length;
  log(`  3. MEMORY         mkdir -p runtime/LIFEOS/MEMORY/{${memSubs.join(",")}}   (${memMissing} dir(s) to create)`);
  row("3 MEMORY", memMissing);

  // 4 hooks
  const nHooks = countMissing(join(PAYLOAD, "hooks"), join(CR, "hooks"));
  log(`  4. hooks          copyMissing install/hooks → hooks/              (would copy ${nHooks} file(s))`);
  row("4 hooks", nHooks);

  // 5 agents + commands
  const nAgents = countMissing(join(PAYLOAD, "agents"), join(CR, "agents"));
  const nCommands = countMissing(join(PAYLOAD, "commands"), join(CR, "commands"));
  log(`  5. agents         copyMissing install/agents → agents/            (would copy ${nAgents} file(s))`);
  log(`     commands       copyMissing install/commands → commands/        (would copy ${nCommands} file(s))`);
  row("5 agents", nAgents);
  row("5 commands", nCommands);

  // 6 settings.json
  const settingsPath = join(CR, "settings.json");
  if (existsSync(settingsPath)) {
    log(`  6. settings.json  EXISTS → left untouched`);
    row("6 settings.json", "-", "left untouched");
  } else {
    const { rewrites, strippedHooks } = buildSettings();
    log(`  6. settings.json  would CREATE (system + merged hooks; ${strippedHooks} SessionStart backport hook(s) stripped; ${rewrites} path rewrite(s); env values expanded)${FULL ? "; +statusLine +spinnerVerbs +spinnerTipsOverride" : ""}`);
    row("6 settings.json", "create", "", rewrites, FULL ? "full: statusLine+spinner" : "");
  }

  // 7 CLAUDE.md — untouched
  log(`  7. CLAUDE.md      NOT modified (tracked, static, already playbook-adapted)`);

  // 8 path-rewrite + paths.ts patch + chmod
  log(`  8. path-rewrite   over deployed hooks/** and runtime/LIFEOS/** text files (runs during --apply)`);
  log(`     paths.ts       patch getClaudeDir() to honor CLAUDE_CONFIG_DIR first`);
  log(`     chmod +x       LIFEOS_StatusLine.sh + hooks/*.hook.{ts,sh}`);

  // 9 token substitution
  log(`  9. tokens         substitute {{HOME}} {{BUN}} {{BUN_DIR}} {{USER_DIR}} {{MEMORY_DIR}} {{VERSION}} {{LIFEOS_VERSION}} {{CLI_NAME}} over hooks/, runtime/LIFEOS/, agents/, commands/`);

  // 10 USER scaffold
  const nUser = countMissing(join(PAYLOAD, "USER"), join(CR, "USER"));
  log(` 10. USER           copyMissing install/USER → USER/                (would copy ${nUser} file(s))`);
  log(`                    then substitute {{USER_DIR}} {{MEMORY_DIR}} over USER/CONFIG/ (no-op if already populated)`);
  row("10 USER", nUser);

  // 11 USER symlink
  log(` 11. USER symlink    setupUserSeparation → runtime/LIFEOS/USER → USER/ ; checkSymlinkContract`);

  // 12 deps
  const pkgExists = existsSync(join(CR, "package.json"));
  log(` 12. deps           copy install/package.json → package.json (${pkgExists ? "exists — skip" : "would copy"}) ; bun install (skipped in dry-run)`);
  row("12 deps", pkgExists ? "skip" : "copy");

  log("");
  printSummary();
  log("\nDry-run complete. Re-run with --apply to deploy.");
}

// ── apply ─────────────────────────────────────────────────────────────
function applyDeploy(version: string, bunBin: string, bunDir: string): void {
  log("APPLYING:");
  log("");

  // 1. skills + loader symlink
  {
    const { copied, failures } = copyMissing(join(PAYLOAD, "skills"), join(CR, "skills"));
    if (failures.length) log(`  ! skills copy failures: ${failures.length}`);
    let linkNote = "";
    const link = join(CR, "skills", "LifeOS");
    if (!existsSync(link)) {
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync("../LifeOS", link); // relative → <CR>/LifeOS
      linkNote = "skills/LifeOS → ../LifeOS created";
    } else {
      linkNote = "skills/LifeOS exists";
    }
    log(`  1. skills         copied ${copied} file(s); ${linkNote}`);
    row("1 skills", copied, "", "", linkNote);
  }

  // 2. runtime (per top-level entry, minus USER/MEMORY/node_modules/.git)
  {
    const runtimeSkip = new Set(["USER", "MEMORY", "node_modules", ".git"]);
    let copied = 0;
    const fails: string[] = [];
    for (const e of readdirSync(join(PAYLOAD, "LIFEOS"), { withFileTypes: true })) {
      if (runtimeSkip.has(e.name)) continue;
      const r = copyMissing(join(PAYLOAD, "LIFEOS", e.name), join(RT, e.name));
      copied += r.copied;
      fails.push(...r.failures);
    }
    if (fails.length) log(`  ! runtime copy failures: ${fails.length}`);
    log(`  2. runtime        copied ${copied} file(s) → ${RT}`);
    row("2 runtime", copied);
  }

  // 3. MEMORY scaffold
  {
    const subs = ["WORK", "KNOWLEDGE", "LEARNING", "STATE", "OBSERVABILITY", "SKILLS"];
    let made = 0;
    for (const s of subs) {
      const d = join(RT, "MEMORY", s);
      if (!existsSync(d)) {
        mkdirSync(d, { recursive: true });
        made++;
      }
    }
    log(`  3. MEMORY         created ${made} dir(s)`);
    row("3 MEMORY", made);
  }

  // 4. hooks
  {
    const { copied, failures } = copyMissing(join(PAYLOAD, "hooks"), join(CR, "hooks"));
    if (failures.length) log(`  ! hooks copy failures: ${failures.length}`);
    log(`  4. hooks          copied ${copied} file(s)`);
    row("4 hooks", copied);
  }

  // 5. agents + commands
  {
    const a = copyMissing(join(PAYLOAD, "agents"), join(CR, "agents"));
    const c = copyMissing(join(PAYLOAD, "commands"), join(CR, "commands"));
    log(`  5. agents         copied ${a.copied} file(s); commands copied ${c.copied} file(s)`);
    row("5 agents", a.copied);
    row("5 commands", c.copied);
  }

  // 6. settings.json (create-only)
  {
    const settingsPath = join(CR, "settings.json");
    if (existsSync(settingsPath)) {
      log(`  6. settings.json  EXISTS → left untouched`);
      row("6 settings.json", "-", "left untouched");
    } else {
      const { json, rewrites, strippedHooks } = buildSettings();
      writeFileSync(settingsPath, json);
      log(`  6. settings.json  CREATED (${strippedHooks} SessionStart backport hook(s) stripped; ${rewrites} path rewrite(s); env expanded)${FULL ? "; +statusLine +spinner" : ""}`);
      row("6 settings.json", "created", "", rewrites, FULL ? "full: statusLine+spinner" : "");
    }
  }

  // 7. CLAUDE.md — intentionally NOT modified.
  log(`  7. CLAUDE.md      not modified (static, tracked)`);

  // 8. path-rewrite pass over deployed copies + paths.ts patch + chmod
  {
    let files = 0;
    let rewrites = 0;
    let changed = 0;
    for (const dir of [join(CR, "hooks"), RT]) {
      for (const f of walkFiles(dir)) {
        const ext = f.slice(f.lastIndexOf("."));
        if (!TEXT_EXT.has(ext)) continue;
        files++;
        const before = readFileSync(f, "utf8");
        const { text, count } = rewriteText(before);
        if (count > 0 && text !== before) {
          writeFileSync(f, text);
          rewrites += count;
          changed++;
        }
      }
    }
    // paths.ts patch: getClaudeDir() must honor CLAUDE_CONFIG_DIR first.
    const patched = patchPathsTs();
    // chmod +x on the statusline + hook scripts.
    const chmodCount = chmodExecutables();
    log(`  8. path-rewrite   ${rewrites} rewrite(s) across ${changed} file(s) (scanned ${files}); paths.ts patch: ${patched}; chmod +x on ${chmodCount} script(s)`);
    row("8 path-rewrite", "", "", rewrites, `${changed} files; paths.ts ${patched}`);
  }

  // Token map — shared by step 9 (system trees) and step 10 (USER/CONFIG).
  const tokenVars: Record<string, string> = {
    "{{LIFEOS_VERSION}}": version,
    "{{VERSION}}": version,
    "{{HOME}}": REAL_HOME,
    "{{BUN}}": bunBin,
    "{{BUN_DIR}}": bunDir,
    "{{USER_DIR}}": join(CR, "USER"),
    "{{MEMORY_DIR}}": join(RT, "MEMORY"),
    "{{CLI_NAME}}": "lifeos",
  };

  // 9. token substitution
  {
    let applied = 0;
    for (const dir of [join(CR, "hooks"), RT, join(CR, "agents"), join(CR, "commands")]) {
      const r = substituteTree(dir, tokenVars);
      applied += r.applied;
    }
    log(`  9. tokens         ${applied} substitution(s) applied`);
    row("9 tokens", "", "", applied);
  }

  // 10. USER scaffold
  {
    const { copied, failures } = copyMissing(join(PAYLOAD, "USER"), join(CR, "USER"));
    if (failures.length) log(`  ! USER copy failures: ${failures.length}`);

    // LIFEOS_CONFIG.toml ships {{USER_DIR}}/{{MEMORY_DIR}} so a playbook install
    // resolves to THIS config root rather than the upstream ~/.claude default.
    // Scoped to USER/CONFIG/ so principal-authored content is never rewritten,
    // and it runs after the copy because copyMissing is the thing that lands the
    // tokenized scaffold. On an existing install this is a no-op: the file is
    // already populated (copyMissing never overwrites) and holds no tokens.
    const sub = substituteTree(join(CR, "USER", "CONFIG"), tokenVars);

    log(` 10. USER           copied ${copied} file(s); ${sub.applied} token(s) in USER/CONFIG`);
    row("10 USER", copied, "", sub.applied);
  }

  // 11. USER symlink + contract check
  {
    const res = setupUserSeparation(join(CR, "runtime"), CR);
    const check = checkSymlinkContract(join(CR, "runtime"), CR);
    if (!check.passed) die(`USER symlink contract FAILED: ${check.detail} (setup action: ${res.action}${res.error ? `, error: ${res.error}` : ""})`);
    log(` 11. USER symlink   ${res.action}; contract OK (${check.detail})`);
    row("11 USER symlink", res.action, "", "", "contract OK");
  }

  // 12. deps
  {
    const pkgSrc = join(PAYLOAD, "package.json");
    const pkgDst = join(CR, "package.json");
    let copied = 0;
    if (!existsSync(pkgDst)) {
      const r = copyMissing(pkgSrc, pkgDst);
      copied = r.copied;
    }
    log(` 12. deps           package.json ${copied ? "copied" : "present"}; running bun install...`);
    const proc = Bun.spawnSync(["bun", "install"], { cwd: CR, stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) {
      log(`  ! bun install exited ${proc.exitCode}: ${proc.stderr.toString().trim().split("\n").slice(-3).join(" | ")}`);
      row("12 deps", copied ? "copied" : "present", "", "", `bun install FAILED (${proc.exitCode})`);
    } else {
      const hasYaml = existsSync(join(CR, "node_modules", "yaml"));
      log(`     bun install    ok (node_modules/yaml ${hasYaml ? "present" : "MISSING"})`);
      row("12 deps", copied ? "copied" : "present", "", "", `bun install ok`);
    }
  }

  log("");
  printSummary();
  log("\nDeploy complete.");
}

/** Insert a CLAUDE_CONFIG_DIR-first branch at the top of getClaudeDir(). */
function patchPathsTs(): string {
  const p = join(CR, "hooks", "lib", "paths.ts");
  if (!existsSync(p)) return "paths.ts not found (skipped)";
  let src = readFileSync(p, "utf8");
  if (src.includes("process.env.CLAUDE_CONFIG_DIR")) return "already patched";
  const anchor = "export function getClaudeDir(): string {";
  const idx = src.indexOf(anchor);
  if (idx < 0) return "getClaudeDir not found (skipped)";
  const insert =
    anchor +
    "\n  // Playbook layout: the config root is CLAUDE_CONFIG_DIR (the checkout root).\n" +
    "  if (process.env.CLAUDE_CONFIG_DIR) {\n" +
    "    return expandPath(process.env.CLAUDE_CONFIG_DIR);\n" +
    "  }\n";
  src = src.slice(0, idx) + insert + src.slice(idx + anchor.length);
  writeFileSync(p, src);
  return "patched";
}

/** chmod +x the statusline script and every *.hook.ts / *.hook.sh under hooks/. */
function chmodExecutables(): number {
  let n = 0;
  const status = join(RT, "LIFEOS_StatusLine.sh");
  if (existsSync(status)) {
    chmodSync(status, 0o755);
    n++;
  }
  for (const f of walkFiles(join(CR, "hooks"))) {
    if (f.endsWith(".hook.ts") || f.endsWith(".hook.sh")) {
      chmodSync(f, 0o755);
      n++;
    }
  }
  return n;
}

// ── summary table ─────────────────────────────────────────────────────
function printSummary(): void {
  const cols = ["step", "copied", "skipped", "rewritten", "note"];
  const rows = summary.map((r) => [String(r.step), String(r.copied), String(r.skipped), String(r.rewritten), r.note ?? ""]);
  const widths = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i].length)));
  const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  log("SUMMARY");
  log(fmt(cols));
  log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) log(fmt(r));
}

main();
