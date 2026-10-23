# Rampart — design

Date: 2026-10-23. Status: draft for approval. Author: Claude, from a brainstorming conversation with Pedro Zabala.

Rampart is a public Claude Code plugin, plus a portable "lite" skill, that performs layered security and vulnerability reviews across all of a person's systems (code repositories, live sites, databases, automation servers, edge workers, self-hosted hosts), keeps a per-user record of what was inventoried, scanned and found, and presents it as an interactive dashboard whose buttons dispatch agents to diagnose, verify, and propose fixes.

Working name: **Rampart**. Command: `/rampart`. Lite skill: `rampart-lite`.

---

## 1. Intent and why

Pedro runs around twenty repositories and several live systems (a home server with n8n and a self-hosted Supabase, Next.js sites, an Expo mobile app, Cloudflare Workers, Hostinger-hosted sites). Several good security tools already exist in his Claude Code setup, but each covers one slice:

| Existing tool | Covers | Misses |
|---|---|---|
| `/security-review` (built-in) | One pass over the current branch diff | Whole repo, infra, history, dependencies |
| `claude-security` plugin | Multi-agent verified scan of a repo or diff; reviewed patch files | Non-code systems, secrets history, dependency CVEs, live hosts |
| `agent-skills:security-and-hardening` + `agent-skills:review` | Threat-model checklist (STRIDE, OWASP, LLM Top 10, supply chain, privacy) | Runs nothing; change-scoped |
| `security-guidance` plugin (not installed) | Reviews code as Claude writes it | Existing code, infra |
| Code Review / ultrareview | PR-time multi-agent review | Billed, PR-only, not infra |
| Cloudflare `security-audit` skill | Six-phase coverage-led hunt with fresh verifiers, additive runs | Single repo per run, no persistence across projects, no UI |

Nothing ties these together, nothing covers systems that are not a repository, nothing remembers across runs, and nothing gives one place to see "what have I checked, when, and how bad is it." Rampart is that layer. It wraps the existing tools where they exist, fills the gaps (secrets history, dependencies, headers, infra probes, logic-bug hunts), persists everything, scores it, and puts buttons on it.

The framework Pedro gave (from a security-audit video) sets the shape:

- **Level 1, foundational, every app**: gitleaks over git history; trivy or the native package audit over dependencies; run on every commit / regularly.
- **Level 2, PR and CI**: agent security review of each change; security headers check (Mozilla Observatory style) on live hosts.
- **Level 3, critical features and pre-launch**: deep multi-agent audit with hunters and independent verifiers on auth, billing, tenant isolation, data export; before launches or when touching AuthN/AuthZ or billing.

Procedural rules from the same sources, carried into Rampart as hard requirements: never let an agent grade its own work (a separate, fresh-context verifier decides); focus on authorization and data-scoping logic bugs, injection in search/API parameters, session handling, and bulk export tenant bypass; match review depth to risk; cap review rounds so agent-vs-agent loops converge; turn every confirmed finding and false positive into an eval case.

## 2. Goals, non-goals, anti-goals

**Goals**

1. One inventory per project listing every system in it, which audit layers apply to each, and who may run them where.
2. Run the three levels plus an infra probe per system, reusing `claude-security`, `/security-review`, gitleaks, trivy and native audits where present, and degrading gracefully where not.
3. Every finding that reaches the record has survived a fresh-context verifier whose job was to disprove it.
4. A per-user, cross-project record with stable finding IDs so repeat runs dedupe and trends, regressions and time-to-fix are visible.
5. A dashboard (claude.ai artifact) with a tile/carousel view per project: systems, last run per layer, score sheet, open findings, and buttons that launch the matching Rampart job through Claude Code.
6. Fix flow: diagnose, draft a patch or change plan, have an independent reviewer vouch for it, deliver it for the user to apply. Never auto-apply.
7. Evolve without rewrites: versioned check packs with sources, a refresh job that proposes pack updates as pull requests, live advisory feeds at run time, and an eval set built from past findings.
8. Publishable: MIT, public GitHub repo, installable as a Claude Code plugin from any marketplace and as a standalone skill via the Skills CLI; works for anyone, not just Pedro.
9. `rampart-lite`: the method and condensed packs in one portable skill with no store or dashboard dependency, usable in a single session or by other coding agents.

**Non-goals (v1)**

- Replacing CI-based static analysis, Dependabot, or a managed product like Claude Security Enterprise. Rampart orchestrates and records; it is not a SAST engine.
- Scanning third-party or untrusted repositories. Rampart assumes the user owns what it scans.
- A hosted multi-tenant SaaS with its own backend. The artifact plus the user's own Claude Code sessions are the "SaaS".
- Mobile app binary analysis, network penetration testing beyond non-destructive checks, or compliance certification output.

**Anti-goals (what would make it a failure even if it works)**

- Noisy reports. A long list of unverified maybes is worse than a short list of confirmed problems. Cloudflare's rule applies: a defense-in-depth gap is a hardening note, not a finding.
- Anything that applies a change to production code or a live host without an explicit, separate confirmation.
- Printing or storing a credential value anywhere (reports, DB, logs, chat).
- A dashboard that looks live but is stale. Every number carries its timestamp and the run it came from.
- Rules hardcoded in prompts such that updating a standard means editing an agent.

## 3. Users and distribution

- **Primary user**: a solo developer or small team running several products, using Claude Code on the desktop app, web, or CLI, with a claude.ai plan (needed for the artifact dashboard and the Workflow tool).
- **Secondary user**: anyone with a coding agent (Codex, Cursor, Gemini CLI, Claude Code) who wants a disciplined one-off security review. They install `rampart-lite` only.

**Distribution**

- Public GitHub repository (name: `rampart`, under Pedro's GitHub account; final name is Pedro's call). MIT license. `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`.
- Claude Code plugin: `.claude-plugin/plugin.json` at repo root. Listed in Pedro's private `pedro-plugins` marketplace (`claude-plugins` repo) and installable from GitHub directly (`/plugin marketplace add <owner>/rampart`).
- Lite skill: `skills/rampart-lite/` installable with `npx skills add https://github.com/<owner>/rampart --skill rampart-lite` (the Skills CLI from skills.sh, the same path the Cloudflare skill uses).
- Versioning: semver in `plugin.json`; `CHANGELOG.md`; packs carry their own version field.

## 4. Concepts

| Term | Meaning |
|---|---|
| **Project** | A product the user cares about as one thing: "HyperlaneTravels", "GameLiftEat app", "Home server stack". Has a slug, a criticality tag, an owner attestation. |
| **System** | One component inside a project: a repo, a live site, a database, an automation server (n8n), an edge worker, a Docker host, a CMS. Has a type, which selects its packs, and an executor (where jobs for it may run). |
| **Layer** | `L1` foundational (secrets history, dependencies, headers), `L2` change review, `L3` deep audit, `INFRA` host/service probe. Each system declares which apply and the cadence in days. |
| **Pack** | A versioned Markdown module per system type that tells hunters what to look for, what "good" looks like, which sources it was derived from, and when it was last reviewed. |
| **Run** | One execution of one job against one project (possibly several systems). Produces a run directory and a revision stamp. |
| **Finding** | A verified problem with a stable ID, severity, confidence, location, evidence, exploit scenario, recommendation, and status. |
| **Disposition** | The user's decision on a finding: open, fixed, false positive, accepted risk. Feeds the eval set. |
| **Score sheet** | Per system and per project: coverage score, findings score, freshness, letter grade, trend. |
| **Job** | A request to run something: inventory, audit (layer, system), verify, fix, apply, refresh-packs, doctor, evals. Jobs are queued in the dashboard DB and claimed by an executor. |
| **Executor** | Where a job runs: `local` (a Claude Code session on the user's machine, which can reach the LAN and SSH hosts) or `cloud` (a Claude Code cloud session, repo-only, opt-in per project). |

## 5. Architecture

### 5.1 Repository layout

```
rampart/
  .claude-plugin/plugin.json
  README.md  LICENSE  SECURITY.md  CONTRIBUTING.md  CHANGELOG.md
  skills/
    rampart/
      SKILL.md                      # front desk: parse request → menu → load one job recipe
      role.md                       # shared rules for every job (trust model, redaction, verification bar)
      jobs/
        inventory.md  audit.md  verify.md  fix.md  apply.md
        dashboard.md  watch.md  refresh-packs.md  doctor.md  evals.md  schedule.md  import.md
      specs/
        project-schema.json  finding-schema.json  job-schema.json  run-schema.json
        score.md  report-spec.md  db-layout.md
    rampart-lite/
      SKILL.md
      references/method.md  references/packs-condensed.md
      references/finding-schema.json  references/report-template.md
  agents/
    inventory-mapper.md   # sonnet; reads a folder/host description, drafts project.json
    hunter.md             # per pack; coverage-led; writes candidates only
    verifier.md           # fresh context; must disprove; votes
    infra-prober.md       # read-only SSH / HTTP probes against inventoried hosts
    fixer.md              # drafts patch (code) or change plan (infra) in a scratch workspace
    patch-reviewer.md     # independent; three claims (addresses finding, no new vuln, behaviour unchanged)
    pack-curator.md       # reads a pack's sources, proposes a pack diff
    explore.md            # read-only codebase explorer dispatched by the others
  packs/
    _template.md
    web-nextjs.md  node-api.md  mobile-expo.md  supabase.md  n8n.md
    docker-host.md  cloudflare-workers.md  wordpress-hostinger.md
  scripts/                # Node ≥ 18, zero dependencies, .cjs
    store.cjs             # read/write ~/.rampart (projects, runs, findings, dispositions)
    l1-secrets.cjs        # gitleaks wrapper (detect binary, run, normalize)
    l1-deps.cjs           # trivy fs / npm audit / pnpm audit / yarn audit wrapper, normalize
    l1-headers.cjs        # fetch live URL headers, grade (Observatory-style rubric), normalize
    normalize.cjs         # any source → finding-schema, stable id
    import-claude-security.cjs   # CLAUDE-SECURITY-RESULTS.jsonl → findings
    import-lite.cjs       # rampart-lite-findings.jsonl → findings
    score.cjs             # score sheet from store
    render-static.cjs     # ~/.rampart/dashboard.html from store (no claude.ai needed)
    sync-plan.cjs         # store → ArtifactData batch payload (delta)
    validate.cjs          # JSON-schema validation for project/finding/job files
    redact.cjs            # scrub credential-looking values from any text before it is stored
  workflows/
    audit.js              # Workflow tool script: hunters → verifiers pipeline with round cap
  dashboard/
    index.html            # artifact template (single file, CDN libs pinned)
  evals/
    README.md
    fixtures/             # tiny synthetic apps with planted vulnerabilities
    cases/                # expected findings per fixture (+ cases exported from dispositions)
    rampart.eval.json     # `claude plugin eval` suite
  hooks/
    hooks.json            # SessionStart: cheap doctor check; PostToolUse(git push): suggest L2 once
  docs/
    superpowers/specs/    # this document and successors
```

### 5.2 The per-user store

Path: `~/.rampart/` (override with `RAMPART_HOME`). Plain JSON and JSONL so it is greppable, diffable, and portable. Optional project-local mirror at `<repo>/.rampart/` (gitignored, written only when the user asks) for teams that want the record next to the code. When a dashboard exists its DB is the master record and this store is a cache plus raw output (see §5.7, Record of truth); without one, this store is the master.

```
~/.rampart/
  config.json                # dashboard artifact url, default executor, tool paths, model prefs
  projects/<slug>/
    project.json             # inventory (schema §5.3)
    findings.jsonl           # one finding per line, upserted by stable id
    dispositions.json        # finding id → {status, reason, by, at}
    coverage.json            # Cloudflare-style ledger: units checked, by which run, with what pack version
    runs/<run-id>/
      run.json               # job, systems, layers, revision stamps, effort, timing, counts
      raw/                   # tool output (gitleaks.json, trivy.json, headers.json, CLAUDE-SECURITY-*.jsonl copy)
      candidates.jsonl       # hunter output before verification (never shown on the dashboard)
      votes.jsonl            # verifier verdicts per candidate
      REPORT.md              # human report for this run
      patches/  changes/     # F<n>.patch (code) or F<n>.md (infra change plan + rollback)
  packs-state.json           # installed pack versions, last refresh, pending pack PRs
  evals/cases/               # cases exported from dispositions
```

Secrets never enter the store. `redact.cjs` runs over every raw tool output and every agent-written file before it lands; a hard-coded-credential finding records file, line and symbol, never the value (same rule as `claude-security`).

### 5.3 Inventory: `project.json`

```json
{
  "slug": "gamelifteat-app",
  "name": "GameLiftEat app",
  "criticality": "high",
  "ownerAttestation": { "statement": "I own or am authorized to test every system listed here", "by": "<user id or name>", "at": "2026-10-23T00:00:00Z" },
  "defaultExecutor": "local",
  "cloudAllowed": false,
  "systems": [
    {
      "id": "mobile",
      "type": "mobile-expo",
      "name": "Expo app",
      "packs": ["mobile-expo"],
      "repo": { "remote": "github.com/<owner>/GameLiftEat-App", "defaultBranch": "main", "paths": { "<machineId>": "<local checkout path on that machine>" } },
      "executor": "either",
      "layers": { "L1": { "cadenceDays": 7 }, "L2": { "cadenceDays": 30 }, "L3": { "cadenceDays": 90 } }
    },
    {
      "id": "db",
      "type": "supabase",
      "name": "Self-hosted Supabase",
      "packs": ["supabase", "docker-host"],
      "host": { "ssh": "<ssh-user>@192.0.2.10", "composeProject": "<compose-project>", "configPath": "<path to compose files>" },
      "executor": "local",
      "layers": { "INFRA": { "cadenceDays": 30 }, "L3": { "cadenceDays": 90, "scope": "RLS policies, auth config, edge functions" } }
    }
  ],
  "created": "...", "updated": "..."
}
```

The `inventory` job builds this with the `inventory-mapper` agent: it reads the folder (manifests, `next.config`, `supabase/`, `infra/`, `docker-compose*.yml`, `wrangler.toml`, `eas.json`, `CLAUDE.md`, `AGENTS.md`), guesses system types and packs, then asks the user to confirm live URLs, hosts, criticality, and executor rules, and to give the owner attestation. For hosts it may, with permission, run read-only discovery over SSH (`docker ps`, compose project names, listening ports) to list services. Everything it guesses is marked `"source": "inferred"` until confirmed.

### 5.4 Finding schema

```json
{
  "id": "a3f9c21be0d4",
  "project": "gamelifteat-app",
  "system": "db",
  "layer": "INFRA",
  "source": "infra-probe",
  "pack": "supabase@1.2.0",
  "ruleId": "supabase/auth/anon-signups-open",
  "title": "Anonymous sign-ups enabled on a production Auth instance",
  "severity": "HIGH",
  "confidence": "HIGH",
  "cwe": ["CWE-284"],
  "class": "verified",
  "location": { "host": "192.0.2.10", "service": "supabase-auth", "setting": "GOTRUE_DISABLE_SIGNUP" },
  "evidence": "GOTRUE_DISABLE_SIGNUP=false in the running container env (value redacted class: config)",
  "exploitScenario": "...",
  "preconditions": "...",
  "recommendation": "...",
  "verification": { "verifiers": 2, "confirmed": 2, "run": "2026-10-23T18-02-11Z" },
  "status": "open",
  "firstSeen": "...", "lastSeen": "...", "fixedIn": null,
  "externalIds": { "claudeSecurityPluginFindingId": null, "cve": null }
}
```

Stable id: first 12 hex of SHA-256 over `project|system|ruleId|normalizedLocation`. Code locations normalize to `path:symbol` (line numbers drift). Imports from `claude-security` keep that plugin's finding id in `externalIds` and reuse it for dedupe. Severity vocabulary and the CVSS-v4-style qualitative mapping follow `claude-security` so imported and native findings compare.

**Finding classes.** Not everything a tool emits has earned the same standing, and the score must not pretend otherwise:

| `class` | Who produced it | Standing |
|---|---|---|
| `verified` | A model hunt whose candidate survived the fresh-context verifier panel, or an L1 hit that passed triage | Full weight in the score |
| `tool` | A deterministic L1 result not yet triaged: a dependency advisory from trivy or the native audit, a gitleaks hit awaiting triage | Half weight; dependency advisories are grouped as one finding per vulnerable package, not one per CVE |
| `hardening` | A defense-in-depth gap: a missing security header, a weak TLS setting, a recommended-but-absent flag | Shown in its own column, never deducted from the findings score |

L1 secrets hits get a cheap triage pass on sonnet (real credential pattern versus fixture, example, or test value) and are promoted to `verified` or dismissed; dependency advisories stay `tool` until a reachability check (v0.2) promotes or dismisses them. Goal 3 ("every finding survived a verifier") therefore applies to the `verified` class; the other two are labelled for what they are.

**Cross-engine dedupe.** When a `claude-security` import and a Rampart hunt report the same weakness, the records merge: same CWE family and same `path:symbol` (or same host, service and setting) → one finding keeping both external ids and the higher verification count.

### 5.5 Jobs and the engine

All jobs are recipes under `skills/rampart/jobs/`, loaded by the front desk `SKILL.md` the way `claude-security` does it: parse the request, offer a one-question menu only where something is open, confirm cost once, then run. Every job writes a run directory and ends by updating the store, the score, and (if a dashboard exists) the artifact DB.

| Job | What it does | Model use |
|---|---|---|
| `inventory` | Build or update `project.json` (§5.3) | `inventory-mapper` on sonnet |
| `audit L1` | Per system with a repo: gitleaks over full history; trivy fs or native audit on the lockfile; per system with a live URL: headers grade. Pure scripts. | none |
| `audit L2` | Per repo system: if `claude-security` is installed, run its *scan changes* on the branch/PR and import; else run `/security-review` and normalize its output; optionally the `agent-skills` five-axis review when installed. | session model |
| `audit L3` | Per repo system: if `claude-security` is installed, run *scan codebase* (whole or scoped) and import; then always run Rampart's own pack-driven hunt for the logic-bug classes the framework calls out (authz scoping, tenant isolation, export, session, search/API injection), through `workflows/audit.js`. | session model |
| `audit INFRA` | Per host/service system: `infra-prober` over SSH or HTTP runs read-only checks from the pack (versions vs advisories, env flags, auth settings, exposed ports, TLS, container image scan with trivy, Supabase advisors through its MCP when connected). Non-destructive probes only. | session model |
| `verify` | Re-run verifiers on a chosen finding or on all open findings against current code (regression check). | session model |
| `fix` | For one finding: `fixer` drafts in a scratch workspace (git worktree for code; a change plan with exact commands and rollback for infra); `patch-reviewer` must vouch for the three claims; output `patches/F<n>.patch` or `changes/F<n>.md`. Nothing applied. | session model |
| `apply` | Apply one reviewed patch or change plan after explicit confirmation. Infra: back up the touched files, apply, health-check, roll back on failure. | minimal |
| `dashboard` | Publish the artifact (first time) or sync the delta to its DB. Also renders the static HTML fallback. | none |
| `watch` | Executor loop: claim queued jobs from the dashboard DB whose executor matches, run them, write results back. Registers itself in `executors/`. | per job |
| `refresh-packs` | `pack-curator` reads each pack's sources, diffs, proposes updates as a PR to the plugin repo (or a local patch when the user is not a contributor). | sonnet + session model |
| `doctor` | Report plugin, tool (gitleaks, trivy, python3, gh, ssh), pack versions and what degrades without them. | none |
| `evals` | Run `claude plugin eval` over `evals/`; report recall and noise; export dispositions to cases. | session model |
| `schedule` | Create the weekly feeds/freshness job and the per-cadence reminders with whatever scheduler is available (Claude Code scheduled tasks, cloud routine, or print a cron line). | none |
| `import` | Import a `rampart-lite` report or a `CLAUDE-SECURITY-*` directory produced outside Rampart. | none |

**The hunt pipeline** (`workflows/audit.js`, used by L3 and by INFRA when a pack has hunt classes): inventory units from the coverage ledger → one `hunter` per pack class in parallel, writing candidates only → every unique candidate to a fresh `verifier` that is told to disprove it from the code or host state, never from the candidate text → majority vote with a minimum of two verifiers for anything HIGH or CRITICAL → survivors become findings; rejected candidates are kept in the run directory for the eval set but never shown. Round cap of three for any fix-and-recheck loop. Confidence can never exceed what verification earned (the same rule `claude-security` enforces in code).

**Reuse rule, revised after review.** `claude-security` cannot start unattended: its recipe accepts the scan's cost only from the person's own typed request or their answer to its prompt, it refuses an acceptance that arrives from a scheduled task or wake-up, and its hook closes an unanswered prompt after sixty seconds. So:

- **Rampart's own hunter → verifier pipeline is the engine for every unattended run**: anything launched from a dashboard button, picked up by `watch`, started in a cloud session, or fired by `schedule`. That pipeline therefore covers the general vulnerability classes in v0.1 (injection, authentication and session, authorization and IDOR, SSRF, cryptography, deserialization, secrets handling, misconfiguration), not only the logic-bug classes; the packs supply the per-system specifics.
- **`claude-security` is offered when the person runs `/rampart audit L2|L3` interactively at the terminal** and has it installed: Rampart hands off, waits, imports the results, and dedupes them against its own (see §5.4). Its stronger report pipeline is a bonus for attended runs, not a dependency.
- `doctor` reports which engine will run in which situation.

### 5.6 Score sheet (`specs/score.md`)

Per system, two parts and a decay:

- **Coverage (40 points)**: for each applicable layer, full credit if its last successful run is within its cadence window, half credit within two windows, none beyond. Average across applicable layers.
- **Findings (60 points)**: start at 60; subtract per open finding (not accepted-risk, not false-positive) by class and severity. `verified`: CRITICAL 25, HIGH 12, MEDIUM 5, LOW 1. `tool`: half of those, with dependency advisories already grouped per package. `hardening`: nothing. Floor 0.
- **Hardening column**: count of open hardening notes per system, shown beside the grade so a missing header is visible without sinking the grade.
- **Grade**: A ≥ 90, B ≥ 75, C ≥ 60, D ≥ 40, F below.

Project score = weighted mean of its systems, weights by criticality tag (auth/billing/data systems 3, public web 2, internal 1). Trend = delta against the previous run. The sheet also shows pack staleness (days since the pack's `lastReviewed`) and "re-audit recommended" badges from the feeds job. Numbers are tunable in `score.md`; the builder may adjust after seeing real data, with one check: a typical Node repo with a handful of ungrouped `npm audit` highs and clean verified hunts should land in the B range, not D.

### 5.7 Dashboard artifact

One HTML file, published per user from `dashboard/index.html` by the `dashboard` job through the Artifact tool, with capabilities:

- `db` and `user`: the record the page renders and the job queue it writes.
- `mcp` with server `Claude Code Remote`, tools `create_session`, `send_message`, `get_session`, `list_sessions`, `list_environments`: so a button can launch or nudge a Claude Code session as the viewer.
- `downloads`: export a project's findings as JSONL or SARIF.

**DB layout** (`specs/db-layout.md`): `projects/<slug>` (inventory mirror + score), `projects/<slug>/systems/<id>`, `findings/<id>`, `runs/<id>` (summary only), `jobs/<id>`, `executors/<sessionId>`, `packs/<name>`, `meta/sync`. Rules: read for signed-in viewers; **writes to `jobs`, `dispositions` and `projects` are owner-only** (`write: "owner"`), so sharing the dashboard never lets a viewer queue work against the owner's machines. The artifact is private by default.

**Record of truth.** When a dashboard exists, its DB is the master record for findings, runs, dispositions and jobs. Every `~/.rampart` store on every machine, and every cloud session's scratch copy, is a cache plus the raw tool output for the runs it produced. This is what lets the same person work from a Windows PC, a Mac and cloud sessions without three stores each claiming to be right. Conflict rule: per document, last writer wins on `updatedAt`, except that a disposition the person made in the page always beats an automated status change. Machine-specific values (`repo.paths`) are keyed by a machine id (hostname hash) in `project.json`; the repo's `remote` is its identity. Without claude.ai (API-key users), there is no DB: the local store is the master and Rampart is single-machine, which `doctor` states.

**Confirmation and authority.** A dashboard click counts as the owner's confirmation for a job that reads and reports (`audit`, `verify`, `inventory`, `fix` drafting), provided the page showed the cost estimate for that job before queueing it; the job doc records `createdBy`, `confirmedAt` and `costShown`. `apply` needs a second, typed confirmation in the page naming the finding, recorded the same way. Executors (local `watch` or a cloud session) run only jobs whose `createdBy` is the artifact owner, and refuse `apply` jobs older than 24 hours without a fresh confirmation. Nothing an executor does on its own is more than read-only.

**Views**

1. **Tiles / carousel**: one tile per project: name, grade and score, sparkline of score over runs, counts of open findings by severity, systems as small chips each with a layer strip (L1 L2 L3 INFRA) coloured by freshness, "last reviewed" date, and badges (re-audit recommended, pack stale, executor offline). Keyboard and swipe navigation; works at phone width.
2. **Project detail**: score sheet table (system × layer: last run, result, next due), findings table (filter by system, severity, status; disposition buttons: fixed / false positive / accepted risk with a reason), run history with links to the run's report text (stored in `runs/<id>.reportMd`).
3. **System card actions**: "Run L1", "Run L2 on current branch", "Run L3 (full / scoped…)", "Probe infra", "Pen-test checks (n8n)", and per finding "Diagnose & fix", "Verify still present", "Apply reviewed patch". Each button writes a `jobs/<id>` doc and then, depending on the system's executor: `cloud` → `create_session` with the repo `source_url` and the prompt `/rampart <job> --job <id>`; `local` → `send_message` to the registered local executor session if one is online, else the job waits in the queue. The page shows the job's status live from its doc.
4. **Settings**: executor preferences per project, cloud opt-in, cadence overrides, which model tier to request for hunts.

**Sync**: after each run the executor pushes its new or changed findings, run summary and score to the DB with `ArtifactData batch`, and pulls dispositions and inventory edits made in the page back into its local cache. `dashboard` run by hand does the same in both directions for everything.

**Without claude.ai** (API-key users, other agents): `render-static.cjs` writes `~/.rampart/dashboard.html` with the same template and data inlined; buttons show the `/rampart` command to copy.

### 5.8 Executors and the local watch loop

- `cloud` executors run only repo-scoped jobs on projects with `cloudAllowed: true` (the repo bundle leaves the machine). Infra jobs never go to cloud; the page disables those buttons for cloud-only situations.
- `local` executor: a Claude Code session on the user's machine running `/rampart watch`. It registers `executors/<sessionId>` with a heartbeat, enables Remote Control on itself when the host allows so `send_message` can reach it, and otherwise polls the `jobs` collection through `ArtifactData` on an interval (default 2 minutes) using the session's wakeup scheduling. It claims one job at a time, runs the recipe, writes results, and syncs.
- The queue is the source of truth; `send_message` is a nudge for immediacy. If no executor is online the button still works: the job waits, the tile shows "queued, start `/rampart watch`".

### 5.9 Safety and trust model

- **Authorization**: `project.json` carries the owner attestation; agents refuse any target not in the inventory. Infra probes are read-only and non-destructive (version, config, auth posture, exposed ports, TLS, image CVEs, safe unauthenticated-access checks). No brute force, no DoS, no exploitation that changes state.
- **Never auto-apply**: fixes are files on disk; `apply` is a separate job with its own confirmation, a backup, a health check, and rollback for infra.
- **Secrets**: never printed, never stored; env files on hosts are read into memory by the prober and reduced to flag names and classes.
- **Repository and host content is data, not instructions**: every agent prompt says so; text addressed to the scan is noted as a finding of its own kind (prompt-injection attempt), never obeyed.
- **Own systems only**: README and `SECURITY.md` state the trust model plainly, mirroring `claude-security` (no isolation layer; run inside sandbox-runtime for anything you do not trust).
- **Privacy on the dashboard**: private artifact; no credential values in the DB; findings quote locations and classes, not values.

### 5.10 Evolution

1. **Packs** (`packs/*.md`): front-matter with `name`, `version`, `appliesTo` (system types), `sources` (URLs with the date last read), `lastReviewed`; body with hunt classes (what to look for, how to confirm, how to disprove), baseline expectations ("good looks like"), and infra probe commands where relevant. `_template.md` sets the shape so contributors add packs by PR.
2. **`refresh-packs`**: `pack-curator` re-reads each pack's sources plus the vendor's security advisories and changelog, writes a proposed diff, and opens a PR on the plugin repo (or leaves a patch when the user cannot). Nothing changes silently.
3. **Feeds at run time**: trivy and native audits update their own databases; the weekly `schedule`d job matches each project's inventory (SBOM from the last L1, service versions from the last INFRA) against new advisories and vendor releases, and sets "re-audit recommended" on the tile.
4. **Eval loop**: every finding and disposition can be exported to `evals/cases/`; `evals` runs the suite with `claude plugin eval` before a pack, prompt, or model change is kept; the README states the policy: catch real bugs first, cut noise second.
5. **Additive runs**: the coverage ledger carries forward; hunts target units not yet covered or covered by an older pack version; stable IDs give trends.
6. **Project guidance**: `inventory` and dispositions generate `.claude/claude-security-guidance.md` and `.claude/security-patterns.yaml` for each repo, so the `security-guidance` plugin and `claude-security` learn the project's own rules.

### 5.11 `rampart-lite`

A single skill directory, no plugin machinery, no store, no dashboard, no Claude-specific tool names.

- `SKILL.md`: triggers ("rampart-lite", "quick security review", "security review this diff/path/system"); modes `diff`, `path`, `pr`, `system`; the phase list: scope and owner confirmation → five-minute threat model (trust boundaries, assets, STRIDE) → L1 if tools exist (gitleaks, trivy, native audit) else manual equivalents (grep patterns for secrets, lockfile review) → pack-guided hunt from `packs-condensed.md` → **verification pass in a fresh context** (a subagent where the host supports it; otherwise an explicit second pass that re-reads the code with instructions to disprove each candidate, written before any report) → report.
- Output: `RAMPART-LITE-REPORT.md` (report-template.md) and `rampart-lite-findings.jsonl` in the finding schema, so `/rampart import` can pull it into the full record.
- Sizing: SKILL.md under 500 lines; references hold the bulk. Written for an agent that may have only read, grep and shell.
- Shared the same way other cross-agent skills are: `npx skills add <repo> --skill rampart-lite`, plus a short `AGENTS.md` snippet in the README for agents that read that file.

## 6. Constraints

- Platforms: Windows (PowerShell primary), macOS, Linux. Scripts are Node ≥ 18 with zero dependencies (`.cjs`) for cross-platform paths; `python3` is only needed when `claude-security` is used.
- External tools are optional and detected: gitleaks, trivy, gh, ssh, npm/pnpm/yarn. `doctor` states what degrades.
- The Workflow tool and the artifact dashboard need a claude.ai plan; everything else works with an API key, with the static dashboard.
- The author's environment specifics (host addresses, SSH users, compose project names, where secrets live, local paths) belong in his private `project.json`, never in this repository, including this document. The repository is public from its first push.
- Model: hunts and verification run on the session's model; mapping and curation on sonnet. Follow the memory rule for subagents: Opus on high effort, Sonnet or Haiku for mechanical work.

## 7. Decisions already made (as decided in conversation)

- Public, shareable plugin, not a personal script (Pedro).
- Inventory first, saved per user or per project (Pedro).
- Dashboard as a tile/carousel over projects showing systems, last scan/review dates, and a score sheet; interactive buttons that dispatch agents to diagnose, fix and report (Pedro).
- Three-level framework plus separate verification, from the video and the Anthropic review post (Pedro's brief).
- Evolution through versioned packs with sources, a refresh job that proposes PRs, live feeds, and an eval set from past findings (Claude proposed, Pedro accepted).
- `rampart-lite` as a portable, session-scoped, cross-agent skill (Pedro).
- v1 packs: Next.js/Node web app, Node API, Expo mobile, Supabase, n8n, Docker Compose host, Cloudflare Workers, WordPress on Hostinger (Claude proposed, Pedro accepted).

**Claude's calls (change freely)**: the name Rampart; Node for scripts; `~/.rampart` store layout; score formula and finding classes; local executor by default with cloud opt-in per project; apply-as-separate-job with backup and rollback; Rampart's own pipeline as the engine for unattended runs, `claude-security` offered for attended ones; the dashboard DB as the master record with local stores as caches; owner-only job creation with a click counting as confirmation for read-only jobs and a typed confirmation for `apply`; job queue in the artifact DB with `send_message` as a nudge.

## 8. What is left to the builder

- Exact prompts for each agent and the wording of each job recipe (follow `claude-security`'s front-desk style and `role.md` conventions).
- The dashboard's visual design (follow the artifact-design skill; phone width; light and dark).
- Pack contents for the eight v1 system types (start from the sources listed in each pack's front-matter: OWASP Top 10 2025, OWASP LLM Top 10 2025, ASVS, CIS Docker, vendor security docs for n8n, Supabase, Cloudflare Workers, WordPress, Expo).
- Headers rubric details (Observatory-style weights) and the exact gitleaks/trivy flags.
- Eval fixtures: at least three tiny apps (IDOR, missing tenant filter on export, hardcoded key in history) and one infra fixture (compose file with an exposed admin port).
- How `watch` keeps itself alive politely (wakeup interval, backoff, idle shutdown).

## 9. Phasing

- **v0.1**: plugin skeleton and front desk; `inventory`; L1 scripts with secrets triage and per-package grouping; store, normalize, score with finding classes, static dashboard; artifact dashboard with tiles, detail, dispositions, owner-only Run buttons with cost shown (cloud via `create_session`, local via queue + `watch`); Rampart's own hunter → verifier pipeline for L2 and L3 covering general and logic-bug classes, with `claude-security` hand-off and import for attended runs; `infra-prober` read-only for docker-host, n8n, supabase; eight packs; `doctor`; `rampart-lite`; evals skeleton with three fixtures.
- **v0.2**: `fix` for code with `patch-reviewer`; `refresh-packs`; weekly feeds and re-audit badges; trends and sparklines; `import`.
- **v0.3**: infra `fix` and `apply` with backup and rollback; contributor guide for packs; eval expansion from dispositions; project guidance file generation.

## 10. First inventory

The author's first inventory (four projects: two Next.js sites, an Expo app with a self-hosted Supabase, and a Docker host running n8n and other services) is built by the `inventory` job into his private `~/.rampart` and is deliberately not part of this repository. It is the acceptance test for v0.1: all four projects on tiles, every system with at least one L1 or INFRA run, and one button-launched job completed end to end on the local executor.

## 11. Review notes

A builder-check review (2026-10-23) raised five questions; all were settled in this revision: dashboard clicks and authority (§5.7 Confirmation and authority), `claude-security` not starting unattended (§5.5 Reuse rule), multi-machine record of truth (§5.7 Record of truth), L1 results and scoring (§5.4 Finding classes, §5.6), and private details in a public repository (§6, §10, and the examples now use documentation addresses and placeholders).
