# Dashboard DB layout

The live dashboard is a private claude.ai artifact whose database holds the record the page renders and the job queue its buttons write. The static dashboard (`--static`) reads the local store directly and does not use any of this. `db-rules.json` is the exact value handed to the Artifact tool's `capabilities.db.rules`.

## Collections

Every document is a JSON object. The ones both the page and a sync can change (`projects`, `findings` and `jobs`) carry an `updatedAt` ISO string, and a conflict between them is settled on it as Record of truth below says; run summaries and executor registrations carry one as a record of when they were written; `meta/sync` and `meta/owner` have none.

- `projects/<slug>`: the project's inventory mirror (`project.json`) without its private fields (`ownerAttestation`, `repo.paths`, `host.ssh` beyond its hostname, `live.url` query strings), plus its latest score. Systems live inside this document as `systems[]` (layers, last run per layer, next due dates, score); there is no `projects/<slug>/systems/<id>` collection. The store's `updated` stamp is sent as `updatedAt`. The page may write the settings `cloudAllowed`, `defaultExecutor`, `huntEffort` and `cadenceOverrides: {<systemId>: {<layer>: days}}`; a pull applies them to `project.json` when the doc's `updatedAt` is newer than the project's `updated`.
- `findings/<id>`: one finding (`finding-schema.json`), keyed by its stable 12-hex id. A person's decision is the field `disposition: {status, reason, by, at} | null` on this document, where `status` is one of `open`, `fixed`, `false_positive`, `accepted_risk`. `dispositions.json` stays the local cache of the same decisions.
- `runs/<runId>`: a run summary only (`run-schema.json`: job, systems, layers, status, counts, skip reasons, and the report text as `reportMd`). Raw tool output never leaves the machine, and the text has no local folder (a checkout reads `<repo>`, the store `<store>`, the home folder `~`) and no URL query or fragment.
- `jobs/<id>`: one queued job (`job-schema.json`). It records `createdBy`, `confirmedAt`, `costShown` and `costEstimate: {agents, note}`; `executorKind` (`local` or `cloud`) says where it runs; an `apply` job also carries `applyConfirmation: {typed, at}`; `claimedBy`, `claimedAt`, `startedAt`, `finishedAt`, `resultSummary`, `runId` and `sessionId` are filled as it progresses.
- `executors/<sessionId>`: a registered executor session, `{kind: 'local' | 'cloud', machineId, heartbeatAt, remoteControl: boolean}`.
- `packs/<name>`: an installed pack's version and `lastReviewed` date.
- `meta/sync`: `{[machineId]: {pushedAt, pulledAt, pushCursor, pullCursor}}`, when and from which machine each sync direction last ran.
- `meta/owner`: `{ownerId, at}`. The page writes it once, when the owner opens it and the document is absent (`ownerId` is `await user.id()`). The publish recipe reads it into `config.json` as `dashboard.ownerId`; executors refuse to run jobs until the owner id is known.

## Rules

`db-rules.json` is an array: a root rule plus one rule per collection (`projects`, `findings`, `runs`, `jobs`, `executors`, `packs`, `meta`), each `{"read": "view", "write": "owner"}`.

- Signed-in viewers can read everything. Only the owner can write anything: jobs, dispositions, project settings and executor registrations alike, so sharing the dashboard never lets a viewer queue work against the owner's machines. Executors register as the owner's own sessions.
- The root rule is the only one `user.can("data.write")` reflects, so the page renders write controls only when `isOwner()` is true and `can("data.write") !== false`; a null user is read-only.
- The artifact is private by default. No credential value is ever written to it: findings carry locations and classes, not values.

## Record of truth

When `config.json` holds a dashboard URL, the DB is master for `findings`, `runs` (summaries), dispositions, `jobs` and `projects`, and every local store is a cache plus the raw output of its own runs. Per document the later `updatedAt` wins, except that a person's decision in the page (`by` is a user id) beats Rampart's own automated status changes (`by` is `rampart`) as the sync script rules: `accepted_risk` and `false_positive` from the page always stand, while a page `fixed` or `open` gives way to an automated change made after it (a later scan is new evidence).

## Jobs and confirmation

- A click in the page confirms a read-and-report job (`audit`, `verify`, `inventory`) only when the page showed the cost first; `costShown` and `costEstimate` record it. `fix` and `apply` arrive later: the buttons exist, disabled with that note.
- `apply` needs a second, typed confirmation naming the finding, recorded in `applyConfirmation: {typed, at}`. `null` means not yet given.
- Executors run only jobs whose `createdBy` is the owner id and fail the rest with `resultSummary: 'not created by the owner'`.
- A job on a system with `executor: 'local'` never gets `executorKind: 'cloud'`.

## Writing and claiming

- Writes go through `ArtifactData`. A batch entry is `{op, collection, doc_id, data, if_version?}`, at most 50 entries per batch. `if_version` is set when the document's version is known from a read made just before the push, so a stale push loses instead of overwriting.
- A claim is compare-and-swap: `get jobs/<id>`; if `status === 'queued'`, `update` it with the claim patch and `if_version` set to the version just read. A version conflict means another executor won the race: skip the job.
