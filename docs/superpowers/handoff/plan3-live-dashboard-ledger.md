# SDD ledger — plan: docs/superpowers/plans/2026-10-23-rampart-live-dashboard.md

Branch feat/live-dashboard, worktree rampart/.worktrees/live-dashboard, base main 17d4ac6.
Spec: docs/superpowers/specs/2026-10-23-rampart-design.md (§5.7, §5.8, §5.9). Capability contract read: db.d.ts, user.d.ts (0.2.89); ArtifactData tool schema read.

## Pre-flight scan

| Pair / task | Produces → consumes | Finding |
|---|---|---|
| T1 → T2,T6,T8 | job-schema fields → page job doc, watch patches | job-schema has required `executor`; plan's job doc uses `executorKind` (R1) |
| T1 → T2 | finding/run/project `updatedAt` | project already has `updated` stamped by writeProject (R2) |
| T1 db-rules.json → T9 publish | rules value | capability contract takes rules as ARRAY `[{path, read, write}]`, not keyed object (R3) |
| T2 planPush → T9 recipe | batch payload | ArtifactData batch: max 50 entries, key `op` not `action`, every write to an existing doc needs `if_version` (R4) |
| T2 applyPull → T7 settings | projects/<slug> settings → project.json | T2 lists only findings+jobs; T7 needs settings pulled (R5) |
| T3/T4/T6/T7 gating | `user.can("data.write")` | can() reflects ROOT rule; collections are owner-only, so gate must also need isOwner (R6) |
| T5 → T8 | jobs.cjs CLI `claim-patch|completion-patch --json` | T5 interface lists no CLI (R7) |
| T6/T8 owner id | `createdBy === owner id` | Claude side cannot call user.id(); recipe needs owner id from the DB (R8) |
| T8 claim | conditional update on queued | ArtifactData `if_version` is a real CAS; use it (R9) |
| T8 idle | ScheduleWakeup at 120 s | ScheduleWakeup only works under /loop dynamic mode (R10) |
| T6 mcp | Claude Code Remote `create_session` args | connector not connected in this session; arg names unverifiable (R11) |
| T9 → audit.md/inventory.md/verify.md | sync line | verify.md is Plan 2's (not on main); audit.md shared with Plan 2 (R12) |
| T2,T8 ↔ Plan 2 T4 | store.cjs | both add exports; keep edits additive (R13) |
| T11 ↔ Plan 2 T14 | version bump | Plan 2 releases 0.2.0-alpha.1 (R14) |
| T3 ↔ Plan 2 T13 | dashboard data-engines | one-attribute overlap; leave data-engines alone |
| T1 self | tests vs files | consistent |
| T2 self | buildPage vs renderStatic | consistent (renderStatic switches to buildPage) |
| T3 self | static vs live loadData | consistent; published template must keep #rampart-data empty |
| T4 self | update on findings/<id> | consistent; `update` requires existing doc (fine: push created it) |
| T5 self | cost table | L3 "all classes" ambiguous count (R15) |
| T6 self | job doc vs schema | covered by R1 |
| T7 self | toSarif | consistent |
| T8 self | store helpers vs recipe | consistent after R7–R10 |
| T9 self | verification rule | `as_level: "view"` read on jobs; writes at view must fail |
| T10 self | PostToolUse matcher | matcher matches tool name only; script filters `git push` from tool_input.command (R16) |
| T11 self | acceptance | depends on R11 for cloud route (not exercised: local only) |

Ruling R1: job-schema replaces `executor` with required `executorKind` (local|cloud) — the plan's T5/T6/T8 all use executorKind and no job doc exists yet — cost if wrong: a rename later.
Ruling R2: projects keep the store's existing `updated` stamp; planPush emits it as `updatedAt` on the projects doc (no new project field); findings get `updatedAt` stamped by upsertFindings/setDisposition, runs by finishRun — the plan's intent with less schema churn — cost: one mapping line.
Ruling R3: db-rules.json is the array form the contract requires: root `{path:"", read:"view", write:"owner"}` plus one `{path:<collection>, read:"view", write:"owner"}` per collection (projects, findings, runs, jobs, executors, packs, meta) — the plan's "keyed" wording would be refused at publish — cost: none.
Ruling R4: planPush emits ArtifactData batch entries `{op, collection, doc_id, data, if_version?}`, chunked at 50; it takes an optional versions map (`"<collection>/<id>" → version`) the recipe builds from a pre-push read, and `if_version` is set when known — spec's authority is the tool contract; plan's 100/`action` would be refused — cost: none.
Ruling R5: applyPull also handles `projects` docs: page-written settings (`cloudAllowed`, `defaultExecutor`, `huntEffort`, `cadenceOverrides: {<systemId>: {<layer>: days}}`) apply to project.json when the doc's `updatedAt` is newer than the project's `updated`; project-schema gains optional `huntEffort` (low|medium|high) — T7 needs it — cost: small.
Ruling R6: write controls render only when `isOwner()` is true AND `can("data.write") !== false`; null user → read-only — collections are owner-only (spec §5.7), and can() reflects only the root rule — cost: a Contributor never sees controls they could not use anyway.
Ruling R7: T5's jobs.cjs gets a CLI: `new-id`, `cost`, `route`, `claim-patch`, `completion-patch`, each `--json` — T8 depends on it — cost: none.
Ruling R8: the page, when `isOwner()` and `meta/owner` is absent, writes `meta/owner = {ownerId: await user.id(), at}` once; the publish recipe reads `meta/owner` (after Pedro opens the page once) into config.json `dashboard.ownerId`; watch refuses to run jobs until ownerId is known — Claude cannot read user.id() itself — cost: one extra page open at first publish.
Ruling R9: a claim is `ArtifactData get jobs/<id>` → if `status === 'queued'` → `update` with the claim patch and `if_version` = the version just read; a version conflict is a lost race (skip). This IS the plan's conditional update — cost: none.
Ruling R10: `/rampart watch` processes the queue once per invocation; continuous mode is `/loop /rampart watch` where ScheduleWakeup (120 s, noop when idle) paces it; `--once` never schedules — ScheduleWakeup only exists under /loop — cost: users type /loop.
Ruling R11: the page keeps the plan's pinned `create_session` / `send_message` args, treats any callTool rejection as "queued — start /rampart watch" (job stays in the DB), and the report states the connector schema could not be verified in this session — cost: cloud route may need an arg fix later.
Ruling R12: Task 9's sync line goes at the END of audit.md and inventory.md only; verify.md belongs to Plan 2 and gets its line when the branches meet (noted in CHANGELOG/PR) — cost: verify jobs don't auto-sync until then.
Ruling R13: store.cjs edits are additive (new functions appended before module.exports, export list extended on its own line) to merge cleanly with Plan 2 — cost: none.
Ruling R14: this branch bumps to 0.3.0-alpha.1 (Plan 2 owns 0.2.0-alpha.1) — distinct tags whichever merges first — cost: version order if Plan 3 merges first.
Ruling R15: L3 "all classes" = the system's pack class count when known, else 10; cost formula `units × classes × 2` with classes 5|10|all — cost: an estimate is an estimate.
Ruling R16: hooks.json PostToolUse matcher `Bash`; post-push.cjs exits silently unless `tool_input.command` matches /\bgit\s+push\b/ — matchers only see tool names — cost: none.

## Tasks
Task 1: minor (deferred): db-layout.md:6 says every doc carries updatedAt; only conflictable docs do
Task 1: minor (deferred): nested costEstimate/applyConfirmation/disposition lack additionalProperties:false (matches convention)
Task 1: minor (deferred): applyConfirmation not tied to type apply in schema; enforce in jobs.cjs/page
Task 1: complete (commits 17d4ac6..4086c2a, review clean)
Ruling R17: planPush emits no `packs` docs in this plan — packs/ and its loader are Plan 2's and not on main; the packs collection fills after the branches meet — cost: an empty packs collection until then.
Ruling R18: `sync-plan.cjs push --out <dir>` writes each doc body to `<dir>/docs/<collection>/<id>.json` and `<dir>/batches.json` = `{cursor, batches: [[{op, collection, doc_id, file_path, if_version?}, ...≤50], ...]}`, so the recipe passes small `writes` arrays (file_path entries) and no store data passes through the conversation — cost: none.
Ruling R19: push takes `--versions <file.json>` (`{"<collection>/<id>": version}`) and sets `if_version` when known (op `update` pinned with `if_version` when the map has the doc, else `set` to create it; finding docs carry `disposition` from dispositions.json (null when none) so the recipe's pull-then-push order never clobbers a page disposition); pull `--in` accepts a JSON array file or an ArtifactData out_dir tree (`<dir>/<collection>/<id>.json`), tolerating a wrapper `{id, data, version}` or a bare body; Task 9 adds the versions-map builder after observing the real out_dir format — cost: Task 9 adapts a reader.
Ruling R20: the store's job helpers (`writeJob(job)`, `readJobs(slug?)`, files `~/.rampart/jobs/<id>.json`) land in Task 2 because applyPull mirrors jobs first; Task 8 reuses them and adds `readConfig().dashboard` handling — cost: none.
Ruling R21: setDisposition gains an optional `at` so a pulled page disposition keeps its own timestamp; findings push when `updatedAt` or `lastSeen` is after `since`; each finding doc's `updatedAt` = its updatedAt || lastSeen; run docs truncate `reportMd` to 200 000 chars (doc cap 256 KiB) — cost: a very long report is cut on the page only.
Ruling R22: finding `location.url` is reduced to origin+pathname in every page-bound output (buildPage and planPush finding docs) — global constraint bans URL queries in page data, and a headers finding's url is the live url — cost: none.
Ruling R23: the push cursor compares `>=` against `since` (re-pushing a doc is idempotent; missing one is not) — cost: an occasional duplicate write.
Ruling R24: the project doc's `updatedAt` stays the project's `updated` (R2) even when only the score changed — pull applies page settings before push, so ordering holds — cost: none.
Task 2: note: implementer wrote code before tests (no RED run); substituted a mutation check. Accepted, process deviation recorded.
Ruling R25: merge rule for a page (person) disposition vs a local automated status — `accepted_risk` and `false_positive` from the page always win (judgments automation never overrides; matches upsertFindings and Review Focus 4); a page `fixed` or `open` wins unless the local automated change (`by: 'rampart'`, e.g. regressed/closed) is strictly newer than the page decision's `at` (a later scan is new evidence); person vs person: newer `at` wins; a page decision equal to the one already applied (status, by, at) is a no-op — spec's "always beats" read as "beats concurrent automation", the literal reading suppresses regressions forever — cost: a person's `fixed` older than a later regression no longer hides it (intended).
Ruling R26: project docs carry `cadenceOverrides: null` on push, so a consumed page override never lingers in the DB — cost: none.
Task 9 carry: the recipe reads DB docs + versions ONCE, pulls from that snapshot, then pushes pinned to those versions; a conflict means re-read and redo (never read versions after the pull).
Task 2 ⚠️ deferred to Plan 2 merge: finding `location.host` passes unchanged; infra findings must write a bare hostname or publicFinding must reduce it.
Task 2: fix round 1/5 (7 addressed, 0 open — merge rule R25, scp remotes, safe --out, updatedAt stamp, byte cut, id check, R26; commits bfcc3d5..dae5523)
Task 2: minor (deferred): finishRun stamps updatedAt on non-final patches (running runs get pushed; harmless)
Task 2: minor (deferred): clearEarlierPlan does not resolve a symlinked <out>/docs
Task 2: complete (commits 4086c2a..dae5523, review clean)
Task 3 note: meta/owner write (R8) is assigned to Task 3's live data source boot.
Task 3: review: 2 Important (focus lost on removal; unguarded user capability) + minors 3-6 folded into fix round 1
Ruling R27: in static mode too, dispositionText never prints a raw user id: `rampart` → "Rampart", an id starting `u_` → "dashboard user", else the stored name (local CLI `by` values are names) — carried into Task 4 (dispositions) — cost: none.
Task 3: fix round 1/5 (6 addressed, 0 open — focus on removal, guarded user capability, fromCache, raw ids, terminal errors, test title; commits 2e2a85f..378d656)
Task 3: minor (deferred): connectUser's catch also swallows a render() throw (intended trade-off)
Task 3: minor (deferred): before meta/owner exists, the owner's own page decisions read "a viewer"
Task 3: complete (commits dae5523..378d656, review clean)
Task 4: ⚠️ carried to Task 11: on the real store a rejected write's revert depends on the platform's corrective snapshot (latency compensation); stub doesn't model it
Task 4: minor (deferred): stub lacks latency compensation on rejection (overlay pre-write state until hasPendingWrites false)
Task 4: minor (deferred): refuse() inline error on an untouched form is wiped by the next snapshot (set data-dirty)
Task 4: minor (deferred): an abandoned dirty form stays frozen until saved
Task 4: minor (deferred): focus drops to body when a save hides the row under the default filter
Task 4: minor (deferred): no single retry on `unavailable` (db.d.ts guidance)
Task 4: minor (deferred): tests miss "Nothing to save", regressed placeholder, "Choose a decision", quota/resource hints
Task 4: note: writes on Save rather than on select change (required reason can't precede a change event) — reviewer accepted; patch shape exact
Task 4: complete (commits 378d656..2c709a5, review clean)
Ruling R28 (refines R15): costEstimate takes optional `units` (default 10), `classes` (L3 high only; default 15), `probes` (INFRA; default 6), `openVerified` (verify; default 0); L3 low|medium|high = units × 5|10|classes × 2; the `note` states the numbers and that they are estimates; `route` also accepts a remote written `github.com:owner/repo` (scp form after stripping the user) — the page cannot know pack sizes at click time — cost: a rough estimate.
Ruling R29: route() also returns local whenever `system.host` is present (a host-backed system never goes to cloud, whatever its `executor` says) — spec §5.8 "Infra jobs never go to cloud" and Review Focus 5 outrank the brief's narrower formula — cost: none.
Task 5: review approved; controller pulls minors 1 (R29), 2, 4 into fix round 1 before Task 6 copies route()
Ruling R30: "requeue" on a stale (queued > 24 h) job re-opens the confirm sheet with a fresh cost and then updates the SAME job with new `confirmedAt`, `costShown`, `costEstimate`, `updatedAt` (status stays queued); the stale test uses `confirmedAt` — a requeue is a fresh confirmation, which spec §5.7 asks for — cost: none.
Ruling R31: live finding actions in this plan: "Verify still present" (type verify, local or cloud per route) is live; "Diagnose & fix" and "Apply reviewed patch" render disabled with the note "arrives with the fix flow (Plan 4)"; system layer buttons only for layers in data-engines; prompts: audit `/rampart audit <layer> --project <slug> --system <id> --job <jobId>`, verify `/rampart verify --project <slug> --finding <id> --job <jobId>`; source_url is `https://` + the remote with a scp `:` turned into `/` — Plan 4 owns fix/apply — cost: none.
Ruling R32: the page's copies of PAGE_FUNCTIONS are verified by a test comparing each function's source text in the page with jobs.cjs (whitespace-normalised), so they can never drift — cost: none.
Task 5: fix round 1/5 (3 addressed, 0 open — host routes local (R29), CLI --system required, strict toIsoTime; commits e7cdbdd..4d01b22)
Task 5: minor (deferred): isGithubRemote accepts any scheme (file://github.com/x)
Task 5: minor (deferred): completionPatch doesn't check the job's current status
Task 5: complete (commits 2c709a5..4d01b22, review clean)
Ruling R30a (amends R30): a requeue re-routes with Jobs.route on current data; the requeue patch also carries the fresh `executorKind`; cloud dispatch only when the fresh route says cloud; at confirm the page re-reads the job and refuses unless it is still `queued` — reviewer showed the stored route bypassed cloudAllowed/Focus 5 — cost: none.
Ruling R33: when a cloud dispatch fails (null mcp namespace or any create_session rejection), the page updates the job to `executorKind: 'local'` (+ updatedAt) so a local watch can run it; watch leaves `cloud`-kind jobs alone (a cloud session owns them); for `server_unavailable`/`upstream_error` the toast says a cloud session may have started (the CAS claim keeps a double run safe) — resolves the conflict between R11's "start /rampart watch" note and the plan's "watch leaves cloud jobs alone" — cost: a job that did start in cloud may also be claimed locally first; the loser sees `claimed`.
Task 6: review: 1 Important (requeue bypasses routing) + spec (route text) + minors folded into fix round 1
Task 6: fix round 1/5 (7 addressed, 0 open — requeue re-routes, local-only route text, re-read at confirm, R33 fallback, arg(), whitespace, tests; commits 7d2d24d..cf73a26)
Task 6: minor (deferred → folded into Task 7 dispatch): stale jobPlan comment at index.html:1681 ("A requeue keeps the job's own route")
Task 6: minor (deferred): requeue route computed at sheet open, not confirm; requeue update not version-pinned (narrow race)
Task 6: minor (deferred): ambiguous-outcome connector copy relies on CAS claim to make a double run safe
Task 6: complete (commits 4d01b22..cf73a26, review clean)
Ruling R34: exports use the downloads allowlist: `<slug>-findings.jsonl.txt` (JSONL content) and `<slug>-findings.sarif.json` — downloads.d.ts refuses .jsonl/.sarif; the content is what the spec asks for — cost: a renamed extension.
Ruling R35: the page carries the plugin version (e.g. `<main data-version>`), passed to toSarif as `toolVersion`, with a test that it equals .claude-plugin/plugin.json `version`; done at Task 11's version bump — cost: none.
Task 7: review approved (0 Critical/Important); controller pulled 7 minors (lost-update in settings save, host-backed cloud eligibility, etc.) into fix round 1
Ruling R36: watch runs only job types the page can queue in this plan — `audit` (a layer whose recipe section exists on this install; otherwise `failed` with "layer <L> is not available in this version") and `verify` (when jobs/verify.md exists; otherwise `failed` "verify is not available in this version"); any other type → `failed` "not runnable from the dashboard in this version"; `apply` and `cloud`-kind jobs are left untouched — inventory needs the person's answers and attestation, so it is never run unattended — cost: none.
Ruling R37: each recipe task adds its own front-desk row to SKILL.md (watch in Task 8, schedule in Task 10); Task 9 owns the description, allowed-tools and the "not in this version" line; edits stay minimal because Plan 2 touches the same file — cost: none.
Ruling R38: the executor id is the session id when the host exposes one (e.g. a session-info/get-session tool) and Remote Control is on; otherwise `local-<machineId>` with `remoteControl: false` (send_message cannot reach it; the queue still works); config.json `dashboard` fields (url, ownerId, publishedAt, pageHash, remoteControl, scheduleId) are written only through a store.cjs CLI command, never hand-edited — cost: no nudges without Remote Control.
Task 7: fix round 1/5 (7 addressed, 0 open — settings diff vs shown, host-backed eligibility, extension_not_enabled, refocus, tidy, tests; commits cd1df0a..9a4bbf9)
Task 7: complete (commits cf73a26..9a4bbf9, review clean)
Task 8: implemented (commits d080181..a73eb8c: 84e0e09, 4dfcdc8 WIP snapshots + a73eb8c marker; 741/742 tests, validate green); jobs.cjs gained start-patch, executor-doc, wrapper-aware --job; report at task-8-report.md (race-check steps for Task 11 inside)
HANDOFF (2026-10-23, Pedro moving machines): OPEN = Task 8, task review not yet run (fix round 0). NEXT ACTION: generate review package d080181..a73eb8c and dispatch the Task 8 task reviewer (Opus) with task-8-brief.md, task-8-report.md, context.md (R1, R7–R10, R13, R20, R33, R36–R38); then Tasks 9, 10, 11 per plan. Task 9 carries: SKILL.md allowed-tools (ArtifactData, ScheduleWakeup, session tools), drop `watch` from "not in this version", write dashboard.md "Sync" section (watch.md references it), publish records url/ownerId via `store.cjs dashboard-set`, versions-map builder after observing ArtifactData out_dir format, pull-then-push from ONE snapshot. Workspace files (briefs, reports, context.md, contracts) live in git-ignored .superpowers/sdd/2026-10-23-rampart-live-dashboard/ on the PC only; the ledger copy below is the portable record.
Resume (2026-10-26, new machine): workspace rebuilt from the git ledger/context; task-8-report.md reconstructed (original lost). Task 8 review dispatched over d080181..a73eb8c.
Task 8: review: spec ✅ (R8/R9/R33/R36/R38/R13 verified), 1 Important (step 6 gates ScheduleWakeup on an idle pass — breaks R10 continuous mode); minors 1-4 folded into fix round 1
Task 8: minor (deferred): recipes test subcommand/flag matching is loose (matches any string literal, not the USAGE block)
Task 8 → Task 9 carry: dashboard.md must have a section titled "Sync" (watch.md step 4.9 points at it) + recipes-test assertion; drop `watch` from SKILL.md "not in this version"; allowed-tools must keep Glob (watch.md "Glob it")
Task 8 ⚠️ → Task 11: ArtifactData query shape, out_dir wrapper and get_session fields are host-tool assumptions; re-derive the two-executor race check from watch.md
Task 8: fix round 1/5 (5 addressed, 0 open — schedule every pass (R10), verify/audit target texts, start-write recovery, strict if_version test; commits 388ad95..87ab011)
Task 8: minor (deferred): step 4.7/4.10 recovery get does not say which fields to read (terse, implied)
Task 8: complete (commits d080181..87ab011, review clean)
