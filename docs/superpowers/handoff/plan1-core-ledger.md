# SDD ledger — plan: docs/superpowers/plans/2026-10-23-rampart-core.md

Spec: docs/superpowers/specs/2026-10-23-rampart-design.md (read; binding authority).
Worktree: .worktrees/feat-core on branch feat/core, base fd087a4 (main).
Ruling: default branch renamed master→main and work isolated on feat/core in .worktrees/ — public-repo convention and the SDD isolation rule; the session folder is the multi-repo parent so the native worktree tool does not apply — costs nothing if wrong beyond a branch rename.
Models: implementers Sonnet (mechanical, complete specs), Opus for Task 13 (dashboard design), Task 15 (skill prose) and Task 16 (acceptance); reviewers Sonnet for small diffs, Opus for Tasks 5, 13, 15; final whole-branch review on Opus.

## Pre-flight conflict scan

| Pair / task | Produces vs consumes | Found |
|---|---|---|
| T2 ↔ T5, T6, T12, T13 | paths/id exports vs store, normalize, inventory, render | consistent names (rampartHome, projectDir, runDir, newRunId, findingId, machineId) |
| T3 ↔ T5 | redact() vs writeRaw | consistent |
| T4 ↔ T12 | validator subset vs draftProject must fail only on empty ownerAttestation.statement | CONFLICT: validator list lacks minLength; schema has no minLength on statement |
| T4 ↔ T5, T6, T7 | schemas vs validate calls | consistent |
| T5 ↔ T8, T9, T10 | upsertFindings(slug, findings, runId), createRun/finishRun, writeRaw | consistent |
| T5 ↔ T10, T11 | appendScore/readScores snapshots carry `kind` | gap: T11 trend must use only kind==='project' snapshots |
| T5 ↔ T15 | project-save, set-class, disposition CLI verbs | consistent |
| T6 ↔ T7 | T7 modifies normalize.cjs created in T6 | sequential, fine |
| T8 ↔ T9 | which(bin, envOverride) + node: shim form | gap: T9 names no override env for npm/pnpm |
| T11 ↔ T4 | system.criticality optional enum | consistent |
| T13 ↔ T11, T5 | scoreProject, readFindings, listProjects | consistent |
| T15 ↔ T8–T14 | recipe CLI names and flags | consistent (--json, --open, project-save, set-class) |
| T1 | .gitignore already exists on main with 6 entries incl. .worktrees/ .superpowers/ | implementer must keep them |
| T1 | `claude plugin validate --strict` with no components | brief already allows noting a components-only failure |
| T8 | shim ignores --source, writes to --report-path | self-consistent |
| T13 | "planted Secret absent" assertion | trivially true but harmless |

Ruling: add `minLength` to the T4 validator subset and `"minLength": 1` to project-schema `ownerAttestation.statement` — needed for T12's test; costs one more validator keyword if wrong.
Ruling: T9 tool overrides are `RAMPART_TRIVY`, `RAMPART_NPM`, `RAMPART_PNPM` (same `node:<path>` shim form as T8) — needed for tests without a shell; no cost if wrong.
Ruling: T11 trend compares against the previous snapshot with `kind === 'project'` only — headers snapshots share the file; no cost if wrong.

## Progress
Task 1: dispatched (base fd087a4, implementer sonnet)
Ruling: Task 1 test script is `node --test tests/*.test.cjs` (Node 22+ ignores a bare directory arg) — deferred minor: Node 18/20 on Windows would not expand the glob; revisit in Task 16 (README note or tiny runner). Costs nothing for the author (Node 24).
Ruling: commit trailer stays `Co-Authored-By: Claude Fable 5.1` per this session's attribution rule, whatever model the implementer runs on.
Task 1: minor (deferred): npm test glob needs Node 21+ on Windows (engines says >=18) — revisit in Task 16.
Task 1: minor (deferred): smoke test version regex unanchored; no zero-deps / version-match assertions.
Task 1: minor (deferred): SECURITY.md states owner-attestation enforcement before it exists — true once Task 15 lands.
Task 1: complete (commits fd087a4..59af457, review clean)
Task 2: dispatched (base 59af457, implementer sonnet)
Task 2: minor (deferred): TypeError branch in normalizeLocation untested; null location gives native message.
Task 2: minor (deferred): projectDir/runDir accept any string — Task 5 store must reject slugs/runIds that are not a single safe segment (carry to T5 dispatch).
Task 2: minor (deferred): test.afterEach needs Node 18.8+; engines says >=18.
Task 2: complete (commits 59af457..7eee0be, review clean)
Task 3: dispatched (base 7eee0be, implementer sonnet)
Ruling: Task 3 pre-review correction — key=value separator uses [ \t]* and a bearer-token rule was added (implementer concerns, correctness) — costs one extra regex if wrong.
Ruling: Task 3 key=value pattern amended beyond the plan text — allow a key-name suffix (`secret_access_key`), quoted values with spaces, and escaped JSON quotes; add prefixes ASIA/github_pat_/sk-proj_, Basic auth, and URL userinfo passwords. The spec forbids any stored credential value, so leak classes beat the plan's literal regex. Costs: more over-redaction in raw output (safe direction).
Task 3: review found 4 Important (3 leak classes from the brief pattern, 1 quadratic JWT regex) — fix round 1 dispatched
Task 3: fix round 1/5 (5 addressed, 0 open; commits d7b2535..84b4b5a)
Task 3: minor (deferred, fix in final wave): JWT lookbehind misses URL-encoded prefixes (`Bearer%20<jwt>`, `token%3D<jwt>`) — replace with `(?:(?<![A-Za-z0-9_-])|(?<=%[0-9A-Fa-f]{2}))` (probed linear by re-reviewer).
Task 3: minor (deferred): double-escaped JSON and same-type inner quotes leak; unterminated quote redacts first word only.
Task 3: complete (commits 7eee0be..84b4b5a, review clean after 1 round)
Task 4: dispatched (base 84b4b5a, implementer sonnet)
Ruling: Task 4 schema choices accepted — created/updated/firstSeen/lastSeen optional (store stamps them); systems[] requires executor+layers (carry to T12: draftProject sets executor either/local); repo requires only paths; validator type accepts a list for nullable fields. Costs a schema edit if wrong.
Task 4: minor (deferred): layer sub-schema duplicated ×4, cadence tested for L1 only; by/at lack minLength; nested objects open; validate throws on non-object schema; line accepts 0/negatives; cached schema object mutable.
Task 4: carry-forward (Plan 3): job/finding schemas lack `updatedAt` and the apply second-confirmation fields spec §5.7 names — add before DB sync validates documents.
Task 4: complete (commits 84b4b5a..8a402e2, review clean)
Task 5: dispatched (base 8a402e2, implementer sonnet)
Ruling: Task 5 pre-review corrections — a verified class survives a tool re-scan (keeps class+evidence); regression writes dispositions[id]=regressed by rampart. Needed so the L1 secrets triage is not undone by the next scan; costs one merge branch if wrong.
Task 5: minor (deferred): store.cjs is 448 lines; CLI block (~110 lines) is the natural split seam.
Task 5: minor (deferred, final wave): Windows rename EPERM retry; reserved device names in slug/raw-name guards; tolerate torn last JSONL line; redact incoming finding text fields in upsert; derive SLUG_RE/statuses/classes from schemas; split CLI into store-cli.cjs; tests for write order and regressed+changed; writeProject bad slug throws Error not RangeError (accepted).
Task 5: minor (deferred, Plan 3): no lock on read-modify-write — watch loop vs terminal CLI can drop an update; lockfile with wx.
Task 5: complete (commits 8a402e2..798086e, review clean)
Task 6: dispatched (base 798086e, implementer sonnet)
Ruling: Task 6 pre-review corrections — normalizeLocation detects package before path (changes Task 2 ordering); trivy ruleId always `trivy/pkg/<Pkg>@<Target>` for stable ids across lockfile additions; npm transitive-only entries are skipped only when their via chain resolves to an emitted advisory. Costs: longer rule ids; nothing stored yet.
Task 6: carry-forward (T9): fromNpmAudit throws on malformed/v1/error reports — the CLI must treat that as a tool failure (skipped run), never as clean.
Ruling: gitleaks ruleId becomes `gitleaks/<RuleID>@<commit12>` (plain when no commit) so distinct leaks of one rule in one file (rotated keys) get distinct stable ids; commits are immutable so this does not reintroduce line drift. Costs: a leak reported at several commits yields several findings (acceptable; each is a real exposure).
Task 6: review found 2 Important (malformed npm v2 returns clean; gitleaks id collisions) — fix round 1 dispatched
Task 6: fix round 1/5 (3 addressed, 0 open; commits 1d3913b..e61390c)
Task 6: minor (deferred): compareVersions mis-orders Alpine -rN revisions (string compare); id.cjs comment should note gitleaks commits enter via ruleId; fromNpmAudit/fromTrivy silently skip non-object entries; plan text still says gitleaks ruleId without @commit.
Task 6: complete (commits 798086e..e61390c, review clean after 1 round)
Task 7: dispatched (base e61390c, implementer sonnet)
Ruling: header weights sum to 105 (plan arithmetic error); score floors at 0 rather than re-weighting — keeps the brief's 20→F example valid; costs nothing.
Task 7: carry-forward (T10): gradeHeaders/fromHeaders need a plain object — build it with Object.fromEntries(res.headers) plus getSetCookie() for cookies.
Ruling: referrer check also rejects unsafe-url (implementer addition) — ratified; costs one extra failing header class.
Task 7: minor (deferred): referrer comment overstates token logic; CHECKS[i].test needs pre-normalized keys (document); cookie array items should not be comma-split; duplicate max-age directives.
Task 7: complete (commits e61390c..8955517, review clean)
Task 8: dispatched (base 8955517, implementer sonnet)
Ruling: Task 8 pre-review correction in store — change detection ignores verification.run (still stored) so repeat scans count unchanged; costs nothing if wrong.
Task 8: minor (deferred, final wave): keepTriage should also preserve verification counts (verifiers/confirmed) when a tool re-scan hits a verified finding.
Task 8: carry-forward (T9): on Windows `which(npm)` resolves npm.cmd which Node 24 refuses to spawn with shell:false — run `node <npm-cli.js>` (locate via process.execPath dir /node_modules/npm/bin/npm-cli.js, or RAMPART_NPM override); never use shell:true.
Ruling: gitleaks exit 1 with an empty report is `skipped` (gitleaks also exits 1 on scan errors and still writes the report) — refines the plan's "1 = leaks found"; costs a skipped run in the impossible case of a real exit-1 clean scan.
Task 8: review found 1 Important (exit 1 + empty report recorded as clean) — fix round 1 dispatched
Task 8: fix round 1/5 (2 addressed, 0 open; commits 4ea1690..bfdd455)
Task 8: minor (deferred): l1-secrets header comment says exit 1 is a finished scan; store.cjs readOptional has a literal BOM; exec timeout clause flags any SIGTERM; env spread loses Windows case-insensitivity; TypeError catch hides normalizer bugs.
Task 8: complete (commits 8955517..bfdd455, review clean after 1 round)
Task 9: dispatched (base bfdd455, implementer sonnet)
Ruling: Task 9 pre-review — shared L1 CLI scaffolding extracted to scripts/lib/l1-common.cjs (not in the plan file map) so Task 10 does not copy it a third time; npm/pnpm exit 1 with zero vulnerabilities is skipped (mirrors gitleaks); run.tool.version omitted (schema types it as string). Costs one more lib file.
Ruling: scanDeps has no `tool?` option — the RAMPART_TRIVY/NPM/PNPM env overrides replace it; costs nothing.
Task 9: minor (deferred): auditCommand skip glue untested end to end; rename needsShell→notSpawnable; RAMPART_NPM pointing at npm.cmd is silently replaced; ENOBUFS reported as "could not be started"; pnpm legacy audit shape untested (skips cleanly); --repo with --input silently ignored.
Task 9: complete (commits bfdd455..946a46c, review clean)
Task 10: dispatched (base 946a46c, implementer sonnet)
Ruling: Task 10 pre-review — final URL stripped of query/fragment (stable ids, no tokens stored); new store.closeMissing(slug,{system,source,runId,seenIds,filter}) auto-closes findings a deterministic scan no longer reports (headers per page, deps per source; never secrets), run counts gain optional `closed`; headers close only on status <400. Needed for the "dashboard never stale" anti-goal; costs: a site that moves URL leaves old-page findings open until dispositioned.
Task 10: minor (deferred): local arg parser instead of shared parseArgs; User-Agent carries <owner> placeholder until the GitHub owner is set.
Task 10: minor (deferred): raw headers.json stores requested url as given (apply pageOf); getSetCookie fallback untested; pnpm/--input closing paths untested; run-schema reason description; CLI entry lacks .catch; store crash comment overclaims.
Task 10: complete (commits 946a46c..14cc581, review clean)
Task 11: dispatched (base 14cc581, implementer sonnet)
Ruling: Task 11 — a project with no systems scores 0/F (unscored is not safe); any done run naming system+layer credits coverage regardless of job type (plan text). Costs nothing.
Ruling: grades are taken from the rounded (one-decimal) score at both levels so the printed sheet and the grade always agree — record in specs/score.md (T15). Costs: 89.95+ rounds to an A.
Task 11: minor (deferred): readRuns skips non-object run.json silently; empty project still appends a 0/F snapshot (skip saving when no systems); extract trendFrom(); CLI scaffolding duplicated with store.cjs (shared lib/cli.cjs).
Task 11: complete (commits 14cc581..75a1d65, review clean)
Task 12: dispatched (base 75a1d65, implementer sonnet)
Task 12: carry-forward (T15): inventory-mapper/recipe must fill `host` for supabase/n8n/docker-host systems and ask for live URLs; repo.remote is the credential-stripped git URL as reported.
Task 12: review found 1 Important (commented compose lines yield phantom n8n) — fix round 1 dispatched
Task 12: fix round 1/5 (4 addressed, 0 open; commits 41957ae..9ee3e7e)
Task 12: minor (deferred): nested ${A:-${B:-x}} defaults unresolved; comment-tail strip not quote-aware; detection imperative rather than table-driven; static-site type never produced.
Task 12: complete (commits 75a1d65..9ee3e7e, review clean after 1 round)
Task 13: dispatched (base 9ee3e7e, implementer opus)
Ruling: commit trailers name the model that authored the commit (Task 13 carries Opus 5.5; the Sonnet tasks carry Fable per my earlier instruction) — accepted as-is, no amend; the inconsistency is cosmetic.
Task 13: carry-forward (final wave): store.upsertFindings should redact incoming finding text (buildData redacts defensively today).
Ruling: score sheet shows only layers some system declares (not a fixed four) — accepted.
Task 13: minor (deferred, final wave): drop aria-disabled on working copy buttons; copy fallback focuses aria-hidden input; "overdue" uses Date.now() vs generatedAt; long names need overflow-wrap; --faint and light grade-D contrast; findings table title column order on phones; empty-store test first assertions vacuous; buildData should drop repo.paths/host/live/ownerAttestation from the published page.
Task 13: carry-forward (Plan 3): render() is a full redraw (scroll/focus/details reset) — live mode needs an incremental update path; xdg-open can block 15 s on Linux.
Task 13: complete (commits 9ee3e7e..80a02dc, review clean)
Task 14: dispatched (base 80a02dc, implementer sonnet)
Ruling: Task 14 claude-security detection has three sources (installed_plugins.json, settings.json enabledPlugins, marketplace clone on disk) with claudeSecuritySource reported; marketplace means present, not necessarily enabled (T15 recipe must say "available"). Costs: a false "available" when the clone exists but the plugin is disabled.
Ruling: doctor tools table is the brief's five plus git; npm/pnpm are not probed (overrides listed generically). Costs nothing.
Task 14: review found 1 Important (diagnose throws when os.homedir throws) — fix round 1 dispatched
Task 14: fix round 1/5 (3 addressed, 0 open; commits 119e75c..1b4f712)
Task 14: minor (deferred): POSIX-only arg-pinning test never run on a POSIX host (no CI yet); found-but-unusable tools not in degraded (T15 recipe: version null = check it).
Task 14: complete (commits 80a02dc..1b4f712, review clean after 1 round)
Task 15: dispatched (base 1b4f712, implementer opus)
Ruling: Task 15 — Write added to allowed-tools (inventory draft); empty-state text points to inventory then audit L1; triage dismissals recorded --by rampart; confirmed systems get source "confirmed" (free string in schema).
Task 15: carry-forward (final wave): flat trend — score.cjs saves a snapshot and render-static then compares against it; store trend in the snapshot and have buildData use it.
Task 15: minor (deferred): agent git allow-rules (git log *, git show *) do not match `git -C <root> …`; explore reads the working tree when the repo is not the session cwd.
Task 15: review found 3 Important (subagent text in double-quoted shell args; unbounded findings --json dumps; --repo gate without remote) — fix round 1 dispatched
Ruling: Task 15 fix — store findings gains --source/--system/--since/--new-since/--id/--ids filters; triage set uses --new-since (firstSeen) since every sighting bumps lastSeen; project --json prints machineId. Costs nothing.
Task 15: fix round 1/5 (4 addressed, 0 open; commits b88f6c1..02669e1)
Task 15: minor (deferred): inventory merge tie-break for several same-type systems on one remote; mapper front-matter still grants Bash(git remote *) though unused (drop in final wave); UNC paths in double quotes.
Task 15: complete (commits 1b4f712..02669e1, review clean after 1 round)
Task 16: dispatched (base 02669e1, implementer opus)
Ruling: Task 16 fresh-session acceptance (claude -p) is blocked by an expired CLI OAuth login that only Pedro can renew; the plugin loads (skill + 2 agents visible before the auth error) and all four steps pass when walked by hand through the recipes. Parked: rerun with `claude auth login` then task-16-logs/rerun-acceptance.sh. Costs: recipe wording untested against a live model until then.
Ruling: scores cap at C in v0.1 because L2/L3 are declared but have no engine yet — kept as the honest reading (those layers really are unaudited); README states it.
Task 16: carry-forward (final wave): add .claude-plugin/marketplace.json so `/plugin marketplace add <owner>/rampart` works, validating the plugin manifest by explicit path; fix the flat-trend bug (snapshot saved before render).
Task 16: fix round 1/5 (3 addressed, 0 open; commits 96b7309..8b1d07d)
Task 16: fresh-session acceptance re-run after Pedro logged the CLI in: 4/4 steps exit 0, no stderr (doctor explained; inventory reached the recipe and asked its first question; audit L1 ran l1-secrets --input and l1-deps --input --format npm → 4 findings, scored, rendered; dashboard rendered and named the project). Logs: task-16-logs/rerun-*.
Task 16: complete (commits 02669e1..8b1d07d, review clean after 1 round, acceptance 4/4)
ALL TASKS COMPLETE — final whole-branch review dispatched (opus), merge-base fd087a4
FINAL REVIEW: ready with fixes — 1 Critical (raw gitleaks --input report keeps Match/Line/Secret values), 7 Important, cheap list; report at .superpowers/sdd/2026-10-23-rampart-core/final-review.md
Ruling: dependency closeMissing closes findings from any dependency source (trivy, npm-audit, pnpm-audit) for the system — one dependency scan is authoritative for that system's deps; headers stay per page. Reverses part of the T10 per-source scoping; costs nothing when the tool does not change.
Ruling: one checkout detected as two repo-type systems is folded into one system carrying both packs (primary type first) so each repo path is scanned and triaged once. Costs: a monorepo wanting separate systems edits project.json by hand.
Ruling: SKILL.md allowed-tools narrows `Bash(git *)` to the git commands the recipes actually run (config user.name, remote get-url, rev-parse); recipes adjusted. The never-apply rule no longer rests on model restraint alone.
Ruling: a gitleaks history finding marked fixed does not become regressed on the next scan (history cannot un-leak; fixed means rotated) — upsert keeps fixed and bumps lastSeen for source gitleaks findings that carry a commit. Costs: a genuinely re-committed secret at a new commit is a new finding anyway (different id).
Ruling: Node floor raised to >=20 (18 is end-of-life; test.afterEach/parseArgs need 18.3+ anyway); spec said >=18 — documented deviation.
Ruling: version bumps to 0.1.0-alpha.2 after the wave; tag re-cut.
FINAL FIX WAVE: dispatched (opus) — one fixer, complete list
FINAL FIX WAVE: landed 8b1d07d..611b823 (9 commits, 566 pass / 1 skip, both manifests validate, tag rampart--v0.1.0-alpha.2). Not done: explore agent git -C rule (ruling below).
Ruling: explore agent keeps only `git log *` / `git show *` — a `git -C *` rule would also approve `-c`/`--exec-path`, which run arbitrary commands, undoing the I5 narrowing; triage reads the working tree when the repo is not the session cwd. Costs: weaker history evidence for triage in that case; listed as a known limitation.
Ruling: --repo gate now resolves the remote through `inventory-scan.cjs --remote` (credential-stripped) instead of a git call; the unused `git remote get-url *` / `git rev-parse *` allow rules stay (harmless, read-only).
Ruling: I3 fold ranking Expo > Next.js > WordPress > Workers > Node API > static site.
FINAL RE-REVIEW: all addressed except one residual — a SARIF/CSV gitleaks report passed with --input is stored raw with the value (run is skipped). New minor: torn-line tolerance also reaches findings.jsonl.
Ruling: one bounded follow-up fix (same fixer, two items: allowlist gitleaks entry keys and stub non-array input; torn-line tolerance limited to scores.jsonl) despite the no-second-wave rule — it is a credential-storage path, the tool's headline promise, and the fix is specified exactly. Costs: one more small commit and re-tag.
Ruling: I2 cost (a machine with only npm closes trivy findings of other ecosystems) recorded as a CHANGELOG known limitation; alpha.1 tag deletion accepted (nothing pushed).
