# Job: dashboard — every project's score sheet as a page

The dashboard shows one tile per project (grade, score, open findings by severity, systems and the freshness of each layer) and a detail view per project. This version renders it as a static HTML file from the store; it spends no model tokens.

## Arguments

- `--static`: write the static page and open it. This is the only form in this version.
- No flag, or a request to publish, share or sync the dashboard on claude.ai: the live artifact dashboard arrives with Plan 3. Say so in one line, then do the static render below.

## Static

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/render-static.cjs" --open`. It prints the path it wrote (`dashboard.html` in the store) and hands the file to the system's opener.
2. Exit 0: give the user the path. If stderr has a note that the opener failed, add that the page did not open by itself and they can open the path in a browser. Exit 1 (a store file it cannot read): relay its one line, which names the file, and stop; never edit store files by hand. Exit 2: relay the line.
3. Tell the user, briefly: the page is a snapshot of the store as of now, and every inventory and audit rewrites it; its buttons copy a `/rampart` command to paste here rather than run anything; and a page that shows "No data yet" means no project is inventoried, so `/rampart inventory` comes first.

The render is the job itself: there is no separate score step, because the page computes each project's score as it renders.

## Artifact

Arrives with the live dashboard (Plan 3): publishing the page on claude.ai, syncing its database both ways, and the job queue its buttons will write.
