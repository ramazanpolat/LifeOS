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
 * Idempotent and update-safe: system-managed files are hash-tracked. Files that
 * still match the last deployed version are refreshed; locally modified or
 * pre-existing files are preserved. USER content remains create-only.
 *
 * Reuses the upstream engine (InstallEngine.ts) for USER copyMissing,
 * mergeHooks, setupUserSeparation, and checkSymlinkContract. It does NOT shell
 * out to DeployCore / InstallSettings / InstallHooks — their targets hard-code
 * <configRoot>/LIFEOS and ~/.claude, both wrong for this layout.
 */

import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  checkSymlinkContract,
  copyMissing,
  mergeHooks,
  setupUserSeparation,
} from "../LifeOS/Tools/InstallEngine";

// ── paths ─────────────────────────────────────────────────────────────
const CR = dirname(import.meta.dir); // checkout root = parent of bin/
const RT = join(CR, "runtime", "LIFEOS");
const PAYLOAD = join(CR, "LifeOS", "install");
const REAL_HOME = homedir();
const STATE_PATH = join(CR, ".lifeos-deploy-state.json");
// Crash-recovery breadcrumb: written at the start of an --apply and removed only
// after saveDeployState succeeds (together with the journal). Its presence at the
// start of a later --apply means a previous run died mid-deploy (e.g. `bun
// install` failed) before its state was persisted, so managed destinations may be
// sitting on disk raw (pre-path-rewrite) or half-updated, with the recorded state
// hash stale or absent. On such a resume the WRITE-AHEAD JOURNAL (below) — not the
// state hash — decides which managed files this deployer owns and may re-process.
const INPROGRESS_PATH = join(CR, ".lifeos-deploy-inprogress");
// Write-ahead journal: the set of managed keys the CURRENT --apply has actually
// written, persisted after each file-writing step (steps 1,2,4,5 sync; step 8
// rewrite; step 9 tokens) so an interruption at any step boundary leaves an
// accurate record. It is the crash-recovery authority: on a resume (marker
// present at startup) the PRIOR run's journal is loaded, and a managed
// destination is re-processed — overwritten from source, re-enrolled, and
// re-queued for the step-8 rewrite — IFF its key is in that journal, regardless
// of whether the state hash exists or matches. This (a) re-enrolls a file the
// crash left with new transformed bytes but a stale state hash (which plain
// preserve semantics would strand from all future upstream updates), and (b)
// never clobbers a genuine user file that merely collided with a managed path
// (absent from the journal → preserved). Removed with the marker after
// saveDeployState succeeds; a resume with no journal (or an unreadable one)
// re-processes nothing, which is the safe default. Per-install state, gitignored.
const JOURNAL_PATH = join(CR, ".lifeos-deploy-journal.json");

// ── args ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
let FULL = argv.includes("--full");

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
  //
  //        SEMANTIC-COMPARISON EXEMPTION (leading negative lookbehind): a
  //        `"LIFEOS/..."` literal that is the ARGUMENT of a string-matching
  //        method is NOT a path to localize — it is a value compared against
  //        some OTHER string, and rewriting it silently changes the comparison.
  //        The motivating case is PULSE/Tools/ReleaseAudit.ts, whose
  //        `rel.startsWith("LIFEOS/MEMORY/PULSE_DATA/")` / `startsWith(
  //        "LIFEOS/USER/")` test an EXTERNAL staged release (rel = relative(
  //        STAGING, file), genuinely rooted at `LIFEOS/`); rewriting them to
  //        `runtime/LIFEOS/...` breaks the release privacy audit. Same for
  //        ContextAudit's `value.startsWith("LIFEOS/")` (value carries the
  //        original ref form; CLAUDE_DIR is import.meta-relative to <CR>/runtime)
  //        and the `.includes('LIFEOS/USER/')` privacy substrings in
  //        change-detection / IntegrityMaintenance (a substring of
  //        `runtime/LIFEOS/USER/` too, so exempting only widens the match). The
  //        lookbehind exempts a leading `.<method>(` (optional whitespace after
  //        the paren): startsWith/endsWith/includes/indexOf/lastIndexOf/match/
  //        search/split/replace/replaceAll. Variable-length lookbehind is
  //        supported by Bun (JavaScriptCore), as R6b's lookbehind already relies
  //        on.
  //        NOTE — comparison operators (=== !== == !=) are deliberately NOT
  //        exempted: the payload's only such site, ReferenceCheck.ts:130
  //        `relPath === 'LIFEOS/ALGORITHM/changelog.md'`, compares against
  //        rel = relative(CLAUDE_DIR=<CR>, file), which in this layout is
  //        `runtime/LIFEOS/...`; that literal MUST be rewritten to keep matching
  //        (exempting it would strand the changelog exclusion). Path-construction
  //        sites — `join(CLAUDE, "LIFEOS/TOOLS")` etc. — are preceded by `, `/
  //        `(`, never a string-method call, so they still localize.
  { name: "R6a", re: /(?<!\.(?:startsWith|endsWith|includes|indexOf|lastIndexOf|match|search|split|replace|replaceAll)\(\s*)(['"`])LIFEOS\//g, rep: (_m, q) => q + "runtime/LIFEOS/" },
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
// `.hbs` is included so Handlebars templates (skills/Prompting/Templates/**) get
// the step-8 path-rewrite: their rendered `bun run ~/.claude/Skills/...` commands
// would otherwise hit the real ~/.claude. The rewrite rules only match path
// tokens (~/.claude, $HOME/.claude, LIFEOS/, ../ import chains) and never `{{…}}`,
// so Handlebars syntax is left intact. (Skills carry no deploy-time tokens, so
// .hbs are added to pathRewriteFiles only, never tokenFiles — step 9 skips them.)
const TEXT_EXT = new Set([".ts", ".js", ".sh", ".json", ".md", ".yaml", ".yml", ".toml", ".txt", ".hbs"]);
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

interface DeployState {
  version: 1;
  full: boolean;
  files: Record<string, string>;
}

interface SyncResult {
  copied: number;
  updated: number;
  preserved: number;
  failures: string[];
  written: string[];
}

function relativeKey(path: string): string {
  return relative(CR, path).split("\\").join("/");
}

function isManagedKey(key: string): boolean {
  return key === "settings.json" || key === "package.json" ||
    ["skills/", "runtime/LIFEOS/", "hooks/", "agents/", "commands/"].some((prefix) => key.startsWith(prefix));
}

function assertSafeDestination(path: string): void {
  const key = relativeKey(path);
  if (key === ".." || key.startsWith("../") || key.startsWith("/")) {
    die(`refusing destination outside the checkout root: ${path}`);
  }
  const parts = key.split("/").filter(Boolean);
  let cursor = CR;
  for (const part of parts) {
    cursor = join(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink()) {
        die(`refusing to write through symlink: ${relativeKey(cursor)}`);
      }
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") return;
      throw err;
    }
  }
}

function assertNoSymlinksInTree(root: string): void {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) die(`refusing to scaffold through symlink: ${relativeKey(path)}`);
    if (entry.isDirectory()) assertNoSymlinksInTree(path);
  }
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function loadDeployState(): DeployState {
  if (!existsSync(STATE_PATH)) return { version: 1, full: false, files: {} };
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<DeployState>;
    if (parsed.version !== 1 || typeof parsed.files !== "object" || parsed.files === null) {
      throw new Error("unsupported state shape");
    }
    for (const [key, value] of Object.entries(parsed.files)) {
      if (!isManagedKey(key) || typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
        throw new Error(`unsafe or invalid managed-file entry: ${key}`);
      }
    }
    return { version: 1, full: parsed.full === true, files: parsed.files };
  } catch (err) {
    die(`cannot read ${relativeKey(STATE_PATH)} safely: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Synchronize a system-managed tree. A previously deployed file is refreshed
 * only when its current hash still matches the deploy state; locally edited or
 * pre-existing files are preserved.
 *
 * `journalKeys` (crash recovery ONLY): the managed keys the interrupted prior
 * run recorded in its write-ahead journal (empty on a normal, non-resume run).
 * When a managed destination is NOT eligible for the ordinary refresh (its hash
 * no longer matches the state hash, or no state hash exists), but its key IS in
 * this set, it is OVERWRITTEN from source and enrolled (written) rather than
 * preserved. That covers both crash shapes the state hash alone gets wrong:
 *   - a first-deploy file copied raw before the step-8 rewrite (no state hash),
 *   - an update whose new transformed bytes were written but whose state hash
 *     was never refreshed (hash != priorHash WITH priorHash present) — which
 *     plain preserve semantics would strand from every future upstream update.
 * A managed destination that is NOT in the journal is treated as a genuine
 * user file that collided with a managed path and is preserved untouched. A
 * normal run passes an empty set and behaves byte-identically to before.
 */
function syncManagedTree(
  src: string,
  dst: string,
  previous: DeployState,
  nextFiles: Record<string, string>,
  seen: Set<string>,
  journalKeys: Set<string> = new Set(),
): SyncResult {
  const result: SyncResult = { copied: 0, updated: 0, preserved: 0, failures: [], written: [] };
  const engineSkip = new Set(["node_modules", ".git", "MEMORY"]);

  const walk = (s: string, d: string): void => {
    if (!existsSync(s)) return;
    const sourceStat = lstatSync(s);
    if (sourceStat.isDirectory()) {
      for (const entry of readdirSync(s, { withFileTypes: true })) {
        if (engineSkip.has(entry.name)) continue;
        if (entry.isDirectory() || entry.isFile()) walk(join(s, entry.name), join(d, entry.name));
      }
      return;
    }
    if (!sourceStat.isFile()) return;

    const key = relativeKey(d);
    seen.add(key);
    try {
      assertSafeDestination(d);
      if (!existsSync(d)) {
        mkdirSync(dirname(d), { recursive: true });
        cpSync(s, d);
        result.copied++;
        result.written.push(d);
        return;
      }

      const destinationStat = lstatSync(d);
      const priorHash = previous.files[key];
      if (destinationStat.isFile() && priorHash && hashFile(d) === priorHash) {
        cpSync(s, d);
        result.updated++;
        result.written.push(d);
        return;
      }

      // Crash-recovery: re-process a managed file the interrupted prior run
      // recorded in its journal (see the `journalKeys` note above), regardless of
      // whether the state hash is absent OR present-but-stale. Only regular
      // files; symlinks/dirs are never re-processed this way.
      if (journalKeys.has(key) && destinationStat.isFile()) {
        cpSync(s, d);
        result.copied++;
        result.written.push(d);
        return;
      }

      result.preserved++;
      if (!priorHash) delete nextFiles[key];
    } catch (err) {
      result.failures.push(`${s} → ${d}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  walk(src, dst);
  return result;
}

function removeStaleManagedFiles(previous: DeployState, nextFiles: Record<string, string>, seen: Set<string>): { removed: number; preserved: number } {
  let removed = 0;
  let preserved = 0;
  for (const [key, priorHash] of Object.entries(previous.files)) {
    if (key === "settings.json" || seen.has(key)) continue;
    const path = join(CR, key);
    assertSafeDestination(path);
    if (!existsSync(path)) {
      delete nextFiles[key];
      continue;
    }
    if (lstatSync(path).isFile() && hashFile(path) === priorHash) {
      rmSync(path);
      delete nextFiles[key];
      removed++;
    } else {
      delete nextFiles[key];
      preserved++;
    }
  }
  return { removed, preserved };
}

function saveDeployState(files: Record<string, string>): void {
  const tmp = STATE_PATH + ".tmp";
  const state: DeployState = { version: 1, full: FULL, files };
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, STATE_PATH);
}

interface DeployJournal {
  version: 1;
  keys: string[];
}

/**
 * Load the PRIOR run's write-ahead journal (crash recovery). Returns the set of
 * managed keys that run recorded as written. Any problem — missing file, bad
 * shape, an unsafe/non-managed key — yields an EMPTY set: with no trustworthy
 * evidence of ownership the resume re-processes nothing and preserves everything
 * on disk (never clobbers a user file). Only ever consulted when the in-progress
 * marker is present at startup.
 */
function loadJournal(): Set<string> {
  if (!existsSync(JOURNAL_PATH)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(JOURNAL_PATH, "utf8")) as Partial<DeployJournal>;
    if (parsed.version !== 1 || !Array.isArray(parsed.keys)) return new Set();
    const keys = new Set<string>();
    for (const key of parsed.keys) {
      if (typeof key === "string" && isManagedKey(key)) keys.add(key);
    }
    return keys;
  } catch {
    return new Set();
  }
}

/** Persist THIS run's journal atomically. Called at every file-writing step
 * boundary so a crash leaves an accurate record of what was already written. */
function saveJournal(keys: Set<string>): void {
  const tmp = JOURNAL_PATH + ".tmp";
  const journal: DeployJournal = { version: 1, keys: [...keys].sort() };
  writeFileSync(tmp, JSON.stringify(journal, null, 2) + "\n");
  renameSync(tmp, JOURNAL_PATH);
}

function failOnCopyErrors(label: string, failures: string[]): void {
  if (!failures.length) return;
  die(`${label} failed:\n${failures.map((failure) => `  - ${failure}`).join("\n")}`);
}

function rewriteManagedFiles(files: string[]): { rewrites: number; changed: number } {
  let rewrites = 0;
  let changed = 0;
  for (const file of files) {
    const ext = file.slice(file.lastIndexOf("."));
    if (!TEXT_EXT.has(ext)) continue;
    const before = readFileSync(file, "utf8");
    const result = rewriteText(before);
    if (result.count > 0 && result.text !== before) {
      writeFileSync(file, result.text);
      rewrites += result.count;
      changed++;
    }
  }
  return { rewrites, changed };
}

function substituteManagedFiles(files: string[], vars: Record<string, string>): number {
  let applied = 0;
  for (const file of files) {
    const ext = file.slice(file.lastIndexOf("."));
    if (!TEXT_EXT.has(ext)) continue;
    const before = readFileSync(file, "utf8");
    let after = before;
    for (const [placeholder, value] of Object.entries(vars)) {
      const parts = after.split(placeholder);
      applied += parts.length - 1;
      after = parts.join(value);
    }
    if (after !== before) writeFileSync(file, after);
  }
  return applied;
}

/**
 * The shared payload must retain the normal ~/.claude defaults because the
 * standard LifeOS installer does not know playbook-only tokens. Localize only
 * the two untouched defaults (or tokens left by an older playbook build).
 */
function localizeLifeosConfig(userDir: string, memoryDir: string): number {
  const path = join(CR, "USER", "CONFIG", "LIFEOS_CONFIG.toml");
  if (!existsSync(path)) return 0;
  const before = readFileSync(path, "utf8");
  let after = before;
  let changed = 0;
  const replacements: Array<[RegExp, string]> = [
    [/^user_dir = "(?:~\/\.claude\/LIFEOS\/USER|\{\{USER_DIR\}\})"$/m, `user_dir = ${JSON.stringify(userDir)}`],
    [/^memory_dir = "(?:~\/\.claude\/LIFEOS\/MEMORY|\{\{MEMORY_DIR\}\})"$/m, `memory_dir = ${JSON.stringify(memoryDir)}`],
  ];
  for (const [pattern, replacement] of replacements) {
    if (pattern.test(after)) {
      after = after.replace(pattern, replacement);
      changed++;
    }
  }
  if (after !== before) writeFileSync(path, after);
  return changed;
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

// ── settings.json build ───────────────────────────────────────────────
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
  if (APPLY && loadDeployState().full) FULL = true;
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
  log(`  1. skills         sync managed install/skills → skills/           (would copy ${nSkills} missing file(s))`);
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
  log(`  2. runtime        sync managed install/LIFEOS/* (−USER,MEMORY) → runtime/LIFEOS/   (would copy ${nRuntime} missing file(s))`);
  row("2 runtime", nRuntime);

  // 3 MEMORY scaffold
  const memSubs = ["WORK", "KNOWLEDGE", "LEARNING", "STATE", "OBSERVABILITY", "SKILLS"];
  const memMissing = memSubs.filter((s) => !existsSync(join(RT, "MEMORY", s))).length;
  log(`  3. MEMORY         mkdir -p runtime/LIFEOS/MEMORY/{${memSubs.join(",")}}   (${memMissing} dir(s) to create)`);
  row("3 MEMORY", memMissing);

  // 4 hooks
  const nHooks = countMissing(join(PAYLOAD, "hooks"), join(CR, "hooks"));
  log(`  4. hooks          sync managed install/hooks → hooks/             (would copy ${nHooks} missing file(s))`);
  row("4 hooks", nHooks);

  // 5 agents + commands
  const nAgents = countMissing(join(PAYLOAD, "agents"), join(CR, "agents"));
  const nCommands = countMissing(join(PAYLOAD, "commands"), join(CR, "commands"));
  log(`  5. agents         sync managed install/agents → agents/           (would copy ${nAgents} missing file(s))`);
  log(`     commands       sync managed install/commands → commands/       (would copy ${nCommands} missing file(s))`);
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
  log(`                    then localize untouched ~/.claude USER/MEMORY defaults in USER/CONFIG/`);
  row("10 USER", nUser);

  // 11 USER symlink
  log(` 11. USER symlink    setupUserSeparation → runtime/LIFEOS/USER → USER/ ; checkSymlinkContract`);

  // 12 deps
  const pkgExists = existsSync(join(CR, "package.json"));
  log(` 12. deps           hash-manage install/package.json → package.json (${pkgExists ? "present — refresh if unmodified, else preserve" : "would write"}) ; bun install (skipped in dry-run)`);
  row("12 deps", pkgExists ? "manage" : "write");

  log("");
  printSummary();
  log("\nDry-run complete. Re-run with --apply to deploy.");
}

// ── apply ─────────────────────────────────────────────────────────────
function applyDeploy(version: string, bunBin: string, bunDir: string): void {
  log("APPLYING:");
  log("");
  const previous = loadDeployState();
  // A marker already on disk means a prior --apply died before persisting state.
  // Detect it BEFORE writing our own marker, then load that run's write-ahead
  // journal — the authority on which managed files it wrote and this run may
  // re-process. A resume with no journal (crash before any step persisted, or an
  // old marker-only install) re-processes nothing: the safe default.
  const resuming = existsSync(INPROGRESS_PATH);
  const priorJournal = resuming ? loadJournal() : new Set<string>();
  writeFileSync(INPROGRESS_PATH, new Date().toISOString() + "\n");
  if (resuming) log(`  (resuming an interrupted deploy — re-processing ${priorJournal.size} journaled managed file(s))`);
  const nextFiles = { ...previous.files };
  const seen = new Set<string>();
  const pathRewriteFiles: string[] = [];
  const tokenFiles: string[] = [];
  const managedWritten: string[] = [];
  // This run's write-ahead journal, persisted after each file-writing step.
  const journal = new Set<string>();
  const recordJournal = (paths: string[]): void => {
    for (const p of paths) journal.add(relativeKey(p));
    saveJournal(journal);
  };

  // 1. skills + loader symlink
  {
    // Sync every top-level skills/ entry EXCEPT "LifeOS". The LifeOS skill is a
    // loader SYMLINK (skills/LifeOS → ../LifeOS, i.e. the live repo-root LifeOS/
    // SKILL.md), created below. Copying install/skills/LifeOS/ here would both
    // win the lstat race so the symlink branch never runs AND deploy a stale
    // committed snapshot instead of the live skill — so it is excluded from the
    // sync, letting the symlink be the sole skills/LifeOS.
    let copied = 0, updated = 0, preserved = 0;
    const fails: string[] = [];
    for (const e of readdirSync(join(PAYLOAD, "skills"), { withFileTypes: true })) {
      if (e.name === "LifeOS") continue;
      if (!(e.isDirectory() || e.isFile())) continue;
      const r = syncManagedTree(join(PAYLOAD, "skills", e.name), join(CR, "skills", e.name), previous, nextFiles, seen, priorJournal);
      copied += r.copied;
      updated += r.updated;
      preserved += r.preserved;
      fails.push(...r.failures);
      managedWritten.push(...r.written);
      // Deployed skills carry hard-coded ~/.claude paths and bare ../…/LIFEOS
      // imports (skill tools import ../../../LIFEOS/TOOLS/Inference.ts, etc.), so
      // they MUST get the step-8 path-rewrite like runtime/hooks. They are NOT
      // added to tokenFiles: deployable skills contain no deploy-time tokens
      // ({{HOME}}/{{BUN}}/{{USER_DIR}}/…); the only {{…}} in skills are authoring
      // placeholders in docs (CreateCLI's {{CLI_NAME}} tutorial, ISA's {{VERSION}}
      // footer example) that deploy-time substitution would corrupt.
      pathRewriteFiles.push(...r.written);
    }
    failOnCopyErrors("skills synchronization", fails);
    recordJournal(managedWritten);
    let linkNote = "";
    const link = join(CR, "skills", "LifeOS");
    // Determine the current on-disk shape WITHOUT following the link.
    let linkStat: ReturnType<typeof lstatSync> | null = null;
    try {
      linkStat = lstatSync(link);
    } catch {}
    const isLoaderSymlink =
      linkStat !== null && linkStat.isSymbolicLink() &&
      (() => { try { return readlinkSync(link) === "../LifeOS"; } catch { return false; } })();
    if (isLoaderSymlink) {
      // Already the correct loader symlink — idempotent no-op.
      linkNote = "skills/LifeOS symlink OK";
    } else if (linkStat !== null) {
      // Present but NOT the loader symlink. The old deployer COPIED
      // install/skills/LifeOS/ as a real directory and enrolled its files in
      // state; stale-cleanup removes managed FILES but never their DIRS, so the
      // now-empty dir would permanently block the `../LifeOS` symlink and disable
      // the loader. Also covers a wrong-target symlink or a stray file. Remove it,
      // purge any enrolled `skills/LifeOS/**` keys (and mark them seen so
      // stale-cleanup does not later walk them THROUGH the fresh symlink), then
      // create the loader symlink.
      for (const k of Object.keys(previous.files)) {
        if (k === "skills/LifeOS" || k.startsWith("skills/LifeOS/")) {
          delete nextFiles[k];
          seen.add(k);
        }
      }
      const wasDir = linkStat.isDirectory() && !linkStat.isSymbolicLink();
      rmSync(link, { recursive: true, force: true });
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync("../LifeOS", link); // relative → <CR>/LifeOS
      linkNote = wasDir ? "skills/LifeOS migrated (copied dir → ../LifeOS symlink)" : "skills/LifeOS replaced → ../LifeOS symlink";
    } else {
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync("../LifeOS", link); // relative → <CR>/LifeOS
      linkNote = "skills/LifeOS → ../LifeOS created";
    }
    log(`  1. skills         copied ${copied}, updated ${updated}, preserved ${preserved}; ${linkNote}`);
    row("1 skills", copied, preserved, updated, linkNote);
  }

  // 2. runtime (per top-level entry, minus USER/MEMORY/node_modules/.git)
  {
    const runtimeSkip = new Set(["USER", "MEMORY", "node_modules", ".git"]);
    let copied = 0, updated = 0, preserved = 0;
    const fails: string[] = [];
    for (const e of readdirSync(join(PAYLOAD, "LIFEOS"), { withFileTypes: true })) {
      if (runtimeSkip.has(e.name)) continue;
      const r = syncManagedTree(join(PAYLOAD, "LIFEOS", e.name), join(RT, e.name), previous, nextFiles, seen, priorJournal);
      copied += r.copied;
      updated += r.updated;
      preserved += r.preserved;
      fails.push(...r.failures);
      managedWritten.push(...r.written);
      pathRewriteFiles.push(...r.written);
      tokenFiles.push(...r.written);
    }
    failOnCopyErrors("runtime synchronization", fails);
    recordJournal(managedWritten);
    log(`  2. runtime        copied ${copied}, updated ${updated}, preserved ${preserved} → ${RT}`);
    row("2 runtime", copied, preserved, updated);
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
    const result = syncManagedTree(join(PAYLOAD, "hooks"), join(CR, "hooks"), previous, nextFiles, seen, priorJournal);
    failOnCopyErrors("hooks synchronization", result.failures);
    managedWritten.push(...result.written);
    pathRewriteFiles.push(...result.written);
    tokenFiles.push(...result.written);
    recordJournal(managedWritten);
    log(`  4. hooks          copied ${result.copied}, updated ${result.updated}, preserved ${result.preserved}`);
    row("4 hooks", result.copied, result.preserved, result.updated);
  }

  // 5. agents + commands
  {
    const a = syncManagedTree(join(PAYLOAD, "agents"), join(CR, "agents"), previous, nextFiles, seen, priorJournal);
    const c = syncManagedTree(join(PAYLOAD, "commands"), join(CR, "commands"), previous, nextFiles, seen, priorJournal);
    failOnCopyErrors("agents synchronization", a.failures);
    failOnCopyErrors("commands synchronization", c.failures);
    managedWritten.push(...a.written, ...c.written);
    // agents/commands carry hard-coded ~/.claude paths too → step-8 path-rewrite.
    pathRewriteFiles.push(...a.written, ...c.written);
    tokenFiles.push(...a.written, ...c.written);
    recordJournal(managedWritten);
    log(`  5. agents         copied ${a.copied}, updated ${a.updated}, preserved ${a.preserved}; commands copied ${c.copied}, updated ${c.updated}, preserved ${c.preserved}`);
    row("5 agents", a.copied, a.preserved, a.updated);
    row("5 commands", c.copied, c.preserved, c.updated);
  }

  // 6. settings.json (refresh only while it remains deployer-managed)
  {
    const settingsPath = join(CR, "settings.json");
    assertSafeDestination(settingsPath);
    const key = relativeKey(settingsPath);
    const { json, rewrites, strippedHooks } = buildSettings();
    seen.add(key);
    if (!existsSync(settingsPath)) {
      writeFileSync(settingsPath, json);
      log(`  6. settings.json  CREATED (${strippedHooks} SessionStart backport hook(s) stripped; ${rewrites} path rewrite(s); env expanded)${FULL ? "; +statusLine +spinner" : ""}`);
      row("6 settings.json", "created", "", rewrites, FULL ? "full: statusLine+spinner" : "");
      nextFiles[key] = hashFile(settingsPath);
    } else if (previous.files[key] && hashFile(settingsPath) === previous.files[key]) {
      if (readFileSync(settingsPath, "utf8") === json) {
        log(`  6. settings.json  managed and current`);
        row("6 settings.json", "-", "current");
      } else {
        writeFileSync(settingsPath, json);
        log(`  6. settings.json  UPDATED (${strippedHooks} SessionStart backport hook(s) stripped; ${rewrites} path rewrite(s); env expanded)${FULL ? "; +statusLine +spinner" : ""}`);
        row("6 settings.json", "updated", "", rewrites, FULL ? "full: statusLine+spinner" : "");
      }
      nextFiles[key] = hashFile(settingsPath);
    } else {
      delete nextFiles[key];
      log(`  6. settings.json  locally modified or pre-existing → preserved`);
      row("6 settings.json", "-", "preserved");
    }
  }

  // 7. CLAUDE.md — intentionally NOT modified.
  log(`  7. CLAUDE.md      not modified (static, tracked)`);

  // 8. path-rewrite pass over deployed copies + paths.ts patch + chmod
  {
    const rewritten = rewriteManagedFiles(pathRewriteFiles);
    // paths.ts patch: getClaudeDir() must honor CLAUDE_CONFIG_DIR first.
    const pathsFile = join(CR, "hooks", "lib", "paths.ts");
    const patched = pathRewriteFiles.includes(pathsFile) ? patchPathsTs() : "managed copy unchanged";
    // chmod +x on the statusline + hook scripts.
    const chmodCount = chmodExecutables();
    // Re-persist the journal at this boundary: the same managed files now carry
    // their transformed bytes, so a crash here still leaves an accurate record.
    recordJournal(managedWritten);
    log(`  8. path-rewrite   ${rewritten.rewrites} rewrite(s) across ${rewritten.changed} managed file(s); paths.ts patch: ${patched}; chmod +x on ${chmodCount} script(s)`);
    row("8 path-rewrite", "", "", rewritten.rewrites, `${rewritten.changed} files; paths.ts ${patched}`);
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
    const applied = substituteManagedFiles(tokenFiles, tokenVars);
    recordJournal(managedWritten);
    log(`  9. tokens         ${applied} substitution(s) applied`);
    row("9 tokens", "", "", applied);
  }

  // 10. USER scaffold
  {
    assertSafeDestination(join(CR, "USER"));
    assertNoSymlinksInTree(join(CR, "USER"));
    const { copied, failures } = copyMissing(join(PAYLOAD, "USER"), join(CR, "USER"));
    failOnCopyErrors("USER scaffold", failures);
    const localized = localizeLifeosConfig(tokenVars["{{USER_DIR}}"], tokenVars["{{MEMORY_DIR}}"]);

    log(` 10. USER           copied ${copied} file(s); localized ${localized} default path(s) in USER/CONFIG`);
    row("10 USER", copied, "", localized);
  }

  // 11. USER symlink + contract check
  {
    const res = setupUserSeparation(join(CR, "runtime"), CR);
    const check = checkSymlinkContract(join(CR, "runtime"), CR);
    if (!check.passed) die(`USER symlink contract FAILED: ${check.detail} (setup action: ${res.action}${res.error ? `, error: ${res.error}` : ""})`);
    log(` 11. USER symlink   ${res.action}; contract OK (${check.detail})`);
    row("11 USER symlink", res.action, "", "", "contract OK");
  }

  // 12. deps — package.json is hash-managed exactly like settings.json (step 6),
  //     NOT copy-if-missing: absent → write from payload + enroll; unchanged
  //     since the last deploy → refresh from payload (so an upstream dependency
  //     bump is picked up before bun install); locally modified or pre-existing
  //     → preserve. Then bun install against the resulting manifest.
  {
    const pkgSrc = join(PAYLOAD, "package.json");
    const pkgDst = join(CR, "package.json");
    assertSafeDestination(pkgDst);
    const key = relativeKey(pkgDst);
    seen.add(key);
    let note: string;
    if (!existsSync(pkgDst)) {
      cpSync(pkgSrc, pkgDst);
      nextFiles[key] = hashFile(pkgDst);
      note = "written";
    } else if (previous.files[key] && hashFile(pkgDst) === previous.files[key]) {
      cpSync(pkgSrc, pkgDst);
      nextFiles[key] = hashFile(pkgDst);
      note = "refreshed";
    } else {
      delete nextFiles[key];
      note = "preserved";
    }
    log(` 12. deps           package.json ${note}; running bun install...`);
    const proc = Bun.spawnSync(["bun", "install"], { cwd: CR, stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) {
      die(`bun install exited ${proc.exitCode}: ${proc.stderr.toString().trim().split("\n").slice(-3).join(" | ")}`);
    }
    const hasYaml = existsSync(join(CR, "node_modules", "yaml"));
    if (!hasYaml) die(`bun install exited successfully but node_modules/yaml is missing`);
    log(`     bun install    ok (node_modules/yaml present)`);
    row("12 deps", note, "", "", `bun install ok`);
  }

  // Remove payload files that disappeared upstream only while their deployed
  // copies are still byte-for-byte managed. Locally modified stale files stay.
  const stale = removeStaleManagedFiles(previous, nextFiles, seen);
  if (stale.removed || stale.preserved) {
    log(` 13. stale files    removed ${stale.removed} managed file(s); preserved ${stale.preserved} locally modified file(s)`);
    row("13 stale files", stale.removed, stale.preserved);
  }

  for (const path of managedWritten) nextFiles[relativeKey(path)] = hashFile(path);
  saveDeployState(nextFiles);
  // State is durable now: the deploy is complete and recoverable. Clear BOTH the
  // crash-recovery breadcrumb and the write-ahead journal so the next --apply is
  // not treated as a resume.
  rmSync(JOURNAL_PATH, { force: true });
  rmSync(INPROGRESS_PATH, { force: true });

  log("");
  printSummary();
  log("\nDeploy complete.");
}

/** Insert a CLAUDE_CONFIG_DIR-first branch at the top of getClaudeDir(). */
function patchPathsTs(): string {
  const p = join(CR, "hooks", "lib", "paths.ts");
  if (!existsSync(p)) die(`required deployed hook helper missing: ${relativeKey(p)}`);
  let src = readFileSync(p, "utf8");
  if (src.includes("process.env.CLAUDE_CONFIG_DIR")) return "already patched";
  const anchor = "export function getClaudeDir(): string {";
  const idx = src.indexOf(anchor);
  if (idx < 0) die(`cannot patch ${relativeKey(p)}: getClaudeDir() anchor not found`);
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
