# Rampart

Rampart is a Claude Code plugin for layered security and vulnerability reviews across all of your systems: code repositories, live sites, databases, automation servers, edge workers and self-hosted hosts. Good security tools already exist, but each covers one slice: a diff, a repository, a checklist. Nothing ties them together, nothing covers the systems that are not a repository, nothing remembers across runs, and nothing gives you one place to see what you have checked, when, and how bad it is. Rampart is that layer. It wraps the existing tools where they exist, fills the gaps (secrets history, dependencies, security headers, infrastructure probes, logic-bug hunts), records everything, scores it, and shows it on a dashboard.

The shape follows a three-level framework. Level 1, for every app: secrets over the full git history and the dependencies' known vulnerabilities, run regularly; Rampart also grades each live site's security headers at this level. Level 2, for every change: an agent security review of the diff. Level 3, for critical features and before launches: a deep multi-agent audit of authentication, billing, tenant isolation and data export. Each project gets one inventory listing its systems, which layers apply to each and where its jobs may run. Every finding has a stable id, so repeat runs dedupe and trends, regressions and time to fix stay visible. By design, a finding from a model hunt must survive a fresh-context verifier whose job is to disprove it, and a fix is drafted for you to review and apply, never applied for you. This alpha implements only part of this shape; see Status.

## Status

Pre-release. This first alpha, `0.1.0-alpha.1`, covers:

- **inventory**: map a folder's systems into a project and record your owner attestation.
- **audit L1**: gitleaks over a repository's full history, trivy or the npm/pnpm audit on its lockfile, and a grade of each live URL's security headers; then the score.
- **doctor**: which tools this machine has, and what degrades without them.
- **dashboard --static**: every project's score sheet as a local HTML page.

Scores read low on purpose in this alpha. Repo systems declare the L2 and L3 layers, which have no engine yet, so their coverage is capped and no project grades above C, even with zero findings. The cap lifts when Plan 2 ships the hunt engine.

The rest of v0.1 arrives in three more plans:

- **Plan 2, hunt engine and packs**: L2, L3 and INFRA audits with Rampart's own hunter and verifier agents, `verify`, the eight review packs, and the `claude-security` hand-off and import for audits you start at the terminal.
- **Plan 3, live dashboard and executors**: the claude.ai artifact dashboard with dispositions and Run buttons, the local `watch` executor and `schedule`.
- **Plan 4, rampart-lite, evals and the start of the fix flow**: the portable `rampart-lite` skill, `import`, evals run with `claude plugin eval`, and `fix` with an independent patch reviewer.

## Requirements

- Claude Code.
- Node 20 or newer for the scripts, which have no npm dependencies (Node 18 is past its end of life). Running the test suite (`npm test`) on Windows needs Node 21 or newer.
- Optional tools, detected at run time; `/rampart doctor` says what each one changes:
  - `gitleaks`: the secrets history check. Without it, that check is skipped.
  - `trivy`: the dependency check. Without it, Rampart falls back to the npm or pnpm audit, and yarn projects are skipped.
  - `git`: reading a repository's history and remote.
  - `gh` and `ssh`: used by jobs in later plans (pull-request reviews, infrastructure probes over SSH).
  - `python3`: needed only by the `claude-security` plugin, when you use it alongside Rampart.

## Install

`<owner>` is a placeholder until the repository's public home is settled. The repository is its own marketplace (`.claude-plugin/marketplace.json`, named `rampart`, with the one `rampart` plugin at its root). Add it as a marketplace, then install the plugin from it:

```
/plugin marketplace add <owner>/rampart
/plugin install rampart@rampart
```

On Claude Code 2.1.275 or later the same install works in one step:

```
/plugin install rampart --marketplace <owner>/rampart
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

4. Open the score sheet:

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
    runs/<run-id>/      # run.json, plus raw/ tool reports, redacted before they are written
  drafts/               # the inventory job's last draft of each project
  dashboard.html        # the static dashboard
```

The store stays on your machine; this version has no server or account of its own. The checks reach out only as their tools do: the npm or pnpm audit asks the registry about your dependency tree, trivy downloads its vulnerability database, and the headers check fetches each live URL once. The inventory mapper and the secrets triage are agent runs: like any Claude Code work, they send the file excerpts they read to Claude.

## Trust model

Rampart is for systems you own or are authorized to test: every audit needs your owner attestation in the project's inventory, and a job refuses any target the inventory does not list. There is no isolation layer: jobs run in your Claude Code session with your permissions, so run the whole session inside [sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime) for anything you do not trust. Credential values are never printed or stored: tool reports are redacted before they are written, and a secrets finding names the file, commit and rule, never the value.

## How it fits with other tools

| Tool | Covers | Misses |
|---|---|---|
| `/security-review` (built into Claude Code) | One pass over the current branch's diff | The whole repository, infrastructure, history, dependencies |
| `claude-security` plugin | Multi-agent verified scan of a repository or diff; reviewed patch files | Systems that are not code, secrets history, dependency CVEs, live hosts |
| `agent-skills:security-and-hardening` and `agent-skills:review` | Threat-model checklist (STRIDE, OWASP, LLM Top 10, supply chain, privacy) | Runs nothing; scoped to one change |
| `security-guidance` plugin | Reviews code as Claude writes it | Existing code, infrastructure |
| Code Review and ultrareview | Multi-agent review at pull-request time | Billed, pull requests only, not infrastructure |
| Cloudflare `security-audit` skill | Coverage-led hunt in six phases, with fresh verifiers and additive runs | One repository per run, no record across projects, no dashboard |

Rampart sits above these: one inventory and one scored record across every project and system, wrapping the tools that exist and filling the gaps. In this alpha it runs gitleaks, trivy and the npm/pnpm audit itself; the `claude-security` hand-off arrives with Plan 2.

## License

MIT. See [LICENSE](LICENSE). To report a vulnerability in Rampart itself, see [SECURITY.md](SECURITY.md).
