# Task 6 controller design (binding; implements rulings R2, R3, R4, R7, R8 of progress.md)

Later tasks build on exactly these names. Where this note and the brief differ, this note wins.

## Run directory (`<RAMPART_HOME>/projects/<slug>/runs/<runId>/`)

- `units.json` — written by `init`, updated by `assemble`:
  `{layer, effort, system, repoRoot|null, units: [{id, kind, files, reachable, status?, reason?}], classes: [{pack, packVersion, classId, title, text}], hunters: [{key, system, unit, classId, pack, packVersion}]}`.
  `status` ∈ `planned|covered|failed|skipped`, `reason` plain words (assemble fills both).
- `candidates/<hunterKey>.json` — a JSON array written by one agent (`[]` = nothing found).
- `votes/<hunterKey>__<ref>__<n>.json` — one JSON object written by one verifier.
- `observations.json` (INFRA, written by Task 10's runner): `{observations: [{probeId, via, ok, exitCode, durationMs, text, rawPath}], skipped: [{probeId, reason}]}`.

## Keys

- `fileKey(id)` = `id.replace(/[^A-Za-z0-9._-]/g, '+')` (exported; audit.js inlines the same regex).
- `hunterKey` = `<fileKey(unit)>__<classId>` for L2/L3; for INFRA a single hunter per system: `<fileKey(system)>__infra-prober` whose planned units are every probe unit.
- `candidateRef` = `<hunterKey>#<ref>`; `ref` matches `^c([1-9]|10)$` (at most 10 per hunter).

## Raw (agent-written) forms → stored forms

Raw candidate (hunter/prober writes): `{ref, classId, title, severity, confidence, cwe[], location, evidence, exploitScenario, preconditions, recommendation, flags?: {prompt_injection?: true}}`. `location` = `{path, symbol}` (code, path repo-relative POSIX, no leading `/`, no `..` segment, no drive letter) or `{host, service, setting}` (INFRA). Any `system`, `layer`, `pack`, `packVersion`, `hunter`, `candidateId` an agent writes is ignored and overwritten from the `units.json` hunter entry (never trust agent-claimed scope).
Stored candidate (candidate-schema.json): the plan's fields — `{candidateId, system, layer, pack, packVersion, classId, title, severity, confidence, cwe, location, evidence, exploitScenario, preconditions, recommendation, hunter: {agent: hunterKey, unit}, flags, ref}` with `candidateId = findingId({project, system, ruleId: '<pack>/<classId>', location})` (lib/id.cjs; for prompt-injection candidates ruleId `rampart/prompt-injection-attempt`).
Raw vote: `{candidateRef?, verdict, severity?, confidence?, reason}`; hunt-io takes the ref and n from the file name (a body `candidateRef` that disagrees → vote invalid). Stored vote (vote-schema.json): `{candidateId, verifier: 'verify:<candidateRef>:<n>', verdict, severity?, confidence?, reason}`.

`writeCandidate(slug, runId, hunterKey, rawArray)` / `writeVote(slug, runId, fileName, rawVote)` exist for tests and for agents' files being normalized; `ingest(slug, runId)` normalizes every file in candidates/ and votes/ in place (atomic rewrite, redacted, value-like evidence replaced) and returns `{candidates, votes, invalid: [{file, reason}]}`. `readCandidates`/`readVotes` return stored forms (ingesting first is the caller's job; assemble does it).

## Redaction (Review Focus 1)

- Every text field (title, evidence, exploitScenario, preconditions, recommendation, vote reason) → `redact()`.
- `evidence`: if `redact()` changed it, or it contains a JWT-shaped string, or a token ≥ 20 chars matching `[A-Za-z0-9+/=_-]{20,}` with Shannon entropy ≥ 3.5 bits/char, the whole evidence becomes `[REDACTED] (value-like text removed by rampart)`.
- Other text fields: such tokens are replaced inline with `[REDACTED]` after `redact()`.
- `location.symbol`/`setting`/`service`: same inline replacement.
- Prompt injection heuristic (sets `flags.prompt_injection`): title or evidence matches `/\b(ignore (all|any|previous|prior)|disregard (the|all|previous)|you are (now )?(an?|the) |as an ai|system prompt|mark (this|it) as (safe|clean|fixed)|do not (report|flag)|report (no|nothing)|this (file|code) is (safe|secure))/i`.

## Tally (R7, exact)

Votes per candidateId = union over duplicates (deduped by verifier label). Let `n` = votes, `c` = confirmed, `r` = rejected. Bar severity = the hunter's severity (max over duplicates).
- verified iff `c > n/2` and `c ≥ 1` and (bar ∈ {HIGH, CRITICAL} ⇒ `c ≥ 2`).
- rejected iff `r > n/2`.
- otherwise undecided (incl. zero votes, ties, lone unsure).
- severity = min over confirming votes that carry a severity when ≥ 2 do, else the hunter's; confidence = min(hunter's, each confirming vote's confidence when present).
`tally(candidates, votes) → {verified: [{candidate, votes}], rejected: [...], undecided: [...]}` (votes = all votes of that candidate; fromHunt gets the confirming ones).

## fromHunt (normalize.cjs)

`fromHunt(candidate, confirmingVotes, ctx = {project, runId, now?, totalVotes})`: finding-schema fields; `id = candidate.candidateId`; `layer`, `system` from candidate; `source` `infra-probe` if layer INFRA else `rampart-hunter`; `pack '<pack>@<version>'`; `ruleId '<pack>/<classId>'`; `class 'verified'`; `verification {verifiers: totalVotes, confirmed: confirmingVotes.length, run: runId}`; status `open`; `externalIds {claudeSecurityPluginFindingId: null, cve: null}` (match the existing fixture's shape — check tests/fixtures/finding.valid.json). Prompt-injection candidates: ruleId `rampart/prompt-injection-attempt`, severity LOW, class `hardening`, pack still set.

## init (CLI `node scripts/hunt-io.cjs init --project <slug> --system <id> --layer L2|L3|INFRA --effort low|medium|high [--repo <path>] [--base <ref>] [--run <runId>] [--json]`)

One system per run. Gates: project exists, has `ownerAttestation`, system is in the project (exit 2 otherwise, message names the gap). Units: L3 → `coverage.unitsForRepo(repo)`; L2 → `diffScope(repo, {base|defaultBranch})`, and if `empty` print `{"empty":true,...}` and exit 0 WITHOUT creating a run (Review Focus 4); INFRA → `unitsForHost` over the system's host packs. Classes (L2/L3): every class of the system's code packs (`packsFor` filtered by kind code) with `text` = the class's Look for / Confirm by / Disprove by / Severity when confirmed / CWE paragraphs verbatim as Markdown. Effort filter: `LOW_CLASSES = ['authz-scoping','tenant-isolation','bulk-export','session-handling','search-injection']` on reachable units; medium = all classes on reachable units; high = all classes on all units (exported). Hunters = units × filtered classes. Creates the run via `store.createRun(slug, {job: 'audit', layers: [layer], systems: [id], executor: 'local'})` unless `--run`; stamps `revision {commit, dirty}` for repo layers via git (exec.run). Prints `{runId, runDir, args}` where `args` = the workflow's args `{project, runId, repoRoot, systems: [{id, type, kind}], layer, units: [{system, unit, files}], classes: [{pack, packVersion, classId, text}], runDir, effort}` (`kind` = `code` for L2/L3, `host` for INFRA).

## list (CLI `list --project --run [--json]`)

After ingesting: `[{candidateRef, file, severity, title}]` (for the INFRA verify-only workflow, R8).

## assemble (CLI `assemble --project --run [--json]`; library `assemble(slug, runId)`)

1. `ingest`. 2. Hunter returned iff its candidates file exists and parses to an array. 3. Unit status: covered iff every planned hunter of it returned; else failed (reason "hunter did not return: <classIds>"). INFRA: a probe unit whose probe is in `observations.skipped` or has `ok:false` with no text → skipped (reason from observations); missing observations.json → every probe unit failed. 4. `tally`. 5. `fromHunt` for verified → `store.upsertFindings`. 6. `store.closeMissing` with source `rampart-hunter` (L2/L3) or `infra-probe` (INFRA), system, `seenIds` = ids of verified + undecided candidates, filter = finding.layer === layer AND (code: `coverage.unitContains(coveredUnitId, finding.location.path)` for some covered unit; INFRA: only when every probe unit is covered). 7. Coverage: `markCovered` covered units (status covered) and failed units (status failed) with `packs = coverage.packVersionsFor(system, layer)`; `store.writeCoverage`. 8. Write units.json statuses. 9. `finishRun` with `status` `failed` (reason "no unit was covered") when no unit covered, else `done`; counts `{added, updated, unchanged, hardening (verified hardening-class findings upserted), closed, candidates, verified, rejected, undecided}`; add the four new optional integer counts to run-schema.json.
Returns `{counts, findings: [ids], skipped: [units with status failed|skipped and reason]}`.
