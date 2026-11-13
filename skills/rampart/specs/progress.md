# Job progress

The dashboard's activity panel shows the job that is running now, or the last one that ran, as a progress bar and a checklist of its steps. It reads one progress document per project. `scripts/progress.cjs` writes it; the recipe that runs the job hands each version to the live dashboard's database. Schema: [progress-schema.json](progress-schema.json).

## Where it lives

- **Store.** `<store>/projects/<slug>/progress.json`, written whole through `lib/atomic.cjs`. A new job replaces the last one's document: only the latest job is kept.
- **Live dashboard.** `progress/<slug>`, the same document. The recipe writes it with `ArtifactData set`, `data` the JSON `progress.cjs` printed, at each point listed under Wiring. The collection has the same rule as every other (`read: view`, `write: owner`, [db-rules.json](db-rules.json)). It is never pulled, and the sync never pushes it.
- **Static page.** `render-static.cjs` puts the store's document on the project's entry as `progress`. A static page is a snapshot, so a running job there reads "was running when this page was made", never as live.

## Fields

| Field | Meaning |
|---|---|
| `project` | The slug. |
| `job` | `audit`, `inventory` or `verify`. |
| `layer`, `system` | The audit's layer and system; `null` when the job has none or covers every system. |
| `runId`, `jobId` | The run directory, once known, and the dashboard job a watch session is answering, if any. |
| `title` | One plain line, such as "Deep review: Example Expo app". |
| `state` | `running`, `done` or `failed`. |
| `startedAt`, `updatedAt`, `finishedAt` | ISO times. Every write stamps `updatedAt`. |
| `staleAfterSec` | How long the page waits for the next write before it calls the job stopped (900). |
| `overall` | `{done, total, percent}`: steps finished out of all steps, and a 0 to 100 figure that also credits a running step's counts. |
| `steps` | The ordered checklist: `{id, label, status, done, total, unit, note}` plus `startedAt` and `finishedAt` once set. `status` is `pending`, `running`, `done`, `skipped` or `failed`. `done` and `total` are counts when the step has them (hunters returned, possible problems double-checked), `unit` names what they count in the dashboard's words ("AI reviewers", "possible problems"), `note` is one line from the recipe ("gitleaks is not installed"). |

Labels are fixed text in `progress.cjs`. Notes are the recipe's own words, redacted and cut to 200 characters. Nothing read from a repository, a finding or an agent reply goes in the document.

## The step lists

- **L1**: per system in scope, `secrets:<system>` and `deps:<system>` when it has a repo, `headers:<system>` when it has a live URL; then `triage`, `score`, and `sync` when the job was started with `--live`.
- **L2, L3**: `plan`, `hunt`, `verify`, `assemble`, `report`, `score`, `sync`.
- **INFRA**: `probe`, `compare`, `verify`, `assemble`, `report`, `score`, `sync`.
- **inventory**: `scan`, `map`, `questions`, `save`, `score`, `sync`.
- **verify**: `plan`, `verify`, `assemble`, `score`, `sync`.

`sync` is planned only with `--live` (the project has a published dashboard).

## Hunt counts

`progress.cjs hunt --project <slug> --run <runId>` counts files in the run directory and sets the `hunt` step (INFRA: `compare`) and the `verify` step:

- Planned hunters (the AI reviewers) are `units.json` `hunters[].key`: `<group>__<bundle>` (`g03__b1`) since 0.5.0, `<unit>__<class>` in older runs, `<system>__infra-prober` for INFRA (a run with no hunters listed falls back to that prober name). A hunter has returned when `candidates/<fileKey(key)>.json` exists.
- Units planned without a hunter, `unchanged` since their last review or `not-hunted` (all their source over the size cap), are counted from `units.json` `units[].status` and named in the hunt step's note ("2 areas of code unchanged since the last review skipped; 1 too large to read"). Nothing else in `units.json` is read, so a planner that adds fields changes nothing.
- Possible problems are the entries of the candidate files (their `ref`, else their position). One has been double-checked when a `votes/<fileKey(key)>__<ref>__<n>.json` names it, with refs `c1` to `c20` as hunt-io allows.
- A verify run has no `units.json`; its one-entry candidate files are written up front, so `hunt` sets only its `verify` step.
- Anything unreadable counts as nothing. A hunt step whose hunters have all returned stays `running` until the recipe marks it `done`.

## Staleness

The page compares `updatedAt` with its own clock. A `running` document older than `staleAfterSec` shows as "Stopped responding" with the time of the last update and a line that the session running it may have closed, and the bar stops moving. The page re-checks once a minute, so a job that goes quiet turns stale without a new write. A document written later brings it back to running.

## Nothing running

With no running document, the panel shows the last job's finished checklist with when it finished ("Finished 2 hours ago") and how it ended. With no document at all, it says that a check started from here or from Claude Code will show its steps there as it runs, and while a dashboard job is queued but has not started, that it is waiting for the runner.

## Wiring

The rules live once, in the Job progress section of the dashboard recipe (`skills/rampart/jobs/dashboard.md`), and the job recipes point at it. Each `progress.cjs` call prints the document. A write happens only when `store.cjs dashboard --json` shows a `url` and the session has `ArtifactData`, and is one `ArtifactData set` on `progress/<slug>` with `data` the printed JSON, verbatim. Writes are pinned, as every dashboard write is: the first write of a job does one `ArtifactData get progress/<slug>` and passes its version as `if_version` (no pin when the document is absent), and each later write passes the version the previous one returned. A write refused on the version gets one fresh `get` and one retry. A failed progress command or write is never a failure of the job: it is one line in the summary, the job makes no more writes, and the commands still run for the static page. `start` takes `--live` exactly when there is a `url`. Commands with nothing slow between them share one write, of the last one's output, since each write costs the session a tool call.

Where each job reports:

- **audit L1** (`audit.md`): `start` once the project and its systems are settled; each check's step `running` before it and `done`, `skipped` or `failed` with a short note after; `triage`; `score`; `sync`; `finish`.
- **audit L2, L3, INFRA**: `start` per system (each replaces the last, and only the last system's document reaches score, sync and finish); `plan` (INFRA: `probe`) around init; during a workflow, `progress.cjs hunt --run <runId>` after every 4th `wait.cjs` return and after each batch; `hunt` (INFRA: `compare`) and `verify` closed after the last batch; `assemble`; `report`; `score`; `sync`; `finish`, failed with a note when the run failed.
- **verify** (`verify.md`): `start` per system; `plan` around init-verify; `hunt --run` after each round of up to five verifiers; `assemble` around reverify; `score`; `sync`; `finish`.
- **inventory** (`inventory.md`): `start` once the scan has named the slug; `map`, `questions`, `save`, `score`, `sync`, `finish`. For a project the store does not hold yet only the finish is written, after the sync has put the project on the page.
- **watch** (`watch.md`) adds `--job-id <id>` to the `start` of the recipe it runs.
- A claude-security import reports nothing.
