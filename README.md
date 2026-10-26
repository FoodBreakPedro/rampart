# Rampart

Rampart is a Claude Code plugin for layered security and vulnerability reviews across all of your systems: code repositories, live sites, databases, automation servers, edge workers and self-hosted hosts. Good security tools already exist, but each covers one slice: a diff, a repository, a checklist. Nothing ties them together, nothing covers the systems that are not a repository, nothing remembers across runs, and nothing gives you one place to see what you have checked, when, and how bad it is. Rampart is that layer. It wraps the existing tools where they exist, fills the gaps (secrets history, dependencies, security headers, infrastructure probes, logic-bug hunts), records everything, scores it, and shows it on a dashboard.

The shape follows a three-level framework. Level 1, for every app: secrets over the full git history and the dependencies' known vulnerabilities, run regularly; Rampart also grades each live site's security headers at this level. Level 2, for every change: an agent security review of the diff. Level 3, for critical features and before launches: a deep multi-agent audit of authentication, billing, tenant isolation and data export. Each project gets one inventory listing its systems, which layers apply to each and where its jobs may run. Every finding has a stable id, so repeat runs dedupe and trends, regressions and time to fix stay visible. By design, a finding from a model hunt must survive a fresh-context verifier whose job is to disprove it, and a fix is drafted for you to review and apply, never applied for you. This alpha implements only part of this shape; see Status.

## Status

Pre-release. This alpha, `0.1.0-alpha.2`, covers:

- **inventory**: map a folder's systems into a project and record your owner attestation.
- **audit L1**: gitleaks over a repository's full history, trivy or the npm/pnpm audit on its lockfile, and a grade of each live URL's security headers; then the score.
- **audit L2**: an agent hunt of what a branch changed against its base branch.
- **audit L3**: a deep agent hunt of a whole repository, unit by unit and class by class.
- **audit INFRA**: the read-only probes of a self-hosted host's packs (Docker host, Supabase, n8n, WordPress), over SSH or HTTP, judged by agents against each pack's baseline.
- **verify**: re-check open hunt findings against the current code, closing the ones that no longer reproduce.
- **doctor**: which tools this machine has, and what degrades without them.
- **dashboard --static**: every project's score sheet as a local HTML page.

### The three layers and the hunt

Level 1 is pure scripts and costs no model tokens. Levels 2 and 3, and the INFRA probe, are agent runs driven by eight review packs (`packs/`): versioned Markdown files that say, per system type, what to look for, how to confirm it and how to disprove it.

- **L2 and L3** split the repository (L3) or the changed files (L2) into units, and run one `hunter` agent per unit and pack class through the `rampart:audit` workflow. Every candidate a hunter writes goes to fresh `verifier` agents told to disprove it from the code. It becomes a finding only when a majority of its verifiers confirm it, with two confirmations for anything HIGH or CRITICAL; rejected and undecided candidates stay in the run directory and are never shown.
- **INFRA** runs only the probes the system's host packs list (versions, configuration, auth settings, published ports, TLS), read-only, from your machine; it never runs from a cloud session. One `infra-prober` agent compares what they printed with the pack's baseline, and verifiers judge each candidate from the same observations.
- **The cost is shown before anything runs.** Each hunt first prints its plan without starting anything: the number of agent runs and a rough token figure for the low, medium and high efforts. You pick the effort, which accepts that cost, or answer one confirmation; nothing is dispatched without it. Low hunts the five logic-bug classes (record scoping, tenant isolation, bulk export, sessions, search injection) on reachable code; medium every class on reachable code; high every class everywhere.
- **claude-security**, when installed, is offered once when you start an L2 or L3 audit yourself at the terminal: you run its scan, then `/rampart audit L3 --project <slug> --import` records its findings. Anything unattended always runs Rampart's own pipeline.

L2, L3 and INFRA need Claude Code's Workflow tool: if `/config` shows a "Dynamic workflows" row, it must be on. Each run writes a `REPORT.md` in its run directory.

The rest of v0.1 arrives in more plans:

- **Plan 3, live dashboard and executors**: the claude.ai artifact dashboard with dispositions and Run buttons, the local `watch` executor and `schedule`.
- **Plan 4, rampart-lite, evals and the start of the fix flow**: the portable `rampart-lite` skill, `import`, evals run with `claude plugin eval`, and `fix` with an independent patch reviewer.

## Requirements

- Claude Code.
- Node 20 or newer for the scripts, which have no npm dependencies (Node 18 is past its end of life). Running the test suite (`npm test`) on Windows needs Node 21 or newer.
- Optional tools, detected at run time; `/rampart doctor` says what each one changes:
  - `gitleaks`: the secrets history check. Without it, that check is skipped.
  - `trivy`: the dependency check. Without it, Rampart falls back to the npm or pnpm audit, and yarn projects are skipped.
  - `git`: reading a repository's history and remote.
  - `ssh`: the INFRA probes of hosts reached over SSH (key-based, non-interactive). `gh`: used by jobs in later plans (pull-request reviews).
  - `python3`: needed only by the `claude-security` plugin, when you use it alongside Rampart.

## Install

The repository lives at https://github.com/FoodBreakPedro/rampart. The repository is its own marketplace (`.claude-plugin/marketplace.json`, named `rampart`, with the one `rampart` plugin at its root). Add it as a marketplace, then install the plugin from it:

```
/plugin marketplace add FoodBreakPedro/rampart
/plugin install rampart@rampart
```

On Claude Code 2.1.275 or later the same install works in one step:

```
/plugin install rampart --marketplace FoodBreakPedro/rampart
```

For development, load a local checkout for one session instead of installing it:

```
claude --plugin-dir "<path to your rampart checkout>"
```

To check both manifests the way a release does, run `npm run validate`. It validates `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` by their paths with `claude plugin validate --strict`; a bare `claude plugin validate .` checks only the marketplace once that file exists.

## Quick start

Rampart works best in auto mode (press Shift+Tab until the status bar shows it, or start with `claude --permission-mode auto`).

1. See what this machine has:

   ```
   /rampart doctor
   ```

2. From inside a project's folder, map its systems and give the owner attestation:

   ```
   /rampart inventory
   ```

3. Run the foundational checks on it (use the slug the inventory gave the project):

   ```
   /rampart audit L1 --project <slug>
   ```

4. Hunt deeper, when you are ready for the agent cost (Rampart shows it first and asks):

   ```
   /rampart audit L3 --project <slug>
   ```

5. Open the score sheet:

   ```
   /rampart dashboard --static
   ```

`/rampart` on its own opens a short menu of these jobs.

## What gets stored, and where

Everything lands in a per-user store, `~/.rampart`, as plain JSON and JSONL you can read, grep and diff. Set `RAMPART_HOME` to put it somewhere else.

```
~/.rampart/
  projects/<slug>/
    project.json        # the inventory and your owner attestation
    findings.jsonl      # one finding per line, keyed by its stable id
    dispositions.json   # fixed, false positive, regressed...: written by the secrets triage, by checks that close
                        # or reopen a finding, and by later versions
    scores.jsonl        # score snapshots, for trends
    coverage.json       # which units and probes each hunt covered, and when
    runs/<run-id>/      # run.json, plus raw/ tool reports, redacted before they are written; a hunt adds units.json,
                        # candidates/ and votes/ (one file per agent), observations.json (INFRA), findings.json and REPORT.md
  drafts/               # the inventory job's last draft of each project
  dashboard.html        # the static dashboard
```

The store stays on your machine; this version has no server or account of its own. The checks reach out only as their tools do: the npm or pnpm audit asks the registry about your dependency tree, trivy downloads its vulnerability database, and the headers check fetches each live URL once. The inventory mapper, the secrets triage, the hunters, verifiers and the infra prober are agent runs: like any Claude Code work, they send the file excerpts and probe output they read to Claude. The INFRA probes contact only the hosts and live URLs your inventory lists.

## Trust model

Rampart is for systems you own or are authorized to test: every audit needs your owner attestation in the project's inventory, and a job refuses any target the inventory does not list. There is no isolation layer: jobs run in your Claude Code session with your permissions, so run the whole session inside [sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime) for anything you do not trust. Credential values are never printed or stored: tool reports and probe output are redacted before they are written, a secrets finding names the file, commit and rule, never the value, and a host finding names the service and setting, never its value. Infrastructure probes are read-only and non-destructive: no brute force, no denial of service, nothing that changes a host's state.

## How it fits with other tools

| Tool | Covers | Misses |
|---|---|---|
| `/security-review` (built into Claude Code) | One pass over the current branch's diff | The whole repository, infrastructure, history, dependencies |
| `claude-security` plugin | Multi-agent verified scan of a repository or diff; reviewed patch files | Systems that are not code, secrets history, dependency CVEs, live hosts |
| `agent-skills:security-and-hardening` and `agent-skills:review` | Threat-model checklist (STRIDE, OWASP, LLM Top 10, supply chain, privacy) | Runs nothing; scoped to one change |
| `security-guidance` plugin | Reviews code as Claude writes it | Existing code, infrastructure |
| Code Review and ultrareview | Multi-agent review at pull-request time | Billed, pull requests only, not infrastructure |
| Cloudflare `security-audit` skill | Coverage-led hunt in six phases, with fresh verifiers and additive runs | One repository per run, no record across projects, no dashboard |

Rampart sits above these: one inventory and one scored record across every project and system, wrapping the tools that exist and filling the gaps. In this alpha it runs gitleaks, trivy and the npm/pnpm audit itself, its own hunter and verifier agents for L2, L3 and INFRA, and hands off to `claude-security` for an attended audit when you want it.

## License

MIT. See [LICENSE](LICENSE). To report a vulnerability in Rampart itself, see [SECURITY.md](SECURITY.md).
