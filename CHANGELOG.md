# Changelog

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

### Known limitations

- No project grades above C: repo systems declare L2 and L3, which have no engine until Plan 2, so their coverage is capped even with zero findings.
- The dashboard tile's trend reads 0.0 right after a job, because the job saves its score snapshot before it renders the page; a fix is pending.
- Real gitleaks and trivy runs were not exercised on the build machine; the secrets and dependency checks were tested with recorded reports and fake binaries.
