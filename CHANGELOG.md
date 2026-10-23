# Changelog

## 0.1.0-alpha.2 — 2026-10-23

Fixes from the whole-branch review of alpha.1.

- **Secrets reports are stored without the matched value.** A gitleaks report written without `--redact` (gitleaks' default, and what a report passed with `--input` usually is) carries each value in `Secret`, `Match` and `Line`. The stored copy now drops those fields, and `Author` and `Email`, from every entry before it is written and redacted, so a token in a format the redaction rules do not know (a GitLab token, a `credential = "..."` line) no longer lands in `raw/`.
- **Untriaged secrets hits can be triaged on a later audit.** The triage now offers every open, untriaged secrets hit of a system, not only the hits that audit found first (at most 20 per audit). `store.cjs findings` gains `--class`.
- **Switching dependency tools no longer counts a package twice.** A finished dependency scan closes the system's earlier findings from trivy, the npm audit and the pnpm audit that it no longer lists, whichever tool ran.
- **One checkout is one system.** The inventory folds the repo systems it detects in one folder into one system with every detected pack (a Next.js app with a `wrangler.toml` is one `web-nextjs` system with the `web-nextjs` and `cloudflare-workers` packs), so each checkout is scanned and triaged once.
- **No credentials in project addresses.** The store refuses a `live.url` with a user, password or token before the host, and a `host.ssh` written `user:pass@host`, naming the field and never the value.
- **Narrower git pre-approvals.** The skill pre-approves `git config user.name`, `git remote get-url` and `git rev-parse` instead of every git command. The `--repo` check reads the remote through `inventory-scan.cjs <folder> --remote`, which removes credentials from it.
- **The dashboard trend is right.** The score snapshot keeps the trend it was saved with, and the dashboard shows it, so a tile no longer reads "0.0, no change" right after every job.
- **Installable as its own marketplace.** `.claude-plugin/marketplace.json` lists the plugin, so `/plugin marketplace add <owner>/rampart` and `/plugin install rampart@rampart` can work. `npm run validate` checks both manifests.
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
