# Job: doctor — what this machine has, and what degrades without it

Reports the tools, plugins, store and engines Rampart will use here. It reads only, changes nothing, and spends no model tokens.

## Steps

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.cjs" --json`. It exits 0 whatever it finds; on any other exit, relay its stderr line and stop.
2. Explain the report in plain words, short, in this order:
   - **Node**: `node.version`, and whether it meets Rampart's minimum (`node.ok`; Node 20 or newer).
   - **Tools** (gitleaks, trivy, python3, gh, ssh, git): for each, found with its version; or, when `found` is true and `version` is null, "found but could not be probed; check it"; or not found. For a tool that is missing, say what stops working, from its `degraded` sentence reworded plainly (gitleaks missing: the secrets history is not scanned; trivy missing: dependencies fall back to the npm or pnpm audit, and yarn projects are skipped). Installing it is the user's choice: name the tool, never install it.
   - **claude-security**: by `plugins.claudeSecuritySource`: `installed` or `settings` means installed; `marketplace` means available on disk, not necessarily enabled (say "available"); null means not found. It matters once L2 and L3 audits arrive (Plan 2): an attended audit you start at the terminal would hand off to it when present (`engines.l2l3Attended`); an unattended one always uses Rampart's own engine (`engines.l2l3Unattended`).
   - **Store**: `store.home`, whether it exists yet, and how many projects it holds. No projects: suggest `/rampart inventory`.
   - **Packs**: with `packs.count` 0, say the review packs arrive with the hunt engine (Plan 2), and that L1 needs none.
   - **Degraded**: every other line of `degraded` not already covered, in plain words.
3. Doctor changes no project, so it ends here: no score and no render. If everything was found, say so in one line.
