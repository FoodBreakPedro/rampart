# Rampart Live Dashboard Implementation Plan (Plan 3 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/rampart dashboard` publishes a private claude.ai artifact whose database is the master record, whose tiles and buttons queue jobs as the owner, and whose jobs a local `/rampart watch` session (or a cloud session for cloud-allowed repo work) picks up and completes, syncing results back.

**Architecture:** `dashboard/index.html` gains a live mode behind `claude.use("db")` with incremental DOM updates; the store stays the cache and raw-output home; `scripts/sync-plan.cjs` turns store deltas into `ArtifactData` batch payloads and merges page-side changes back; the recipes (`jobs/dashboard.md`, `jobs/watch.md`, `jobs/schedule.md`) drive the Artifact and ArtifactData tools, which only Claude can call, so every DB write from the machine side is a recipe step over a script-built payload. Job routing: cloud via Claude Code Remote `create_session`, local via a job queue plus `send_message` nudge.

**Tech Stack:** Node ≥ 20 CommonJS (zero deps), vanilla JS page, claude.ai artifact capabilities `db`, `user`, `downloads`, `mcp` (load the `artifact-capabilities` skill and read its `db.d.ts`, `mcp.d.ts`, `user.d.ts` before any page code; load `artifact-design` before editing the page), Claude Code Remote connector tools, Claude Code hooks.

**Spec:** `docs/superpowers/specs/2026-10-23-rampart-design.md` §5.7 (views, DB layout, record of truth, confirmation and authority), §5.8 (executors), §5.9 (safety). **Plan 1:** `docs/superpowers/plans/2026-10-23-rampart-core.md`; `skills/rampart/specs/db-layout.md` carries the collection list and the carry-forwards.

## Global Constraints

- Zero npm dependencies; CommonJS; Node ≥ 20; the page stays one file with no external scripts; `npm test` and `npm run validate` green after every task; Plan 1's static mode keeps working unchanged (its tests are the proof).
- Record of truth: once `config.json` holds a dashboard URL, the DB is master for `findings`, `runs` (summaries), `dispositions`, `jobs`, `projects`; the local store is a cache plus raw output. Per document, last writer wins on `updatedAt`; a disposition made in the page (`by` is a user id) beats an automated status change (`by: 'rampart'`).
- Authority: DB rules give signed-in viewers read access and make `projects`, `findings` (dispositions live on the finding), `jobs` and `executors` **owner-only writes**; a button confirms a read-only job only after the page showed its cost; `apply` requires a second typed confirmation (field `applyConfirmation: {typed, at}`) and no executor runs it in this plan (fix/apply arrive in Plan 4: the button exists disabled with that note); executors run only jobs with `createdBy === owner id` and refuse the rest with `status 'failed', resultSummary 'not created by the owner'`.
- Routing: a job on a system with `executor: 'local'` (every host-backed system) never goes to cloud; `cloud` only when the project has `cloudAllowed: true` and the system is repo-backed with a `repo.remote` on github.com.
- Privacy: the page's data never contains `repo.paths`, `host.ssh` beyond its hostname, `live.url` query strings, `ownerAttestation`, raw tool output or any credential value; `buildData` strips them and a test proves it.
- No shell; every external call through `exec.run`; nothing private to the author in the repo.
- Commit after every task; conventional commits with the session's attribution trailer.

## Review Focus

1. **A viewer who is not the owner opens a shared dashboard**: can read, cannot queue a job or change a disposition; the page hides those controls when `user.can("data.write")` is false. Pinned in Task 4 (rules) and Task 6.
2. **Two executors online** (a laptop and the PC both running `watch`): a job is claimed exactly once. Pinned in Task 8 (claim is a conditional update on `status === 'queued'` with the claimant id; the loser sees `claimed`).
3. **The page opens with no DB** (artifact capabilities unavailable, signed out, or the static file): static mode renders; nothing throws; buttons fall back to copy-the-command. Pinned in Task 3.
4. **Conflicting dispositions**: the page marks a finding `accepted_risk` while a local scan marked it `regressed`; sync keeps the page's. Pinned in Task 2.
5. **A job for an infra system on a cloud-allowed project**: routes local, never `create_session`. Pinned in Task 6 and Task 8.

---

## File structure

```
skills/rampart/specs/job-schema.json (+ updatedAt, claimedAt, applyConfirmation, costEstimate)  finding-schema.json (+ updatedAt, disposition)  (Task 1)
skills/rampart/specs/db-layout.md (final)  db-rules.json  (Task 1)
scripts/render-static.cjs      # buildData strips private fields; buildPage(data) shared with live mode           (Task 2)
scripts/sync-plan.cjs          # store → batch payloads (push); page docs → store (pull); cursors in meta/sync    (Task 2)
scripts/jobs.cjs               # job ids, cost estimates, routing decision, claim/complete helpers (pure)         (Task 5)
dashboard/index.html           # live mode: data adapter, keyed incremental render, dispositions, jobs, settings, export  (Tasks 3, 4, 6, 7)
skills/rampart/jobs/dashboard.md (publish + sync)  watch.md  schedule.md  SKILL.md  role.md                     (Tasks 8, 9, 10)
hooks/hooks.json  hooks/session-start.cjs  hooks/post-push.cjs                                                 (Task 10)
tests/*.test.cjs  tests/fixtures/db/**                                                                          (every task)
```

---

### Task 1: Schemas and DB layout

**Files:** Modify `skills/rampart/specs/job-schema.json`, `finding-schema.json`, `run-schema.json`; create `skills/rampart/specs/db-rules.json`; rewrite `specs/db-layout.md` as the final layout; Test `tests/lib-validate.test.cjs` additions.

**Interfaces:**
- `finding` gains `updatedAt` (ISO) and `disposition: {status, reason, by, at} | null` (the page writes dispositions as a field; `dispositions.json` stays the local cache). `job` gains `updatedAt`, `claimedAt`, `costEstimate: {agents, note}`, `applyConfirmation: {typed, at} | null`, `executorKind: 'local'|'cloud'`, `sessionId?`. `run` gains `updatedAt`, `reportMd?` (summary runs carry the report text).
- `db-rules.json` (the exact value handed to the Artifact tool's `capabilities.db.rules`): `projects`, `findings`, `runs`, `jobs`, `executors`, `packs`, `meta` all `read: "view"`; `write: "owner"` for every collection (executors register as the owner's own sessions). Keep the whole dashboard owner-written; viewers are read-only.
- `db-layout.md`: collections `projects/<slug>` (inventory mirror without private fields + latest score), `findings/<id>`, `runs/<runId>`, `jobs/<id>`, `executors/<sessionId>` (`{kind: 'local'|'cloud', machineId, heartbeatAt, remoteControl: boolean}`), `packs/<name>`, `meta/sync` (`{[machineId]: {pushedAt, pulledAt, pushCursor, pullCursor}}`).

- [ ] Failing tests: a job with `applyConfirmation` validates; a finding with `disposition: null` validates; the rules file parses and names every collection with `write: "owner"`.
- [ ] Implement; commit `feat(specs): dashboard db layout, rules and schema fields`.

---

### Task 2: Private-field stripping and the sync planner

**Files:** Modify `scripts/render-static.cjs` (`buildData` → `buildPage`); create `scripts/sync-plan.cjs`; Test `tests/sync-plan.test.cjs`, `tests/render-static.test.cjs` additions.

**Interfaces:**
- `buildPage(now) → PageData`: as `buildData` but each project is `publicProject(project)` = project without `ownerAttestation`, with every system's `repo` reduced to `{remote, defaultBranch}`, `host` reduced to `{hostname}` (the part after `@`, port stripped), `live.url` reduced to origin + pathname; runs carry no `raw`; findings unchanged (already redacted). `renderStatic` uses `buildPage`.
- `planPush(slug, {since}) → {docs: [{collection, id, data}], cursor}`: every project, finding, run summary (with `reportMd` when `REPORT.md` exists), score, pack version whose `updatedAt`/`lastSeen`/`finishedAt` is after `since` (store records gain `updatedAt` stamped by `writeProject`, `upsertFindings`, `finishRun`); `data` carries `updatedAt`; the payload shape matches what the `ArtifactData` `batch` action takes (`[{action: 'set'|'update', collection, doc_id, data}]`, chunked at 100 docs).
- `applyPull(slug, docs) → {applied, skipped}`: given page-side documents (findings with `disposition`, jobs), apply the merge rule: a finding's `disposition` from the page with `by !== 'rampart'` wins over the local status (calls `setDisposition`), otherwise newer `updatedAt` wins; jobs are mirrored into `~/.rampart/jobs/<id>.json` for the watch loop.
- CLI `node scripts/sync-plan.cjs push --project <slug> [--since <iso>] --out <file.json>` and `pull --project <slug> --in <file.json>`; the recipes pass the files to/from `ArtifactData`.

- [ ] Failing tests: `buildPage` output contains no `paths`, `ssh` user, `?` in any url, or `ownerAttestation`; `planPush` after one upsert lists exactly the changed finding; `applyPull` with a page `accepted_risk` beats a local `regressed`; a page `by: 'rampart'` disposition does not beat a newer local one.
- [ ] Implement; commit `feat(sync): public page data and the sync planner`.

---

### Task 3: Live-mode data adapter and incremental rendering

**Files:** Modify `dashboard/index.html`; Test `tests/dashboard-live.test.cjs` (evaluates the page script with `vm` and a fake `window.claude.use` returning a stub `db` that replays fixture documents and `onSnapshot` events).

**Prerequisite:** load `artifact-capabilities` (read `db.d.ts`, `user.d.ts`) and `artifact-design`.

**Interfaces (page JS):**
- `loadData()` → tries `await claude.use("db")`; when `null` or when `#rampart-data` holds data (static file), returns the inline data (static mode) unchanged from Plan 1; when a DB is present, returns a live `DataSource` that subscribes once per collection (`projects`, `findings`, `runs`, `jobs`, `executors`, `meta`) with `onSnapshot` and exposes `current()` plus `onChange(fn)`.
- `render(data)` becomes keyed and incremental: tiles, score-sheet rows, findings rows and job rows are keyed by id and patched in place (text and class changes) instead of rebuilt; scroll position, focus and open `<details>` survive an update (test: a snapshot change for one finding leaves `document.activeElement` and an open details untouched).
- A `mode` badge in the header: `Static snapshot <generatedAt>` or `Live · synced <meta.sync time> · executor <online|offline>`.
- `user.can("data.write")` gates every write control; signed-out viewers see read-only.

- [ ] Failing tests with the stub DB: live mode renders the fixture tiles; an `onSnapshot` update changes one tile's score text without replacing the node; `use("db") → null` renders the inline data.
- [ ] Implement; commit `feat(dashboard): live data source and incremental rendering`.

---

### Task 4: Dispositions in the page

**Files:** Modify `dashboard/index.html`; Test additions.

**Interfaces:** each finding row gets a disposition control (`open`, `fixed`, `false_positive`, `accepted_risk`) with a required reason for the last two; on change the page `db.doc("findings/<id>").update({status, disposition: {status, reason, by: await user.id(), at}, updatedAt})`; a `not_granted`/write error shows a toast and reverts; the control is hidden when `user.can("data.write")` is false.

- [ ] Failing tests: a disposition change writes the exact document patch to the stub DB; a rejected write reverts the row; a read-only viewer sees no control.
- [ ] Implement; commit `feat(dashboard): dispositions`.

---

### Task 5: Jobs: ids, cost estimates and routing (pure logic)

**Files:** Create `scripts/jobs.cjs`; Test `tests/jobs.test.cjs`.

**Interfaces (shared by the page, embedded as the same functions in the page script, and by the recipes):**
- `newJobId(now) → 'job-<YYYYMMDD-HHmmss>-<4 hex>'`.
- `costEstimate({type, layer, system, units?}) → {agents, note}`: L1 = 0 agents, "scripts only, ~1 min"; L2 = `min(units, 10) × 5 classes × 2`; L3 by effort `low|medium|high` = `units × 5|10|all classes × ~2 verifiers`; INFRA = `probes + 2`; `verify` = `open verified findings`; `inventory` = 1.
- `route({project, system, type, layer}) → {executorKind: 'local'|'cloud', reason}`: `cloud` only when `project.cloudAllowed && system.repo?.remote matches /^github\.com\//i && system.executor !== 'local' && layer !== 'INFRA' && type !== 'apply'`; else `local`.
- `claimPatch(job, executorId, now) → {status: 'claimed', claimedBy, claimedAt, updatedAt}` and `completionPatch(job, {runId, status, resultSummary})`.

- [ ] Failing tests: routing table (infra on cloud-allowed project → local; repo on `cloudAllowed: false` → local; repo on github with cloud allowed → cloud); cost numbers for the stated inputs; ids sortable by time.
- [ ] Implement; commit `feat(jobs): ids, cost estimates and routing`.

---

### Task 6: Job buttons and live status in the page

**Files:** Modify `dashboard/index.html`; Test additions with a stub `mcp` namespace (`callTool` recorder).

**Prerequisite:** read `mcp.d.ts`; the page declares the connector `Claude Code Remote` with tools `create_session`, `send_message`, `get_session`, `list_sessions`, `list_environments`.

**Interfaces:**
- Each system card's layer buttons and each finding's actions become real in live mode: click → a confirm sheet showing the job type, scope, `costEstimate` and the route (`local executor <name|offline>` or `cloud session`) → on confirm the page writes `jobs/<id>` = `{id, type, project, system, layer, findingId?, params, executorKind, status: 'queued', createdBy: await user.id(), confirmedAt, costShown: estimate.note, costEstimate, updatedAt}` → then: `cloud` → `callTool("Claude Code Remote", "create_session", {title, prompt: "/rampart <type> <layer> --project <slug> --system <id> --job <jobId>", source_url: "https://<repo.remote>"})` and stores `sessionId` on the job; `local` → if an `executors/*` doc with `remoteControl: true` and a heartbeat under 5 minutes exists, `callTool("Claude Code Remote", "send_message", {session_id, message: "/rampart watch --claim <jobId>"})`, else the job waits and the tile says "queued · start `/rampart watch`".
- `apply` buttons render disabled with the note "arrives with the fix flow (Plan 4)".
- Job rows show live status from `jobs/<id>` (`queued`, `claimed by <executor>`, `running`, `done` with `resultSummary`, `failed`); a job older than 24 h still `queued` is shown stale with a "requeue" action.
- Static mode keeps the copy-the-command behaviour.

- [ ] Failing tests: confirm writes the exact job doc; cloud route calls `create_session` with the pinned prompt; local route with an online executor calls `send_message`; local route without one calls nothing and shows the queued note; an infra job on a cloud-allowed project never calls `create_session`.
- [ ] Implement; commit `feat(dashboard): job buttons, routing and live status`.

---

### Task 7: Settings view and export

**Files:** Modify `dashboard/index.html`; Test additions with a stub `downloads` namespace.

**Interfaces:** Settings (owner only): per project `cloudAllowed`, `defaultExecutor`, cadence overrides per system layer, the hunt effort default, written to `projects/<slug>` with `updatedAt` (the watch loop's pull applies them to `project.json`); Export: "Download findings" → `downloads.save({filename: '<slug>-findings.jsonl', data})` and SARIF 2.1.0 (`toSarif(findings) → object` embedded in the page: one `result` per open finding with `ruleId`, `level` from severity, `locations` from the Rampart location, `properties` carrying class/status/id; one `rule` per distinct `ruleId`).

- [ ] Failing tests: `toSarif` output has `version: "2.1.0"`, one result per open finding, no `evidence` text; the settings write patches only the changed keys; the controls are absent for non-owners.
- [ ] Implement; commit `feat(dashboard): settings and export`.

---

### Task 8: Watch loop and executor registration

**Files:** Modify `scripts/store.cjs` (+ `readJobs(slug?)`, `writeJob(job)`, `readConfig().dashboard`), create `skills/rampart/jobs/watch.md`; Test `tests/store.test.cjs` additions, `tests/recipes.test.cjs` (static checks on the recipe text: every CLI flag exists; no bare `git`).

**Recipe (Opus implementer):** `/rampart watch [--claim <jobId>] [--once]`:
1. Require a dashboard URL in `config.json` (else say `/rampart dashboard` first). Register `executors/<sessionId>` with `{kind: 'local', machineId, heartbeatAt: now, remoteControl}` through `ArtifactData set` (the session id from the session's own tools when available; otherwise a `machineId`-based id). Enable Remote Control when the host offers `mcp__ccd_session_mgmt__set_remote_control` and the user allows it once (AskUserQuestion), recording the answer in `config.json`.
2. Loop: `ArtifactData query jobs where status == queued` → for each job in creation order whose `executorKind === 'local'` and `createdBy` equals the owner id stored in `config.json` at publish time: `ArtifactData update jobs/<id>` with `claimPatch` **only if** a fresh `get` still shows `queued` (the claim is the conditional step; on a lost race, skip) → run the job's recipe (`audit`, `verify`, `inventory`) with its args → `sync-plan.cjs push` → `ArtifactData batch` → `completionPatch` on the job. A `cloud`-kind or `apply` job is left alone. A job not created by the owner → `failed` with the fixed `resultSummary`.
3. Idle: refresh the heartbeat and wait with the session's wakeup scheduling at 120 s (`ScheduleWakeup`), noop when nothing changed; `--once` processes the queue and exits; a `--claim <id>` from `send_message` handles that job first.
4. Every write to the DB goes through a script-built payload file (`sync-plan.cjs push … --out`), never hand-typed JSON, except the three job patches whose shape `jobs.cjs` prints (`node scripts/jobs.cjs claim-patch|completion-patch … --json`).

- [ ] Tests: store job helpers round-trip; recipe static checks pass; a documented manual two-executor race check in Task 11.
- [ ] Write; commit `feat(skill): watch executor loop`.

---

### Task 9: Publish and sync recipe

**Files:** Modify `skills/rampart/jobs/dashboard.md`, `skills/rampart/SKILL.md` (description; `allowed-tools` adds `Artifact`, `ArtifactData`, `ScheduleWakeup`, `Agent(rampart:explore)` unchanged), `role.md` (record-of-truth and authority rules in agent-facing words).

**Recipe (Opus implementer):** `/rampart dashboard [--static] [--sync]`:
- `--static` unchanged. Default: if `config.json` has no `dashboard.url`: load `artifact-design` and `artifact-capabilities`, publish `dashboard/index.html` with the Artifact tool using `capabilities: {db: {rules: <db-rules.json>}, user: {}, downloads: true, mcp: {servers: [{server: "Claude Code Remote", tools: [create_session, send_message, get_session, list_sessions, list_environments]}]}}`, `icon: "shield"`, title `Rampart Dashboard`; save `{url, ownerId (from a first ArtifactData read of meta or the user id the recipe records), publishedAt}` to `config.json`; then run the verification rule from `artifact-capabilities` (one `ArtifactData list` per collection, and a `view`-level read of `jobs` that must be empty of writes). If the URL exists: republish only when `dashboard/index.html` changed since `publishedAt` (compare a hash stored in `config.json`), then `sync-plan.cjs push` for every project → `ArtifactData batch` in chunks → `ArtifactData query` for findings with a page disposition and for jobs → `sync-plan.cjs pull` → `meta/sync` update. `--sync` does only the sync. Every other job (audit, verify, inventory) ends with the sync step when a dashboard URL exists (one line added to those recipes).
- The recipe says what it exercised and what it could not in one line, per the capabilities skill.

- [ ] Write; `claude plugin validate . --strict`; commit `feat(skill): publish and sync the live dashboard`.

---

### Task 10: Schedule recipe and hooks

**Files:** Create `skills/rampart/jobs/schedule.md`, `hooks/hooks.json`, `hooks/session-start.cjs`, `hooks/post-push.cjs`; Test `tests/hooks.test.cjs` (run each hook script with a sample stdin event and assert the JSON it prints; the SessionStart hook finishes in under 2 s and never fails the session).

**Interfaces:**
- `schedule.md`: `/rampart schedule [--weekly | --off]`: create a weekly job that runs `/rampart dashboard --sync` then, for each project, `audit L1` on systems whose L1 is overdue, with whatever scheduler the host offers (`mcp__scheduled-tasks__create_scheduled_task`, else `CronCreate`, else print the `claude -p` cron line); record the id in `config.json`; `--off` removes it.
- `hooks.json`: `SessionStart` → `hooks/session-start.cjs` (prints a one-line additionalContext when `doctor.cjs --json` shows a missing tool that a stored project needs, cached per day in `~/.rampart/cache/doctor.json`; silent otherwise); `PostToolUse` on `Bash` matching `git push` → `hooks/post-push.cjs` suggests `/rampart audit L2 --project <slug>` once per session when the cwd is a known repo path of a stored project (reads `project.json` paths for this machineId; no network).

- [ ] Failing tests: hook outputs for the fixture events; the push hook is silent for an unknown repo and for a second push in the same session (state file under `~/.rampart/cache/`).
- [ ] Implement; `claude plugin validate . --strict`; commit `feat(skill): schedule job and hooks`.

---

### Task 11: Acceptance and release

- [ ] `npm test`, `npm run validate` green; `claude plugin validate . --strict`.
- [ ] Acceptance on this machine with a temp `RAMPART_HOME` and fixture projects only: `/rampart dashboard` publishes once (record the URL in the report; the page must not show any private field); the capabilities verification reads pass; `/rampart audit L1` syncs findings into the DB; in the page, set one disposition and queue one L1 job (local route); run `/rampart watch --once` in a second session: the job is claimed once, runs, completes, and the page shows `done` with the summary; queue a second job and start two `watch --once` sessions at the same time: exactly one claims it; export SARIF downloads; a signed-out or viewer-level read shows no write controls (use the `as_level` read per the capabilities skill). Record misleading recipe wording and fix it.
- [ ] CHANGELOG (new capabilities; known limitations: no apply yet, cloud route needs a GitHub remote, Remote Control optional); bump both manifests; `claude plugin tag .`; draft PR to `main`.
