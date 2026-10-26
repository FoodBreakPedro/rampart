# Changelog

## Unreleased

- **Packs reach the live dashboard.** The sync now pushes each installed pack's public facts (name, version, last reviewed, what it applies to, class and probe counts) to the DB's `packs` collection, once per cycle through `sync-plan.cjs push --packs`, and reads that collection in its snapshot so later pushes are pinned. A dashboard synced before this version gets every pack on its next sync. The page does not show them yet.

## 0.4.0-alpha.1 — 2026-10-26

The hunt engine: Rampart's own agent audits for changes, whole repositories and self-hosted hosts.

- **Grades are no longer capped at C.** Repo systems declare L2 and L3 and hosts declare INFRA; those layers now have engines, so a finished L2, L3 or INFRA run earns its coverage credit and a clean project can reach an A.
- **`/rampart audit L3`**: a deep hunt of a whole repository. The repository is split into units, and the `rampart:audit` workflow runs one `hunter` agent per unit and pack class, at `low` (the five logic-bug classes: record scoping, tenant isolation, bulk export, sessions, search injection), `medium` (every class, reachable code) or `high` (every class, every unit) effort, with the agent count and a rough token estimate shown before anything runs.
- **`/rampart audit L2`**: the same hunt on what a branch changed against its base (`--base`, default the system's default branch); only the units holding changed files are hunted.
- **Independent verification.** Every candidate goes to fresh `verifier` agents told to disprove it. It becomes a finding only when a majority confirm it, with two confirmations for anything HIGH or CRITICAL; rejected and undecided candidates stay in the run directory, and the run's `findings.json` lists their ids. A unit whose hunter did not return is marked failed, never clean, and closes no findings.
- **A hunt closes only what it looked for.** A finding is closed as fixed only in a covered unit whose hunters hunted its class, and for L2 only in a file the hunters read; a unit whose hunter returned invalid entries or the most candidates it may (10) closes nothing, and the report says so. A run that covered fewer than half its units finishes failed, with no coverage credit.
- **Coverage remembers the classes.** The coverage ledger records the classes hunted on each unit and the effort; `coverage.cjs gaps` lists a unit until every class of its packs was hunted, and `REPORT.md` names the classes hunted and, under Skips, the ones a low effort left out.
- **`/rampart audit INFRA`**: the read-only probes of a host's packs (Docker host, Supabase, n8n, WordPress) over SSH or HTTP, with environment values scrubbed and every output redacted before it is written; one `infra-prober` agent compares the observations with the pack's baseline, and verifiers judge each candidate from the same observations. It refuses to run from a cloud session. A probe counts as covered only when it answered: exit 0 (or an exit code its pack declares healthy with `okExit`), or an HTTP status below 500; a permission error, a stopped Docker daemon or a 503 leaves its probe uncovered, and nothing is closed until every probe answered.
- **The live dashboard runs hunts too.** Its Run buttons now cover L2, L3 and INFRA, `/rampart watch` runs those audits and `verify` jobs from the queue, `verify` ends with the dashboard sync like the other jobs, and the post-push hook's `/rampart audit L2` suggestion is on.
- **`/rampart verify`**: re-judges open hunt findings against the current code with one fresh verifier each; a finding it can no longer reproduce is closed as fixed.
- **A `REPORT.md` per run**: title, headline, coverage, findings by severity, skips and the score after the run.
- **Review packs**: eight versioned packs (`packs/`) for Next.js, Node APIs, Expo, Cloudflare Workers, Supabase, n8n, Docker hosts and WordPress, each with hunt classes (look for, confirm by, disprove by, severity, CWE), a baseline and probes; `scripts/packs.cjs` lists, shows and validates them.
- **claude-security import**: `/rampart audit L2|L3 --import` records a claude-security report's findings (panel-verified, so stored as verified) without hunting, and never changes a finding's status. An attended L2 or L3 audit offers the hand-off once when the plugin is installed.
- The skill also pre-approves a plugin script run with no arguments, so a session outside auto mode no longer stops on a permission prompt at the final dashboard render.
- A grep probe whose pack declares `okExit: 0,1` (docker-host's `container-hostconfig`, where no match means no risky container flags) counts a match of nothing as a clean answer instead of a failed probe; any other grep that exits 1 is not an answer.

### Known limitations

- The `verifier` cannot run probes itself: an INFRA candidate is judged only from the observations the run already recorded.
- Some probes exit non-zero with a normal answer (`cat` of a Docker daemon configuration that does not exist, `trivy --version` where Trivy is not installed, the APT auto-upgrades file on a non-Debian host). The prober still reads them, but their probe is not covered, so on such a host an INFRA run closes no findings until the pack declares those exits with `okExit`.
- Agent write confinement is prompt-only: hunters, verifiers and the prober are told to write one file in the run directory, and nothing enforces it beyond your session's permissions.
- Hunters and verifiers read git history only when the session's working directory is the repository root; otherwise they judge the working tree alone.
- The INFRA environment scrub is line-based: a minified one-line JSON object passes to `redact()` only.
- The cost shown before a hunt is a rough estimate (a fixed token figure per agent run), not a measurement.
- One flaw can surface as several findings, one per pack class that catches it (an unscoped export found as record scoping, tenant isolation and bulk export); each is verified on its own.
- The `infra-prober`'s extra probes run only when your session allows the probe script: its agent definition lists the command but does not grant the permission, so outside auto mode or a matching allow rule it works from the recipe's probes alone.
- In a headless session (`claude -p`) nothing can be asked: the inventory saves nothing without the attestation, and an audit runs only when the request names the effort (`--effort`) and accepts the cost in words.
- Real gitleaks and trivy runs, and real SSH hosts, were not exercised on the build machine; acceptance used fixtures, a fake `ssh` and canned probe output.

## 0.3.0-alpha.1 — 2026-10-26

The live dashboard (Plan 3). Acceptance was run against a live published artifact with fixture data.

- **`/rampart dashboard` publishes a live claude.ai dashboard.** The page is a private artifact whose database is the record: projects, findings, runs, jobs, executors and meta. Only the owner can write; everyone else reads.
- **Findings carry dispositions.** The owner marks a finding fixed, false positive or accepted risk from the page, with a reason for the last two, and the decision is signed with the owner's user id.
- **Job buttons show cost and route before they queue anything.** A Run button queues a job with its estimated cost and the route that will run it (a local executor in this release). Only layers with an engine get a button (L1 for now).
- **Settings live on the page.** The owner sets them in the dashboard and the executors read them from the database.
- **Findings export as JSONL or SARIF.** SARIF 2.1.0 has one result per open finding, a stable fingerprint, no evidence text, and the plugin version as the tool version. The files are named `.jsonl.txt` and `.sarif.json` to fit the downloads allowlist.
- **`/rampart dashboard --sync` mirrors the local store into the dashboard database.** It pulls the page's decisions, settings and jobs first, then writes versioned documents; once published, the database is the record of truth and the local store a cache plus each run's raw output.
- **`/rampart watch` runs queued jobs.** It claims a job with a version-pinned write, so two executors never run one job. Use `/loop /rampart watch` to keep it running.
- **`/rampart schedule` sets up a weekly sync and the overdue L1 audits.**
- **Two hooks.** SessionStart adds a one-line note when a tool a stored project needs is missing, from a doctor report cached per day, and is silent otherwise. After a `git push` from a stored project's repo folder, the post-push hook suggests `/rampart audit L2 --project <slug>` once per session, but only once L2 is available (the hunt engine); on this release alone it stays silent.

### Known limitations

- No apply or fix yet; that is Plan 4.
- Cloud runs are off in this release: every job runs on a local `/rampart watch` executor, even on a project that allows cloud. They arrive with a cloud executor in a later version. Remote Control is optional; with it, the page nudges a watch session to run a job at once.
- Verify, L2, L3 and INFRA jobs wait for the hunt engine (Plan 2). The post-push L2 nudge and the verify sync line arrive when the branches meet.
- Acceptance used fixture data, not a real audit's findings.

## 0.1.0-alpha.2 — 2026-10-23

Fixes from the whole-branch review of alpha.1.

- **Secrets reports are stored without the matched value.** A gitleaks report written without `--redact` (gitleaks' default, and what a report passed with `--input` usually is) carries each value in `Secret`, `Match` and `Line`. The stored copy now drops those fields, and `Author` and `Email`, from every entry before it is written and redacted, so a token in a format the redaction rules do not know (a GitLab token, a `credential = "..."` line) no longer lands in `raw/`.
- **Untriaged secrets hits can be triaged on a later audit.** The triage now offers every open, untriaged secrets hit of a system, not only the hits that audit found first (at most 20 per audit). `store.cjs findings` gains `--class`.
- **Switching dependency tools no longer counts a package twice.** A finished dependency scan closes the system's earlier findings from trivy, the npm audit and the pnpm audit that it no longer lists, whichever tool ran.
- **One checkout is one system.** The inventory folds the repo systems it detects in one folder into one system with every detected pack (a Next.js app with a `wrangler.toml` is one `web-nextjs` system with the `web-nextjs` and `cloudflare-workers` packs), so each checkout is scanned and triaged once.
- **No credentials in project addresses.** The store refuses a `live.url` with a user, password or token before the host, and a `host.ssh` written `user:pass@host`, naming the field and never the value.
- **Narrower git pre-approvals.** The skill pre-approves `git config user.name`, `git remote get-url` and `git rev-parse` instead of every git command. The `--repo` check reads the remote through `inventory-scan.cjs <folder> --remote`, which removes credentials from it.
- **The dashboard trend is right.** The score snapshot keeps the trend it was saved with, and the dashboard shows it, so a tile no longer reads "0.0, no change" right after every job.
- **Installable as its own marketplace.** `.claude-plugin/marketplace.json` lists the plugin, so `/plugin marketplace add FoodBreakPedro/rampart` and `/plugin install rampart@rampart` can work. `npm run validate` checks both manifests.
- A rotated history leak marked fixed stays fixed when gitleaks reports it again, since the history cannot un-leak.
- Finding text (title, evidence, exploit scenario, preconditions, recommendation) is redacted as it enters the store.
- A JWT right after a URL-encoded character (`Bearer%20…`, `token%3D…`) is redacted.
- On Windows, a file write retries a rename that an antivirus scanner or indexer briefly locks, and a torn last line in `scores.jsonl` no longer blocks scoring.
- The raw copy of a headers check keeps the requested URL without its query and fragment.
- Dashboard: the copy buttons are no longer marked disabled, the copy fallback can take focus, faint text and the light grade-D badge meet 4.5:1 contrast, long names wrap, and only layers with an engine (L1 for now) get a Run button.
- Node 20 or newer (Node 18 is past its end of life); `/rampart doctor` checks for 20.

### Known limitations

- No project grades above C: repo systems declare L2 and L3, which have no engine until Plan 2, so their coverage is capped even with zero findings.
- Real gitleaks and trivy runs were not exercised on the build machine; the secrets and dependency checks were tested with recorded reports and fake binaries.
- The secrets triage reads a leak's commit with git only when the repository is the session's working directory; otherwise it judges from the working tree.
- A dependency scan with a different tool than the last one closes the other tool's findings for that system, so a machine with only npm closes the pip or Go findings trivy reported until trivy runs again.

## 0.1.0-alpha.1 — 2026-10-23

- Plugin manifest and the `/rampart` front desk: one skill that routes a request to its job, a four-option menu when none is named, and shared rules every job follows (owner attestation gate, inventory-only targets, no credential values, read and report only).
- `/rampart inventory`: a deterministic scanner that detects Next.js, Node API, Expo, Supabase, n8n, Docker Compose, Cloudflare Workers and WordPress systems in a folder, an optional `inventory-mapper` agent run (sonnet) to refine the draft, and a confirmed `project.json` with your owner attestation.
- `/rampart audit L1` secrets check: gitleaks over the full git history with `--redact`, or a gitleaks report you pass with `--input`; new hits can be triaged as real or fixture by one small `explore` agent run each.
- `/rampart audit L1` dependency check: trivy, or the npm or pnpm audit when trivy is missing, with one finding per vulnerable package; or a trivy or npm audit report passed with `--input`.
- `/rampart audit L1` headers check: one GET of each live URL, redirects followed, graded Observatory-style, with gaps recorded as hardening notes; an unreachable URL becomes a skipped run with its reason.
- Per-user store in `~/.rampart` (or `RAMPART_HOME`): projects, findings with stable ids that dedupe across runs, regressions that keep their first-seen date, findings closed when a scan no longer reports them, dispositions and runs, all as plain JSON and JSONL.
- Redaction of credential values in every tool report before it is written.
- JSON schemas for projects, findings, runs and jobs, with a zero-dependency validator.
- Score sheet (`score.cjs`): coverage out of 40 and findings out of 60 by finding class (`verified`, `tool`, `hardening`) and severity, letter grades, criticality weights and a trend against the last saved score.
- `/rampart doctor`: Node, gitleaks, trivy, python3, gh, ssh and git, the `claude-security` plugin, the store and packs, and what degrades without each.
- `/rampart dashboard --static`: every project as a tile with grade, score, open findings by severity and layer freshness, plus a per-project score sheet, as one HTML file in the store that works in light and dark and at phone width.
- Test suite on the built-in `node:test` runner, with no npm dependencies.
