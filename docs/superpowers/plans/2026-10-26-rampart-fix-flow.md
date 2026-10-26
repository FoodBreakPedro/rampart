# Rampart Fix Flow, Evals and rampart-lite Implementation Plan (Plan 4 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/rampart fix` diagnoses one finding and delivers an independently reviewed patch (code) or change plan (infra); `/rampart apply` puts a reviewed patch on a new local branch after a typed confirmation; the dashboard's "Diagnose & fix" and "Apply reviewed patch" buttons work; repo jobs can run in a cloud session; `/rampart evals` measures recall and noise against planted-flaw fixtures; `rampart-lite` ships as a portable skill whose reports import into the record.

**Architecture:** The fix flow reuses the hunt engine's shape: deterministic work in zero-dependency scripts (`scripts/fix-io.cjs` owns the scratch worktree, the diff capture, the review tally and the finding's `fix` record; `scripts/apply.cjs` owns every write to a repository), model work in two agents (`fixer`, `patch-reviewer`) dispatched by the `fix` recipe with the Agent tool in a loop of at most three rounds, with a script step between agents (diff capture, tests, tally); unlike a hunt, a fix needs at most nine agents and needs scripts between them, which a Workflow script cannot run. Evals run the existing audit pipeline on fixture projects in a throwaway store and score the run's `findings.json` (`verified`, `rejected`, `undecided`, R51) with `scripts/evals.cjs`. `rampart-lite` is a standalone skill directory whose condensed packs are generated from `packs/` and checked for drift by a test.

**Tech Stack:** Node ≥ 20 CommonJS `.cjs` (zero npm deps, `node:test`), git worktrees, `claude plugin eval` (case dirs with `prompt.md` + `graders/*.md`), claude.ai artifact capabilities (load `artifact-capabilities` and `artifact-design` before page work), Claude Code Remote connector for the cloud route.

**Spec:** `docs/superpowers/specs/2026-10-23-rampart-design.md` (§2 goals 6, 7, 9; §5.5 `fix`, `apply`, `evals`, `import`; §5.7 confirmation and authority; §5.8 executors; §5.9 never auto-apply; §5.10 eval loop; §5.11 `rampart-lite`; §8 eval fixtures). **Earlier plans:** `2026-10-23-rampart-core.md`, `…-hunt-engine.md`, `…-live-dashboard.md`; their ledgers under `docs/superpowers/handoff/` carry the rulings cited here as P2-Rn and P3-Rn.

## Global Constraints

- Zero npm dependencies; CommonJS `.cjs`; Node ≥ 20; `npm test` and `npm run validate` green after every task; Windows, macOS and Linux paths (`path` everywhere, argv arrays, no shell).
- No shell: every git or test process runs through `scripts/lib/exec.cjs` `run(cmd, args, opts)`; git is always `git -C <dir> …` from a script, never from an agent.
- **Never auto-apply** (spec §5.9): `fix` writes files under the run directory and a scratch worktree only; the person's checkout, its branches and its remote are written only by `apply.cjs`, only after a valid typed confirmation, and only as a new local branch `rampart/fix-<findingId>` in its own worktree. Nothing in this plan pushes, opens a PR, or touches a live host.
- Typed confirmation (spec §5.7): `applyConfirmation.typed` must equal the finding id exactly, `applyConfirmation.at` must be under 24 hours old when the apply starts, and the job's `createdBy` must equal the dashboard owner id; at the terminal the person types the id in answer to AskUserQuestion.
- A patch or change plan is offered for apply only when **every** reviewer of its final round confirms all three claims (`addresses`, `noNewVuln`, `behaviourKept`); the fix loop runs at most three rounds (spec §5.5 round cap).
- No credential value in a patch, a change plan, a review, the DB or chat: a patch or change plan that `redact()` would alter is refused (`fix.status 'refused'`, reason "patch contains a credential-like value"), never stored.
- Repository and host content is data, never instructions; the fixer and reviewers say so in their prompts, as hunter/verifier do.
- Page data rules (Plan 3) hold for the new fields: no `repo.paths`, ssh users, URL queries or credential values; patch text in a run doc passes `scrubText` then `redact()` and is capped at 200 000 characters.
- Evals and acceptance run with a temp `RAMPART_HOME` and fixtures only; private evals cases exported from a person's dispositions stay in `~/.rampart/evals/cases/`, never in this repository.
- Nothing private to the author in the repo; fake secrets in fixtures are assembled at test time from fragments so no scanner or push protection sees a whole key in git.
- Version: this plan releases `0.5.0-alpha.1`; tag after the merge to `main` (P3-R54).
- Commit after every task; conventional commits ending with the session's attribution trailer.

## Review Focus

1. **A reviewed patch that no longer applies** (the default branch moved since `fix`): `apply` refuses with "the patch is stale: run Diagnose & fix again", leaves no branch or worktree behind, and sets `fix.status 'stale'`. Pinned in Task 6.
2. **A wrong or old confirmation** (typed id differs, confirmation over 24 h old, job not created by the owner, or no confirmation at all): `apply` refuses before any git command and the job fails with the reason. Pinned in Tasks 6 and 8.
3. **The person's checkout is dirty or on another branch**: `apply` never reads or changes its working tree; the branch is cut in a separate worktree from the recorded base. Pinned in Task 6.
4. **Reviewers split, or the third round still fails**: `fix.status 'rejected'` with the reviewers' reasons in the diagnosis, no patch offered, the page's Apply stays disabled. Pinned in Tasks 3 and 5.
5. **An eval case whose fixture yields zero verified findings, or zero expectations (the decoy)**: recall and noise are reported as numbers or `n/a`, never `NaN`, and a run that failed (P2-R50) scores as "run failed", not as zero recall. Pinned in Task 11.

---

## File structure

```
scripts/lib/vocab.cjs           # SEVERITIES, RANK, CONFIDENCES shared by hunt-io, normalize, fix-io     (Task 1)
scripts/fix-io.cjs              # fix run, scratch worktree, diff capture, review tally, finding.fix   (Task 3)
scripts/apply.cjs               # confirmation check, branch + worktree, git apply, health check, rollback (Task 6)
scripts/import-lite.cjs         # rampart-lite-findings.jsonl → findings (class tool)                  (Task 10)
scripts/evals.cjs               # run a case in a temp store, score findings.json, export cases        (Task 11)
scripts/packs.cjs               # + condense                                                           (Task 9)
skills/rampart/specs/review-schema.json  change-plan.md  finding-schema.json (+fix)  project-schema.json (+testCommand)  eval-case-schema.json
agents/fixer.md  agents/patch-reviewer.md                                                              (Task 4)
skills/rampart/jobs/fix.md  apply.md  import.md  evals.md  watch.md  SKILL.md  role.md                 (Tasks 5, 6, 8, 10, 12)
dashboard/index.html  scripts/jobs.cjs  scripts/sync-plan.cjs  scripts/render-static.cjs               (Tasks 2, 7, 8)
skills/rampart-lite/SKILL.md  references/{method.md,packs-condensed.md,finding-schema.json,report-template.md}  (Task 9)
evals/README.md  evals/cases/*.json  evals/fixtures/**  evals/skill/<case>/{prompt.md,graders/*.md}    (Tasks 11, 12)
tests/*.test.cjs  tests/fixtures/{fix,lite,evals}/**                                                   (every task)
```

Run directory additions for a `fix` run (`~/.rampart/projects/<slug>/runs/<runId>/`): `workspace/` (scratch worktree, removed at finalize), `fixer-<round>.md`, `diff-<round>.patch`, `tests-<round>.json`, `reviews/<round>__<n>.json`, `patches/F-<findingId>.patch` or `changes/F-<findingId>.md`, `DIAGNOSIS.md`, `fix.json` (`{findingId, kind, rounds, status, base, patchSha256?}`).

---

### Task 1: Hunt-engine carry-overs

Deferred minors from the Plan 2 ledger that bite a person or that later tasks build on (see Appendix A).

**Files:** Create `scripts/lib/vocab.cjs`; Modify `workflows/audit.js`, `scripts/diff-scope.cjs`, `scripts/hunt-io.cjs`, `scripts/normalize.cjs`, `scripts/coverage.cjs`, `packs/docker-host.md`, `packs/wordpress-hostinger.md`, `CHANGELOG.md` (limitation lines removed when fixed); Test `tests/workflow-audit.test.cjs`, `tests/diff-scope.test.cjs`, `tests/hunt-io.test.cjs`, `tests/coverage.test.cjs`, `tests/packs.test.cjs`.

**Interfaces:**
- `vocab.cjs` exports `SEVERITIES = ['CRITICAL','HIGH','MEDIUM','LOW']`, `RANK` (severity → 0..3), `CONFIDENCES = ['HIGH','MEDIUM','LOW']`, `minSeverity(a, b)`; hunt-io and normalize import them instead of their own copies (P2 final M3).
- `workflows/audit.js`: `args.runDir` is accepted when it is absolute on POSIX (`/…`) **or** Windows (`C:\…`, `C:/…`, `\\server\…`); output paths join with the separator the runDir uses (P2 final M4).
- `diff-scope.cjs`: a hunk content line that starts with `+++ ` or `--- ` inside a hunk is content, not a header (track whether we are inside a hunk by the `@@` counts) (P2 T5 minor).
- `hunt-io.cjs` ingest: a code candidate whose `location.path` is not inside its hunter's unit (`unitContains`) is invalid with reason "location outside the hunted unit" and counts toward the unit's `invalid` (P2 T6 minor; R26 then keeps that unit out of closeMissing).
- Coverage ledger entries record hunted classes as `<pack>/<classId>` (old bare ids read as matching any pack, so existing ledgers stay valid) (P2 final minor).
- Packs: `okExit: 0,1` on docker-host `daemon-config`, `trivy-present`, `auto-upgrades-config` and wordpress-hostinger `file-modes`, each only where its `expect` line says an empty or absent answer is healthy; versions bump to `1.0.1` (P2 final parked).

- [ ] Failing tests: `audit.js` static test accepts `C:\\Users\\x\\.rampart\\…` and writes `…\\candidates\\…`; a diff whose added line reads `+++ b` keeps the next hunk; a candidate at `lib/db.ts` from hunter of unit `app/api/users` is invalid; `gaps()` with two packs sharing class id `misconfig` reports the second pack's class as a gap; the four probes carry `okExit` and validate.
- [ ] Implement; run `npm test`; commit `fix(hunt): carry-overs from the hunt-engine ledger`.

---

### Task 2: Store and page carry-overs

**Files:** Modify `scripts/store.cjs`, `scripts/render-static.cjs`, `scripts/jobs.cjs`, `dashboard/index.html` (the mirrored `jobs.cjs` functions, P3-R32); Test `tests/store.test.cjs`, `tests/render-static.test.cjs`, `tests/jobs.test.cjs`.

**Interfaces:**
- `store.cjs` `withLock(slug, fn)`: an exclusive lockfile `<projectDir>/.lock` created with `fs.openSync(…, 'wx')`, retried every 50 ms up to 5 s, stale after 60 s (mtime), removed in `finally`; `upsertFindings`, `setDisposition`, `annotateFinding`, `closeMissing`, `writeCoverage` and the new `setFix` (Task 3) run inside it (P1 T5 "no lock on read-modify-write" — a watch loop applying a fix while the terminal syncs).
- `publicFinding` also reduces `location.host` to a bare hostname with `hostnameOf` (P3 T2 ⚠️, never closed at the Plan 2 merge).
- `jobs.cjs`: `completionPatch` throws `RangeError('job is not running')` unless the job's status is `claimed` or `running` (P3 T5 minor); `isGithubRemote` accepts only `https://github.com/`, `git@github.com:`, `ssh://git@github.com/` and bare `github.com/` forms (P3 T5 minor; matters once Task 8 opens the cloud route).

- [ ] Failing tests: two concurrent `upsertFindings` from child processes keep both findings; a stale lock is taken over; `buildPage` turns `location.host: '<ssh-user>@192.0.2.10:22'` into `192.0.2.10`; `completionPatch` on a `queued` job throws; `file://github.com/x` is not a GitHub remote; the page/script function-text equality test still passes.
- [ ] Implement; commit `fix(store): locking, host scrub, job guards`.

---

### Task 3: Fix runs, worktree and review tally

**Files:** Create `scripts/fix-io.cjs`, `skills/rampart/specs/review-schema.json`, `skills/rampart/specs/change-plan.md`; Modify `skills/rampart/specs/finding-schema.json` (+ `fix`), `project-schema.json` (+ `testCommand`), `run-schema.json` (job `fix`, counts `rounds`), `scripts/store.cjs` (+ `setFix`); Test `tests/fix-io.test.cjs` (temp git repos built in the test), fixtures `tests/fixtures/fix/{reviews,changes}/*`.

**Interfaces:**
- Finding gains optional `fix: {runId, kind: 'patch'|'change-plan', status: 'drafting'|'reviewed'|'rejected'|'refused'|'failed'|'stale'|'applied', rounds, base, patchSha256?, branch?, reason?, at}`; `store.setFix(slug, findingId, fix)` writes it (under the lock) and stamps `updatedAt` so `planPush` carries it.
- System gains optional `testCommand: string[]` (argv, owner-attested at inventory; never derived from repo content). `fix-io` runs it with `exec.run(argv[0], argv.slice(1), {cwd, timeoutMs: 600000})` and records `{ok, exitCode, durationMs}` plus the last 4 000 characters of output, redacted.
- `initFix({project, findingId, now}) → {runId, runDir, kind, workspace?, base?}`: refuses (exit 2) a finding that is not `open`/`regressed` or not class `verified`; code findings (`location.path`) → `kind 'patch'`, base = `git -C <repo> rev-parse origin/<defaultBranch>` falling back to the local branch, `git worktree add --detach <runDir>/workspace <base>`; host findings → `kind 'change-plan'`, no workspace; writes `fix.json`, sets `fix.status 'drafting'`.
- Review (agent-written, `reviews/<round>__<n>.json`): `{round, reviewer, claims: {addresses: 'yes'|'no', noNewVuln: 'yes'|'no', behaviourKept: 'yes'|'no'|'unknown'}, reasons: string[], testsRun?: boolean}`; `behaviourKept 'unknown'` counts as not confirmed.
- `tallyReviews(reviews, round, tests?) → {accepted: boolean, reasons: string[]}`: accepted iff the round has ≥ 2 reviews, every review says `yes` to all three claims, and the round's tests did not fail (`tests.ran && !tests.ok` → not accepted, reason "tests fail with the patch").
- `finalize({project, runId}) → {status, patchPath?, changePath?}`: for a patch, `git -C <workspace> diff --binary <base>` → refuse when empty ("the fixer changed nothing") or when `redact(diff) !== diff`; otherwise write `patches/F-<id>.patch`, its sha256 into `fix.json` and the finding; for a change plan, validate `changes/F-<id>.md` against `change-plan.md` (H2 sections `Diagnosis`, `Commands`, `Rollback`, `Health check`, each non-empty; same redact refusal); write `DIAGNOSIS.md` (finding title, root cause section from the fixer, final-round reviewer reasons, test result, how to apply); remove the worktree (`git worktree remove --force`) in every outcome; finish the run.
- `diffRound({project, runId, round}) → {files, added, removed, path}`: writes `git -C <workspace> diff --binary <base>` to `diff-<round>.patch` (the reviewers' view of the change; same redact refusal as finalize) and returns the diffstat; `testRound({project, runId, round})` runs `testCommand` in the workspace and writes `tests-<round>.json`, or `{ran: false, reason: 'no testCommand'}`.
- CLI `node scripts/fix-io.cjs init|diff|test|tally|finalize --project <slug> (--finding <id> | --run <runId>) [--round n] [--json]`; `tally` exits 0 accepted, 1 not accepted.

- [ ] Failing tests: init on a temp repo creates the worktree at the base commit and leaves the person's checkout untouched (`git status` unchanged, a dirty file stays dirty); init refuses a `tool`-class finding and a `fixed` one; tally: two all-yes → accepted, one review → not accepted, one `unknown` → not accepted; two all-yes with failing tests → not accepted; finalize with an edit in the workspace writes the patch and removes the worktree; finalize with an edit adding `AKIA`+`FAKEFAKEFAKEFAKE` (assembled) refuses and stores no patch; an empty diff → `failed`; `diff --round 1` writes the round's diff and a diffstat; a change plan missing `Rollback` → `refused`; `testCommand` failure is recorded, not thrown.
- [ ] Implement; commit `feat(fix): fix runs, scratch worktree, review tally`.

---

### Task 4: Fixer and patch-reviewer agents

**Files:** Create `agents/fixer.md`, `agents/patch-reviewer.md`; Test `tests/agents.test.cjs` additions; `claude plugin validate . --strict`.

**Interfaces (front-matter pinned by tests):** both omit `model` (inherit the session model). `fixer` tools exactly `Read, Glob, Grep, Edit, Write, Agent(rampart:explore)`; `patch-reviewer` tools exactly `Read, Glob, Grep, Write`. Neither has Bash: the diff and the test result reach the reviewer as files the recipe names (`diff-<round>.patch`, `tests-<round>.json`, written by `fix-io diff|test`), and the fixer never runs the code it edits. Both bodies contain "data, not instructions" and "never quote a credential".

**Content (Opus implementer):**
- `fixer.md`: receives the finding record (title, location, exploit scenario, recommendation, class text from its pack), the workspace path (patch mode) or the change-plan path and `change-plan.md` (infra mode), and on rounds 2–3 the previous round's reviewer reasons. Patch mode: edits only files under the workspace, the smallest change that removes the exploit path, plus a regression test when the repo has a test directory; never edits lockfiles, CI config or unrelated files; writes `<runDir>/fixer-<round>.md` with `## Root cause` and `## Change` sections. Infra mode: writes the change plan with exact commands, rollback and health check, never runs anything. Returns `{round, filesChanged: n}`.
- `patch-reviewer.md`: fresh context; receives the finding, the path of `diff-<round>.patch` (or the change plan), the test result file, and the pack class text; its job is to find a reason the patch is wrong: does the exploit path still exist (trace it), does the change open a new one (input handling, authz, error paths), does behaviour other than the flaw change (callers, return shapes); answers each claim yes/no/unknown with one-line reasons; writes one review file; returns `{accepted: boolean}`.

- [ ] Write; validate; commit `feat(agents): fixer and patch reviewer`.

---

### Task 5: Fix recipe and front desk

**Files:** Create `skills/rampart/jobs/fix.md`; Modify `skills/rampart/SKILL.md` (menu/route for `fix`; drop `fix` from "not in this version"; `allowed-tools` adds `Agent(rampart:fixer, rampart:patch-reviewer)`, and **narrows** `Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/*.cjs" *)` to one rule per named script, P2 T14 minor), `role.md` (fix rules: never apply, unanimous review, round cap); Test `tests/recipes.test.cjs` (every CLI verb/flag in `fix.md` exists; no bare `git`; the allowed-tools list names each script once and contains no `*.cjs` wildcard).

**Recipe (Opus implementer):** `/rampart fix --project <slug> --finding <id> [--job <id>]`: gates (attestation, finding exists and is open/regressed `verified`; INFRA findings allowed, they produce a change plan); cost once (fixer + 2 reviewers × up to 3 rounds = up to 9 agents) unless a job carries the confirmation; `fix-io init` → for `round` 1..3: dispatch `fixer` (Agent, foreground) with the finding, class text, workspace or change-plan path and, after round 1, the previous round's review paths → `fix-io diff --round` (patch mode; stop with `failed` on an empty diff or a credential refusal) → `fix-io test --round` → dispatch two `patch-reviewer`s in parallel (Agent, foreground, fresh each round) with the diff, test and class paths → `fix-io tally --round`; stop on accepted; a failing test makes a round not accepted whatever the reviewers say (the tally reads `tests-<round>.json`) → `fix-io finalize` → `render-static` → dashboard sync line. The summary names the finding id, status, rounds, the patch or change-plan path and, when reviewed, the exact `/rampart apply --project <slug> --finding <id>` command. It never prints the diff into chat beyond the file list and line counts.

- [ ] Failing recipe test: `fix.md` caps the loop at three rounds, dispatches a fresh reviewer pair per round, and never calls `apply.cjs`.
- [ ] Write; validate; tests; commit `feat(skill): fix job`.

---

### Task 6: Apply

**Files:** Create `scripts/apply.cjs`, `skills/rampart/jobs/apply.md`; Modify `SKILL.md` (route `apply`; drop it from "not in this version"), `role.md`; Test `tests/apply.test.cjs` (temp repos), `tests/recipes.test.cjs`.

**Interfaces:**
- `checkConfirmation({findingId, confirmation, job?, ownerId?, now}) → {ok, reason?}`: `ok` iff `confirmation.typed === findingId`, `now - confirmation.at < 24 h`, and (when a job is given) `job.type === 'apply' && job.findingId === findingId && job.createdBy === ownerId`.
- `applyPatch({project, findingId, confirmation, job?, ownerId?, now}) → {status: 'applied'|'refused'|'stale'|'failed', branch?, reason?}`, in order: confirmation check → finding `fix.status === 'reviewed'` and `kind 'patch'` (a change plan → `refused` "infra changes are applied by hand from the change plan; Rampart does not change hosts") → patch file sha256 equals `fix.patchSha256` → branch `rampart/fix-<findingId>` must not exist → `git worktree add -b <branch> <tmp> <base-now>` where `base-now` is `origin/<defaultBranch>` (else local) → `git apply --check` (fail → remove worktree and branch, `stale`) → `git apply --index` → `git commit -m "fix(rampart): <finding title> (<findingId>)"` with `-c user.name/user.email` left to the repo's config → health check `testCommand` when declared (fail → remove worktree, delete branch, `failed` "tests fail on the applied branch") → remove the worktree, keep the branch → `setFix(... status 'applied', branch)`; the finding stays `open` until a verify run on the default branch closes it.
- CLI `node scripts/apply.cjs --project <slug> --finding <id> --typed <id> --at <iso> [--job <file>] [--json]`.
- Recipe `/rampart apply --project <slug> --finding <id> [--job <id>]`: at the terminal shows the diagnosis summary and diffstat, then AskUserQuestion asking the person to type the finding id (free text), passes the typed text and now; from a job, takes `applyConfirmation` from the job doc. The summary says the branch name, that nothing was pushed, and the commands to review, merge or delete it.

- [ ] Failing tests: wrong typed id, 25-hour-old confirmation, job by another user, missing confirmation → `refused` and `git branch` unchanged; a dirty checkout keeps its dirty file and current branch after a successful apply; a patch whose context changed on the default branch → `stale`, no branch, no worktree; a tampered patch file (sha mismatch) → `refused`; an existing `rampart/fix-<id>` branch → `refused`; failing `testCommand` → `failed`, branch deleted; success → branch has one commit with the patch and the finding's `fix.status` is `applied`.
- [ ] Implement; write the recipe; commit `feat(apply): reviewed patches onto a local branch`.

---

### Task 7: Dashboard: Diagnose & fix, Apply reviewed patch

**Files:** Modify `dashboard/index.html`, `scripts/jobs.cjs` (+ mirrored functions), `scripts/sync-plan.cjs`, `scripts/render-static.cjs`; Test `tests/dashboard-live.test.cjs`, `tests/sync-plan.test.cjs`, `tests/jobs.test.cjs`.

**Prerequisite:** load `artifact-capabilities` (re-read `db.d.ts`) and `artifact-design`.

**Interfaces:**
- `costEstimate({type: 'fix'})` → `{agents: 9, note: 'fix: a fixer and 2 reviewers, up to 3 rounds (estimate)'}`; `apply` stays 0 agents.
- `planPush` carries `finding.fix` and, for a fix run, `runs/<runId>.fixDiagnosis` (DIAGNOSIS.md) and `.patchText` (patch or change plan), each through `scrubText` then `redact()`, capped at 200 000 characters with a "(truncated)" line (P3 final minor: free text path-scrubbed).
- "Diagnose & fix" (live, owner, finding active and class `verified`): the confirm sheet as for verify with the fix cost → job `{type: 'fix', findingId, …}`; disabled with a note when `fix.status` is `drafting` ("a fix is being drafted").
- "Apply reviewed patch" enabled only when `fix.status === 'reviewed' && fix.kind === 'patch'`; its sheet shows the diagnosis and the patch text (monospace, scrollable, from the run doc), the branch it will create, "nothing is pushed", and a text field "Type the finding id <id> to confirm"; the confirm button stays disabled until the field equals the id; the job doc carries `applyConfirmation: {typed, at}`; for `change-plan` the button reads "Apply by hand" and opens the change plan read-only.
- The finding row shows the fix status (`Fix drafting`, `Patch reviewed`, `Patch rejected: <first reason>`, `Applied on <branch>`, `Stale`).
- Static mode: both buttons copy `/rampart fix …` / `/rampart apply …`.

- [ ] Failing tests with the stub DB: fix confirm writes the exact job doc; apply confirm is disabled until the typed id matches and writes `applyConfirmation`; Apply is absent for a `rejected` fix and for a non-owner; the patch text in page data has no repo path and no `?query`; static mode copies the commands.
- [ ] Implement; commit `feat(dashboard): diagnose and fix, apply reviewed patch`.

---

### Task 8: Executors: fix and apply jobs, and the cloud route

**Files:** Modify `skills/rampart/jobs/watch.md`, `jobs/audit.md`, `jobs/verify.md`, `jobs/fix.md`, `scripts/jobs.cjs` (`CLOUD_RUNS`), `dashboard/index.html` (mirror), `CHANGELOG.md`; Test `tests/recipes.test.cjs`, `tests/jobs.test.cjs`.

**Interfaces:**
- `watch.md` runs `fix` jobs like `verify`; runs `apply` jobs only after `apply.cjs`'s confirmation check passes with the job and `config.json` `dashboard.ownerId` (P3-R36 amended: apply no longer left alone); a refused apply fails with the refusal reason.
- **Cloud executor.** A cloud session started by the page with `/rampart <type> … --job <id>` has no `~/.rampart`: the recipes' `--job` path, when `CLAUDE_CODE_REMOTE` is set, bootstraps a temp store from the DB (`ArtifactData get projects/<slug>`, findings of the system, the job) via a new `sync-plan.cjs seed --in <dir>` verb, runs the job against the session's checkout (its `repo.paths` entry is the session cwd for this run only, never pushed), pushes results, and completes the job. Cloud-runnable types: `audit` L2/L3, `verify`, `fix` (drafting only). Never `apply`, never INFRA (already gated in `infra-probe.cjs`, P2-R44). L2/L3/fix recipes refuse a cloud run when `project.cloudAllowed` is not true (P2 T13 minor, spec §5.8).
- **Gate:** first exercise the Claude Code Remote connector (`list_environments`, then one `create_session` against a fixture repo) and record its real argument names; only when a cloud session completes one fixture `audit L2` job end to end set `CLOUD_RUNS = true` (both copies). If either step cannot be exercised, keep `false`, record why in the ledger and CHANGELOG, and ship the rest of this task.

- [ ] Tests: recipe static checks (apply in watch calls `apply.cjs` with `--job`; cloud branch refuses `apply`/INFRA and `cloudAllowed: false`); `seed` builds a store whose project validates and holds no `repo.paths` from the DB; `route` tests for both values of `CLOUD_RUNS`.
- [ ] Run the connector check; write; commit `feat(executors): fix and apply jobs, cloud route`.

---

### Task 9: rampart-lite

**Files:** Create `skills/rampart-lite/SKILL.md`, `references/method.md`, `references/packs-condensed.md` (generated), `references/finding-schema.json`, `references/report-template.md`; Modify `scripts/packs.cjs` (+ `condense`), `README.md` (install line and the `AGENTS.md` snippet); Test `tests/lite.test.cjs`.

**Interfaces:**
- `condense(packs) → string`: per pack an H2 with name@version and applies-to, per hunt class one H3 with `Look for`, `Confirm by`, `Disprove by` collapsed to one line each and the severity; probes omitted (lite runs no probes); CLI `node scripts/packs.cjs condense [--out <file>]`.
- `SKILL.md` (spec §5.11, under 500 lines, no Claude-specific tool names): triggers; modes `diff`, `path`, `pr`, `system`; phases scope and owner confirmation → five-minute threat model → L1 when gitleaks/trivy/native audit exist else the manual equivalents → pack-guided hunt from `packs-condensed.md` → **verification in a fresh context** (a subagent where the host has one, else a written disprove-each-candidate pass done before the report) → report. Output `RAMPART-LITE-REPORT.md` and `rampart-lite-findings.jsonl`, each finding with `source: 'rampart-lite'` and `verification: {method: 'subagent'|'second-pass', confirmed: boolean}`.
- `references/finding-schema.json` is the full finding schema with `source` fixed to `rampart-lite`.

- [ ] Failing tests: the checked-in `packs-condensed.md` equals `condense(listPacks())` (drift guard, so a pack change must regenerate it); `SKILL.md` has `name: rampart-lite` front-matter, is under 500 lines, and names none of `Agent(`, `Workflow`, `ArtifactData`, `AskUserQuestion`; the reference schema equals the plugin's finding schema except `source`; `claude plugin validate . --strict` still passes with the second skill.
- [ ] Write; commit `feat(lite): portable rampart-lite skill`.

---

### Task 10: Import rampart-lite reports

**Files:** Create `scripts/import-lite.cjs`, `skills/rampart/jobs/import.md`; Modify `SKILL.md` (route `import <path>`: a `CLAUDE-SECURITY-*` dir → existing `audit --import` path; a `rampart-lite-findings.jsonl` → this importer), `scripts/import-claude-security.cjs` (size cap), `skills/rampart/jobs/verify.md`; Test `tests/import-lite.test.cjs`, fixture `tests/fixtures/lite/rampart-lite-findings.jsonl`.

**Interfaces:**
- `importLite({project, system, file}) → {run, counts: {imported, merged, added, skipped}}`: each line validated against the finding schema, redacted, stored with `class 'tool'` (half weight, spec §5.4: not yet through Rampart's verifier panel) and `source 'rampart-lite'`, `layer` `L2` for modes diff/pr else `L3`; ids recomputed with `findingId` (never trusted from the file); merge as `import-claude-security` does (P2-R43: an import never changes a finding's status). Both importers refuse files over 5 MB (P2 T12 minor).
- `verify.md`: `rampart-lite` findings are re-judged like hunt findings; a confirmed verdict promotes them to `class 'verified'` (`store.setClass`), a rejected one closes them.

- [ ] Failing tests: three lines → `added 3`, all class `tool`; a line carrying an `id` that differs from the computed one is stored under the computed id; a line with a credential-like value in `evidence` is stored redacted; re-import → unchanged; a 6 MB file is refused; an import onto an `accepted_risk` finding leaves its status.
- [ ] Implement; commit `feat(import): rampart-lite reports`.

---

### Task 11: Eval fixtures, cases and scorer

**Files:** Create `scripts/evals.cjs`, `skills/rampart/specs/eval-case-schema.json`, `evals/README.md`, `evals/cases/{hunt-target,decoy,secret-history,compose-admin-port}.json`, `evals/fixtures/decoy/**`, `evals/fixtures/secret-history/build.cjs`, `evals/fixtures/compose-admin-port/{docker-compose.yml,probes/**}`; Modify `.gitignore` (`evals/results/`); Test `tests/evals.test.cjs`.

**Interfaces:**
- Case: `{name, fixture (repo-relative dir, or 'build:<script>'), project: {type, packs, systems}, layer: 'L1'|'L2'|'L3'|'INFRA', effort, expect: [{classIds: [..], path?, host?, setting?, minSeverity}], mustNot: [{path?, classIds?}]}`. `hunt-target` (spec §8 IDOR + unscoped export) reuses `tests/fixtures/repos/hunt-target`; `decoy` is a route that looks like an IDOR but checks the session (expect `[]`, mustNot the route); `secret-history` builds a temp git repo with a fake key committed then removed (key assembled from fragments at build time) and runs L1; `compose-admin-port` is an INFRA case over the `fake-ssh` shim with canned probe output publishing an admin port on `0.0.0.0`.
- `score(runDir, store, kase) → {status: 'scored'|'run-failed', recall: number|null, noise: number|null, matched: [...], misses: [{expect, why: 'rejected'|'undecided'|'not-surfaced'}], extras: [ids], mustNotHits: [ids]}`: an expectation is matched by a `verified` id in `findings.json` whose ruleId ends with one of `classIds` and whose location matches (path equal, or host+setting); a miss is classified from `findings.json` `rejected`/`undecided` ids (P2-R51) by reading those candidates' locations from `candidates/`; recall = matched / expect (null when expect is empty); noise = extras / verified (null when nothing verified); a run whose `run.json` status is `failed` → `run-failed`.
- `run(kase, {effort?, rampartHome}) → {runId, runDir}` prepares the temp store (writes `project.json` with attestation `"eval fixture"`), and prints the exact `/rampart audit …` request for the recipe to run (the model work is the recipe's; the script never calls the model).
- `exportCases({project}) → {written}`: dispositions → `~/.rampart/evals/cases/<project>-<findingId>.json` (`false_positive` → a `mustNot`, `fixed`/`open` verified → an `expect`), with `fixture: {remote, commit}` taken from the finding's run revision stamp; refuses to write inside the plugin directory.
- CLI `node scripts/evals.cjs list|prepare|score|export …`.

- [ ] Failing tests (synthetic run dirs, no model): full match → recall 1, noise 0; a miss whose candidate is in `rejected` → `why 'rejected'`; decoy with one verified finding on the route → `mustNotHits` and noise 1, recall `null`; no verified findings → noise `null`; a failed run → `run-failed`; `secret-history/build.cjs` produces a repo whose working tree has no key and whose history has one, and the repository's own files contain no whole key (the test greps the fixture sources for the assembled value); export writes a `mustNot` for a false positive and refuses a path under the plugin root.
- [ ] Implement; commit `feat(evals): fixtures, cases and scorer`.

---

### Task 12: Evals job and the plugin eval suite

**Files:** Create `skills/rampart/jobs/evals.md`, `evals/skill/{front-desk-menu,never-applies,fix-not-auto,lite-trigger}/{prompt.md,graders/*.md}`; Modify `SKILL.md` (route `evals`; the "not in this version" line now lists only `refresh-packs`), `README.md` and `CONTRIBUTING.md` (the eval policy: run `/rampart evals` before keeping a pack, prompt or model change; real bugs first, noise second), `.claude-plugin/plugin.json` only if `experimental.evals` is needed to point `claude plugin eval` at `evals/skill`; Test `tests/recipes.test.cjs`.

**Interfaces:**
- `/rampart evals [--case <name>] [--effort low|medium|high] [--export --project <slug>]`: cost once (sum of the cases' audit estimates); for each case `evals.cjs prepare` → the matching audit recipe in the temp store (never the person's store) → `evals.cjs score`; a table per case (recall, noise, misses by `why`) and a total; results saved to `<temp>/evals-<date>.json` and the path printed. `--export` runs `exportCases` only. Unattended runs need `--effort` and accept the cost in words (P2 T14 limitation).
- `evals/skill/*`: `claude plugin eval` cases (`prompt.md` front-matter `max_turns`, `allowed_tools`; `graders/*.md` `type: llm`) for behaviour, not recall: the front desk opens its menu; "apply the fix for <id>" without a typed id applies nothing; `fix` never edits outside its run dir; "quick security review of this diff" triggers rampart-lite. Run with `claude plugin eval . --eval-dir evals/skill --runs 1`.

- [ ] Write; `claude plugin validate . --strict`; `claude plugin eval . --eval-dir evals/skill --runs 1 --max-cost-usd 5` and record the scores; commit `feat(skill): evals job and behaviour suite`.

---

### Task 13: Acceptance and release 0.5.0-alpha.1

- [ ] `npm test`, `npm run validate` green.
- [ ] Fresh-session acceptance (`claude -p --plugin-dir <worktree> --model sonnet`, temp `RAMPART_HOME`, `--max-budget-usd` caps per step, explicit `--allowedTools`, as P2-R45): `/rampart evals --effort low` scores all four cases and records recall/noise as the baseline in `evals/README.md`; on the hunt-target fixture copied into a temp git repo with a `testCommand`, `/rampart fix` on the IDOR finding → `reviewed` patch, worktree gone, the copy's checkout untouched; `/rampart apply` with the typed id → branch `rampart/fix-<id>` with one commit; a second apply → refused (branch exists); an INFRA finding → change plan, apply refuses; on the live dashboard (fixture data, as Plan 3 Task 11): queue Diagnose & fix, `watch --once` runs it, the page shows `Patch reviewed` and the patch, the typed-id sheet queues apply, `watch --once` applies it; a rampart-lite run in a plain session on the fixture produces the two files and `/rampart import` stores them as class `tool`. Record misleading recipe wording and fix it.
- [ ] CHANGELOG `0.5.0-alpha.1` (fix, apply, evals, lite, import, cloud route state; known limitations: infra apply is by hand, apply never pushes, fix in cloud drafts only, eval recall measured on four fixtures only); bump `plugin.json` and `package.json`; draft PR to `main`; tag after merge.

---

## Appendix A: ledger triage

Deferred minors in the three ledgers, sorted by whether they matter for a person using Rampart or for this plan's code.

**Folded into this plan**

| Ledger item | Why it matters now | Task |
|---|---|---|
| P2 final M4: `audit.js` runDir must start with `/` | Every L2/L3 run fails on Windows, the primary platform | 1 |
| P2 final parked: `okExit` missing on four probes | INFRA never closes findings on ordinary Docker/WordPress hosts | 1 |
| P2 T5: `+++ ` content line drops later hunks | L2 silently hunts less than the diff | 1 |
| P2 T6: candidate path not checked against its unit | A stray location can close or open findings in the wrong unit | 1 |
| P2 final: ledger class ids bare across packs | Multi-pack systems under-report gaps | 1 |
| P2 final M3: duplicated severity vocab | `fix-io` would add a third copy | 1 |
| P1 T5: no lock on read-modify-write | `watch` applying a fix while the terminal syncs drops writes | 2 |
| P3 T2 ⚠️: `location.host` not reduced in page data | An ssh user can reach the shared DB | 2 |
| P3 T5: `completionPatch` ignores current status; `isGithubRemote` accepts any scheme | More job types; cloud route reopens | 2 |
| P2 T14: `scripts/*.cjs` pre-approval covers every script | `apply.cjs` writes repositories; approval must be by name | 5 |
| P2 T13: L2/L3 lack the `cloudAllowed` check | Required once cloud runs are on | 8 |
| P3 final: free text not path-scrubbed beyond run reason | Patch text goes to the DB | 7 |
| P2 T12: no size cap on report reads | Shared by the new importer | 10 |
| P2 final M5: no chained init→workflow→assemble→report test | The evals cases are that test, run live | 11–13 |

**Left deferred** (cosmetic, test-only, or no user-visible effect at current scale): Plan 1 parser and regex nits (BOM literals, Alpine `-rN` ordering, nested `${A:-${B}}` defaults, headers comment wording, CLI scaffolding duplication, `store.cjs` size); Plan 2 prompt-wording nits (hunter injection paragraph, prober exit-1 note, example evidence), test-coverage gaps already covered by behaviour (stub stability, round-trip shapes, timestamp-collision flake in `render-report` tests: fix opportunistically), scrubber line-anchoring forms no probe prints (redact() backstop), `reverify` overwriting the hunt tally, stale running runs keeping raw files, INFRA ids hashing free-text service names, verify.md's 50k constant; Plan 3 page-polish items (toast timing, focus after filter, retry on `unavailable`, frozen dirty form, requeue pinning, `.rampart-publish/` fallback cleanup, CronCreate prose), the R40 wording edge and the cloud-kind hint for old pages.

## Appendix B: calls made without Pedro (for review in the PR)

1. `apply` creates a local branch `rampart/fix-<id>` in a separate worktree and commits there; it never touches the checkout, never pushes, never opens a PR.
2. Infra findings get a reviewed change plan; applying it stays manual in this plan (no host writes anywhere in Rampart).
3. A patch needs both reviewers to confirm all three claims (unanimous), stricter than the hunt's majority, because it changes code.
4. Tests run only from an owner-declared `testCommand` in the inventory, never from a command found in the repo.
5. The typed confirmation is the finding id itself.
6. The page shows the patch text (scrubbed, redacted, capped) so the owner reviews what they confirm.
7. `rampart-lite` findings import as class `tool` (half weight) until `/rampart verify` confirms them.
8. The cloud route opens only if a live connector check and one end-to-end cloud job pass; otherwise it stays gated and the plan ships without it.
9. The fix loop lives in the recipe (Agent tool), not a Workflow script, because each round needs a script step (diff, tests) between agents.
10. Evals score Rampart's own pipeline with a deterministic scorer over `findings.json`; `claude plugin eval` covers behaviour (routing, refusals), not recall.
11. Cases exported from real dispositions stay in `~/.rampart/evals/cases/`, never in the repo.
12. `refresh-packs` and project guidance files (spec §5.10 items 2 and 6) stay out of Plan 4.
