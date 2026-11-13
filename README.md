# Rampart

**A security check-up for everything you run, inside Claude Code.**

Rampart is a Claude Code plugin for solo developers and small teams who look after several apps, sites and servers. It checks your code and your servers for security problems, keeps a record of what it found and when, gives each project a score, and shows it all on one dashboard.

It only reads and reports. It never changes your code, your settings or your servers.

> Status: early alpha (`0.5.0-alpha.1`). It works, but expect rough edges. Please report bugs in Issues.

## What it checks

Rampart works in four layers. You pick which ones to run, and when.

| Layer | Plain name | What it does | Costs AI tokens? |
|---|---|---|---|
| **L1** | Basic checks | Looks for passwords and keys anywhere in your git history (with [gitleaks](https://github.com/gitleaks/gitleaks)), known holes in your dependencies (with [trivy](https://trivy.dev/), or the npm/pnpm audit), and grades the security headers of your live site. | No. Plain scripts. |
| **L2** | Change review | AI agents review what a branch changed, before you merge it. | Yes |
| **L3** | Deep review | AI agents read your whole repository looking for logic bugs: users seeing other users' data, broken sign-in, unsafe exports. Later runs only re-read what changed. | Yes, the most |
| **INFRA** | Server check | Read-only checks on a server you host yourself (Docker, Supabase, n8n, WordPress), over SSH or HTTP. Agents compare what they see with a known-good setup. | Yes |

Every problem an AI agent reports is re-checked by separate agents whose job is to prove it wrong. Only problems that survive that check show up as findings, so you see fewer false alarms.

The rules for each kind of system (Next.js, Expo, Supabase, Cloudflare Workers, n8n, Docker hosts, WordPress, static sites, Node APIs) live in plain Markdown files in [`packs/`](packs/), so you can read exactly what Rampart looks for.

## What it costs

- **Basic checks (L1)** cost nothing beyond your machine's time.
- **Agent checks (L2, L3, INFRA)** use Claude, so they count toward your Claude plan's usage or your API bill. Before anything runs, Rampart shows an estimate for low, medium and high effort and waits for you to pick one. Nothing starts without that.
- **A rough idea:** in testing, a low-effort run of every agent check on a small sample project cost about $4 in API usage. A large repository at medium or high effort costs much more. Start with low effort on your smallest project.

## What it touches

- **Your files:** read only. Results go to a folder in your home directory, `~/.rampart` (change it with `RAMPART_HOME`).
- **Your servers:** only the hosts and URLs you list, with read-only commands. No brute force, nothing that changes a server.
- **The internet:** the dependency check asks the npm registry or downloads trivy's database; the header check visits each live URL once.
- **Claude:** like any Claude Code work, the agent checks send the code and server output they read to Claude.
- **Secrets:** Rampart never prints or stores a password or key's value. A finding names the file, commit and kind of secret only.

Only use it on systems you own or are allowed to test. Rampart asks you to confirm that for each project, and refuses anything you have not listed.

## Before you install

You need:

- **Claude Code.** The live dashboard also needs a claude.ai account.
- **Node 20 or newer.** (Running the test suite on Windows needs Node 21 or newer.)
- **gitleaks and trivy**, for the basic checks. Without gitleaks the secrets check is skipped; without trivy Rampart falls back to the npm or pnpm audit.

  On macOS or Linux with Homebrew:

  ```
  brew install gitleaks trivy
  ```

  On Windows or other systems, see the [gitleaks install steps](https://github.com/gitleaks/gitleaks#installing) and the [trivy install steps](https://trivy.dev/docs/latest/getting-started/installation/).
- **git**, and **ssh** if you want server checks over SSH (key-based login).
- **Dynamic workflows turned on**, for the agent checks. Open `/config` in Claude Code; if you see a "Dynamic workflows" row, turn it on and restart Claude Code.

## Install

Add this repository as a plugin marketplace, then install the plugin from it:

```
/plugin marketplace add FoodBreakPedro/rampart
/plugin install rampart@rampart
```

## Your first run

Rampart works best in auto mode: press Shift+Tab until the status bar shows auto mode, or start Claude Code with `claude --permission-mode auto`.

1. **Check your setup.** Rampart tells you which tools it found and what it will skip without the others.

   ```
   /rampart doctor
   ```

2. **Add a project.** From inside a project's folder, Rampart maps what is in it (a website, a mobile app, a database...) and asks you to confirm it is yours to test.

   ```
   /rampart inventory
   ```

3. **Run the basic checks.** Use the short name ("slug") the inventory gave the project.

   ```
   /rampart audit L1 --project <slug>
   ```

4. **See the score.** This writes a local web page with every project's score and findings.

   ```
   /rampart dashboard --static
   ```

5. **Go deeper when you are ready.** Rampart shows the cost first and asks.

   ```
   /rampart audit L3 --project <slug>
   ```

Typing `/rampart` on its own opens a short menu.

## Other commands

- `/rampart audit L2 --project <slug>`: review the current branch's changes.
- `/rampart audit INFRA --project <slug>`: check a server you listed in the inventory.
- `/rampart verify`: re-check open findings against the current code and close the ones that are fixed.
- `/rampart dashboard`: publish a private live dashboard on claude.ai, where you can mark findings (fixed, false alarm, accepted risk) and queue jobs. `--sync` keeps it in step with your local record.
- `/rampart watch`: run the jobs you queued from the live dashboard.
- `/rampart schedule`: a weekly sync plus any basic checks that are overdue.

Each agent run also writes a plain `REPORT.md` in its run folder.

## Where your results live

```
~/.rampart/
  projects/<slug>/
    project.json        # what the project contains, and your confirmation that it is yours
    findings.jsonl      # one finding per line
    dispositions.json   # what you decided about each finding
    scores.jsonl        # score history
    coverage.json       # what each deep review covered, and when
    runs/<run-id>/      # each run's raw (redacted) output and REPORT.md
  dashboard.html        # the local dashboard
```

Everything is plain JSON you can read, search and diff. There is no Rampart server or account.

## How it fits with other tools

| Tool | Good at | Leaves out |
|---|---|---|
| `/security-review` (built into Claude Code) | One pass over the current branch's changes | The rest of the repository, servers, git history, dependencies |
| `claude-security` plugin | A verified multi-agent scan of a repository | Servers, secrets in history, dependency holes |
| Code Review | Reviews at pull-request time | Pull requests only, no servers |

Rampart sits on top: one record and one score across all your projects. If you use `claude-security`, Rampart can import its results (`/rampart audit L3 --project <slug> --import`).

## Coming next

- Suggested fixes, each checked by independent reviewers, that you apply yourself.
- A lighter, portable version of the skill.
- Tests that measure how many real problems the hunts find.

See [CHANGELOG.md](CHANGELOG.md) for what changed in each version.

## Development

Load a local checkout for one session instead of installing it:

```
claude --plugin-dir "<path to your rampart checkout>"
```

Run `npm test` before a pull request, and `npm run validate` when you change `.claude-plugin/`, the skill or the agents. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Safety and license

There is no sandbox: Rampart runs with your Claude Code session's permissions. For projects you do not trust, run the session inside [sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime).

To report a security problem in Rampart itself, see [SECURITY.md](SECURITY.md). MIT license, see [LICENSE](LICENSE).
