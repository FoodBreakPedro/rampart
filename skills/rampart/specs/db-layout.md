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
