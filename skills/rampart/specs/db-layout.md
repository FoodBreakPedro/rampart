# Dashboard DB layout (implemented in Plan 3)

The live dashboard is a private claude.ai artifact whose database holds the record the page renders and the job queue its buttons write. Nothing here exists in this version: the static dashboard reads the local store directly.

## Collections

- `projects/<slug>`: the project's inventory mirror (`project.json`) plus its latest score.
- `projects/<slug>/systems/<id>`: one system, with its layers, last run per layer, next due dates and score.
- `findings/<id>`: one finding record (`finding-schema.json`), keyed by its stable 12-hex id, with its status.
- `runs/<id>`: a run summary only (job, systems, layers, status, counts, skip reasons, the report text as `reportMd`); raw tool output never leaves the machine.
- `jobs/<id>`: one queued job (`job-schema.json`), with `createdBy`, `confirmedAt` and `costShown`.
- `executors/<sessionId>`: a registered executor (a local `watch` session or a cloud session) and its heartbeat.
- `packs/<name>`: an installed pack's version and `lastReviewed` date.
- `meta/sync`: when and from which machine each sync direction last ran.

## Rules

- Read access for signed-in viewers. Writes to `jobs`, dispositions and `projects` are owner-only (`write: "owner"`), so sharing the dashboard never lets a viewer queue work against the owner's machines. The spec lists dispositions among the owner-only writes but not as a collection: Plan 3 decides whether they are fields of `findings/<id>` or a collection of their own.
- The artifact is private by default. No credential value is ever written to it: findings carry locations and classes, not values.
- When the dashboard exists, its DB is the master record for findings, runs, dispositions and jobs, and every local store is a cache plus the raw output of its own runs. Per document, the last writer wins on `updatedAt`, except that a disposition the person made in the page always beats an automated status change.
- A click in the page confirms a read-and-report job (`audit`, `verify`, `inventory`, `fix` drafting) only when the page showed the cost before queueing it. `apply` needs a second, typed confirmation naming the finding, recorded the same way.

## Carry-forward

Before DB sync validates documents against the schemas, `finding-schema.json` and `job-schema.json` need an `updatedAt` field, and `job-schema.json` needs the fields that record `apply`'s second confirmation. Neither schema has them today.

## Run directory (local store)

Not part of the dashboard DB: what one run leaves on the machine that ran it, under `~/.rampart/projects/<slug>/runs/<run-id>/`. Agents write one file each, so parallel agents never append to a shared file; hunt-io rewrites each file in its stored, redacted form when it ingests it.

- `run.json`: the run summary (`run-schema.json`): job, layers, systems, status, counts, revision.
- `units.json` (L2, L3, INFRA): the plan `hunt-io.cjs init` wrote (layer, effort, system, units, classes, hunters), with each unit's `status` (`covered`, `failed`, `skipped`) and `reason` added by `assemble`.
- `candidates/<hunterKey>.json`: one JSON array per hunter (`[]` when it found nothing), `hunterKey` = `<fileKey(unit)>__<classId>`; for INFRA one file per system, `<fileKey(system)>__infra-prober.json`. Stored form: `candidate-schema.json`.
- `votes/<hunterKey>__<ref>__<n>.json`: one JSON object per verifier vote (`vote-schema.json`).
- `observations.json` (INFRA): what each probe printed, scrubbed, and the probes skipped with their reasons; `raw/probe-<id>.txt` holds each probe's scrubbed output.
- `findings.json`: `{verified, closed, rejected, undecided}`: the ids this run upserted as verified and the ids it closed, and the candidate ids the verifiers rejected or left undecided (never findings), written by `assemble`.
- `invalid.json`: agent entries hunt-io could not use, with the reason (never their content).
- `REPORT.md`: the human report (`report-spec.md`).
- `verify.json` (verify runs): the findings re-judged and the outcome of each; their one-element `candidates/<id>__verify.json` and `votes/<id>__verify__c1__1.json` follow the same names.
- `raw/`: tool reports (L1), redacted before they are written.

`fileKey(id)` replaces every character outside `A-Z a-z 0-9 . _ -` with `+`.
