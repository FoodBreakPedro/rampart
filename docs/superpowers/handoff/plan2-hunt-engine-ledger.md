# SDD ledger — plan: docs/superpowers/plans/2026-10-23-rampart-hunt-engine.md

Branch feat/hunt-engine, worktree .worktrees/hunt-engine, branch base 17d4ac6. Baseline: 570 pass, 1 skipped.
Spec: docs/superpowers/specs/2026-10-23-rampart-design.md (read §5.2, §5.4, §5.5, §5.9, §5.10).

## Pre-flight scan

| Rows | Produces / consumes | Found |
|---|---|---|
| T1 ↔ T2/T3/T11 | T1 pack format+validator; T2/T3 write packs; T11 may tweak probes | consistent; T3 forbidden-word test must match whole argv tokens (else `--format` etc. false hits) → R15 |
| T1 ↔ T4 | readPack().probes → unitsForHost | consistent |
| T1 ↔ doctor | doctor packs.count via listPacks | consistent |
| T4 ↔ T5 | Unit shape, DEFAULT_IGNORE, dir→unit mapping | maxDepth=2 vs unit `app/api/users` (3 segments) ambiguous → R5 |
| T4 ↔ T6 | markCovered/gaps, store.read/writeCoverage | consistent |
| T6 ↔ T8/T9 | candidate/vote files, candidateId, file names | agents cannot compute SHA ids (no node) → R2; unit ids hold `/` and `:` (bad file names) → R3; hunter return shape T8 `{candidates:n,unit}` vs T9 list → R6 |
| T6 ↔ T9 | which hunters returned / failed units | T6 `unitsByStatus` source unspecified → R4 |
| T6 ↔ T7 | units.json (who writes it?), skips with reasons | unspecified → R4 |
| T6 ↔ T10/T11 | INFRA candidates, verify-only workflow | workflow gets no hunter results for INFRA → R8 |
| T9 ↔ T13 | args, effort subsets, assemble after | effort filter duplicated in script+workflow → R4 |
| T10 ↔ T6/T13 | run ownership (infra-probe creates run vs hunt-io init) | → R9 |
| T12 ↔ T6 | normalize/merge | consistent |
| T13 ↔ all | recipes | verify job needs a verdict-apply step → R12 |
| T1 self | tests vs interface | consistent |
| T2 self | ≥8 classes incl. 10 fixed ids | consistent (≥10 in practice) |
| T3 self | ≥5 classes, ≥6 probes, read-only argv | consistent |
| T4 self | fixture includes node_modules/x/index.js; .gitignore ignores node_modules/ | needs `git add -f` → R14 |
| T5 self | consistent |
| T6 self | majority rule details | → R7 |
| T7 self | consistent |
| T8 self | tools list lacks Write, but both agents must write a file | → R1 |
| T9 self | static tests only; manual run in T14 | consistent |
| T10 self | fake-ssh "per probe id": shim sees only argv | → R10 |
| T11 self | tools lack Write but writes candidates | → R1 |
| T12 self | consistent |
| T13 self | consistent |
| T14 self | headless `claude -p` needs Workflow + permissions | handle at T14 |
| spec §5.2 vs plan | spec `candidates.jsonl`/`votes.jsonl`; plan per-agent files in dirs | → R11 |
| spec §5.5 L2 table vs Reuse rule | table says claude-security else /security-review; Reuse rule (later, revised) says own pipeline | → R13 |

## Rulings

- R1 Ruling: hunter, verifier and infra-prober get `Write` added to the plan's exact tool lists (tests pin plan list + Write) — each must write one file at a path it is given and the plan's lists leave no way to do it; prompts confine writes to that one path — if wrong, an agent could write outside the run dir (prompt-only confinement).
- R2 Ruling: agents never compute ids. Hunters write each candidate with a local `ref` (`c1`…`c10`), no candidateId; verifiers write votes with `candidateRef` = `<hunterKey>#<ref>`. hunt-io computes `candidateId = findingId({project, system, ruleId:'<pack>/<classId>', location})` on ingest, rewrites the file normalized and redacted; candidates sharing an id merge with their votes unioned (counted per distinct verifier label). Schemas describe the stored form; raw agent form allows ref/candidateRef — plan says candidateId is the would-be finding id, kept; only who computes it changes — if wrong, more indirection than needed.
- R3 Ruling: `fileKey(unitId)` = unitId with every char outside `[A-Za-z0-9._-]` replaced by `+`; hunterKey = `<fileKey>__<classId>`; candidate file `candidates/<hunterKey>.json`; vote file `votes/<hunterKey>__<ref>__<n>.json`. Exported from hunt-io; audit.js inlines the same regex (test pins identical) — `/` and `:` are not portable in file names — if wrong, rename churn only.
- R4 Ruling: `hunt-io init` owns the plan: creates the run (store.createRun, job audit) unless `--run` given, makes candidates/ votes/, computes planned hunters = units × classes filtered by effort (LOW_CLASSES = authz-scoping, tenant-isolation, bulk-export, session-handling, search-injection; medium = all classes on reachable units; high = all on all units), writes `units.json` {layer, effort, units[], classes[], hunters[{key, system, unit, classId, pack, packVersion}]} and prints args-ready JSON. The workflow applies the same filter again (idempotent; test pins identical LOW list). assemble decides coverage from files, not from the workflow's return: a hunter returned iff its candidates file exists and parses as an array (`[]` = nothing found); a unit is covered iff all its planned hunters returned, else `failed`; assemble writes per-unit `status` and `reason` back into units.json; render-report reads Skips from there. Run status: `failed` if no unit covered, else `done` (failed units listed) — makes Review Focus 2 hold even when the workflow dies — if wrong, extra file.
- R5 Ruling: unit = directory of the file truncated to maxDepth+1 segments (root-level dirs are depth 0, so `app/api/users` is depth 2); a root-level file → unit `.`; `unitOf(path, maxDepth)` exported from coverage.cjs and reused by diff-scope — only reading where `app/api/users` is a unit at maxDepth 2 — if wrong, units too coarse/fine.
- R6 Ruling: Task 9's hunter return wins over Task 8's: hunter returns `{unit, classId, candidates: [{ref, title, severity}]}` (no evidence text, so no value can reach the main context); verifier returns `{verdict}`; infra-prober returns `{candidates: n}` — the workflow needs refs to dispatch verifiers — if wrong, schema tweak.
- R7 Ruling (tally): votes per candidate = merged votes; verified iff confirmed > votes/2 AND confirmed ≥ 1 AND (hunter severity HIGH/CRITICAL ⇒ confirmed ≥ 2); rejected iff rejected > votes/2; otherwise undecided. The HIGH/CRITICAL bar uses the hunter's severity. severity = min of confirming verifiers' ratings when ≥ 2 rate it, else the hunter's; confidence = min(hunter, every confirming verifier that rates it). Prompt-injection candidates (hunter flag, or hunt-io heuristic regex on title/evidence addressing the scan) are still verified, then become rule `rampart/prompt-injection-attempt`, LOW, class hardening — spec "never self-graded" — if wrong, an injection note needs one confirm.
- R8 Ruling: INFRA: recipe runs infra-probe.cjs, dispatches infra-prober (Agent tool) which writes `candidates/<fileKey(system)>__infra-prober.json`; workflow is called with layer INFRA, `kind: 'host'`, and `args.candidates: [{candidateRef, file, severity}]` from new `hunt-io.cjs list --project --run --json`; Hunt phase skipped. INFRA units = probes: covered iff observation ok and prober file exists; probes in infra-probe skipped[] → `skipped` with reason; closeMissing for INFRA only when every probe unit of the system is covered — if wrong, INFRA closes less often.
- R9 Ruling: infra-probe.cjs takes `--run <id>` to use the run hunt-io init created; without it creates its own run (job audit, layers INFRA). It finishes the run `done` only when it created it; a first-probe connect failure marks the run `skipped` either way (exit 2) — avoids two runs per INFRA audit — if wrong, minor.
- R10 Ruling: fake-ssh shim maps the remote command it receives to a canned file: `FAKE_PROBES/<probeId>.txt` chosen via `FAKE_PROBES/index.json` {"<exact remote command>": "<probeId>"}; unmatched → exit 127 — shim sees only argv — test-only.
- R11 Ruling: follow the plan's `candidates/` and `votes/` directories over spec §5.2's `candidates.jsonl`/`votes.jsonl`; db-layout/role text updated in Task 13 — per-agent files avoid concurrent appends from parallel agents — if wrong, doc drift only.
- R12 Ruling: Task 13 may add `hunt-io.cjs reverify --project --run --finding <id>` (reads that finding's vote file; `rejected` → setDisposition fixed, by rampart, "no longer reproducible in run <id>"; with tests) — verify job needs a deterministic apply step — scope creep risk small.
- R13 Ruling: spec §5.5 Reuse rule (revised after review) governs over the jobs table: L2/L3 run Rampart's pipeline; claude-security offered only attended; no `/security-review` fallback — later, explicit revision — if wrong, a missing fallback engine.
- R14 Ruling: hunt-target fixture's `node_modules/x/index.js` committed with `git add -f`; the fixture plants the IDOR (users route returns any user by id param without comparing to session) and unscoped export (export route returns all rows, no tenant filter) already in Task 4 — Task 14 needs them; T4 owns the fixture.
- R15 Ruling: T3's read-only test compares whole argv tokens (case-insensitive) against rm, restart, stop, kill, down, exec, apply, write, and rejects any element containing `>` or `|` — substring matching would reject legitimate tokens — if wrong, a looser gate.

## Tasks
Task 1: dispatched (sonnet, agent a2d87bf387d540d77, base 17d4ac6)
Task 1: review 1 → Needs fixes (I1 CWE not required; I2 zero classes/probes validate clean)
Task 1: minor (deferred): packsFor throws on any malformed pack without naming it; duplicate front-matter keys overwrite silently; NAME_RE vs schema pattern mismatch (uppercase/dots, `^_?`); literal BOM char in regex; CLI list/validate --json tests vacuous until real packs exist
Task 1: fix round 1/5 (3 addressed, 0 open; commits 74f8294..4a66c6b)
Task 1: minor (deferred): NAME_RE tightening untested
Task 1: complete (commits 17d4ac6..4a66c6b, review clean)
Task 2: dispatched (opus high, agent a92b99a8c0ef6af76, base 4a66c6b)
Task 2: Ruling: web-nextjs gets an `xss` class (dangerouslySetInnerHTML, javascript: hrefs, unescaped HTML in route responses) — the 1–3 stack-specific guidance was the controller's, not a cap; XSS is a core web class (spec §5.5 general classes: injection) — costs one class of text if wrong
Task 2: review 1 → Needs fixes (I1 Express 5 simple query parser makes ?a[$ne] a string; I2 insecure-local-storage makes sandboxed session tokens MEDIUM, contradicts DiD rule) + controller ruling xss class
Task 2: minor (deferred): Next 15 unused server actions are dropped at build (verifier hint); path.join wording; jsonwebtoken ≥9 rejects alg confusion; workers_dev/preview_urls defaults vary by Wrangler version; Workers eval-blocked note only in Look for, not Disprove by; zod 4 .loose()/looseObject; webhook/mass-assignment only in node-api
Task 2: fix round 1/5 (3 addressed, 0 open; commits e780092..7b3cb9a)
Task 2: complete (commits 4a66c6b..7b3cb9a, review clean)
Task 3: dispatched (opus high, base 7b3cb9a)
Task 3: implementer DONE c4ac4cc (rate-limit interruption, resumed)
Ruling R16: http probes carry their method as argv `["GET"]`/`["HEAD"]` (argv[0]); Task 10 reads it — keeps the argv non-empty rule uniform — cost: odd-looking argv.
Ruling R17: env probes may print the value of an explicit allowlist of non-secret settings (booleans/modes/versions, e.g. GOTRUE_DISABLE_SIGNUP) as `NAME value`; everything else reduced to `NAME=[set]`; redact() still runs over all output — spec §5.9 wants flag names and classes, and a boolean flag's value IS its class; plan's KEY=[set] scrub alone would leave every env class unsure — cost if wrong: an allowlisted name that can carry a secret leaks (reviewer to audit the allowlist).
Ruling R18: ssh-via probes run as `local` only for docker-host systems with no host.ssh (plan Task 10 text) — stated in plan.
Task 3: minor (deferred): doctor tool-version tests time out under load (flaky); probes use fixed container names (renamed stacks → unavailable); no per-image trivy probe; WordPress assumes ~/public_html
Task 3: review 1 → Needs fixes (I1 env templates print non-allowlisted NAME=value off-host, multi-line values escape line scrub; I2 WP probes assume ~/public_html, Hostinger default is domains/<domain>/public_html; I3 bare 200 at / → CRITICAL Studio open)
Ruling R19: probes may use one placeholder token `<sitePath>` (whole argv element or inside one, e.g. `--path=<sitePath>`), substituted by the runner (Task 10) with `system.host.sitePath` validated against ^[A-Za-z0-9._/~-]+$ (no `..`), default `public_html`; a probe needing it on a system without a valid value runs with the default — the remote command is still built only from pack argv plus an owner-attested inventory field, never finding/user text — cost: one more input path into the ssh command (charset-validated).
Task 3: minor (deferred): probes that exit non-zero by design (default-secrets both gateways, systemctl absent units, stat alt wp-config) — Task 10/11 must use text when ok=false, pin with canned test; default-secrets covers 3 placeholders only; WP-CLI "no third-party code runs" overstated (mu-plugins, drop-ins, wp-config execute); `sshd -T` → /usr/sbin/sshd; MAY_ECHO_VALUES heuristic misses `cat`; n8n api-docs 200 may be SPA fallback; no /wp-admin/ probe
Ruling R20: R15 gate strips the exact token `<sitePath>` before its `>` check (nothing else exempt) — follows from R19 — cost: none beyond R19.
Task 3: fix round 1/5 (3 addressed, 0 open; commits c4ac4cc..748dea6)
Task 3: complete (commits 7b3cb9a..748dea6, review clean)
Task 4: dispatched (sonnet, base 748dea6)
Task 4: review 1 → Needs fixes (I1 gaps CLI compares every pack of the system regardless of layer/kind; I2 background units in gaps)
Ruling R21: background (reachable:false) units stay in `units`/`gaps` output with their `reachable` flag (effort high hunts them, per plan Task 9); CLI gains `--reachable` to filter; hunt-io init applies the effort rule — reviewer's "contradicts spec" overstated: plan says background units are hunted at high effort — cost: none.
Ruling R22: unit membership is `unitOf(path, maxDepth) === unitId` (bucket, not prefix); export `unitContains(unitId, path, maxDepth)` for Task 6 — prefix test would let `.` own everything.
Task 4: minor (deferred): gaps/show silently default --layer L2 (recipe must pass --layer L3); glob regex rebuilt per path
Task 4: fix round 1/5 (3 addressed, 0 open; commits 6bee81b..326d472)
Task 4: minor (deferred): CLI gaps layer-scoping not tested end-to-end; test comment at coverage.test.cjs:224 overclaims a version bump; --reachable ignored by show
Task 4: complete (commits 748dea6..326d472, review clean)
Task 5: dispatched (sonnet, base 326d472)
Task 5: complete (commits 326d472..32b6b1b, review clean)
Task 5: minor (deferred): `+++ ` content line misparsed as header drops later hunks; git() mislabels timeouts as "could not be started"; no trailing `--` after range / defaultBranch not validated like base; no --no-textconv; tests miss three-dot advanced-base, quoted path, `-` base, CLI --project path
Ruling R23: Task 6 design note task-6-design.md (one system per run; init owns gates, units, classes text, effort filter, run creation, args; agent-claimed scope fields overwritten from units.json; closeMissing seenIds = verified + undecided; evidence value-like → whole field replaced; entropy ≥3.5 on ≥20-char tokens) — concretes R2–R8 so later tasks share names — cost if wrong: rework in hunt-io only.
Task 6: dispatched (sonnet, base 32b6b1b)
Task 6: implementer DONE_WITH_CONCERNS 0f8fa3b (entropy rule blanks ordinary identifiers/paths; hunt-io.cjs 604 lines)
Ruling R24: value-like token = a run of [A-Za-z0-9+=_-] (no `/`, no `.`) of ≥ 20 chars with ≥ 2 digits, ≥ 1 letter and Shannon entropy ≥ 3.5 bits/char (JWTs and redact() hits still blank the field) — design note's rule blanked evidence that cites paths/identifiers (measured by implementer) — cost if wrong: a long all-letter secret slips past this layer (redact() and the hunter prompt still apply).
Ruling R25: INFRA skipped probe units are not written to coverage.json (gaps would treat them as covered) — implementer's call, consistent with "never silently clean".
Task 6: review 1 → Needs fixes (I1 invalid/unknown agent files keep raw contents on disk; I2 invalid candidates vanish and their unit still closes findings) + R24
Ruling R26: a unit whose hunter file had invalid entries stays covered but is excluded from closeMissing and carries `invalid: <n>` in units.json; counts gain `invalid`; assemble refuses (exit 2) a run already finished; writeVote validates its file name; readVotes filters by file-name regex — I2 is a silent-clean path; the traversal/forgery minors are security-relevant and cheap — cost: one more count.
Task 6: minor (deferred): code candidate path not checked to lie in its hunter's unit; cleanPath allows control chars; --run reuse doesn't check systems/layers match; tests for >10 refs / non-array file
Task 6: fix round 1/5 (4 addressed, 1 new — stubReason echoes an agent-written {invalid} string unredacted into invalid.json and the stub; commits 0f8fa3b..21d2b46)
Task 6: fix round 2/5 (1 addressed, 0 open; commits 21d2b46..f0bc8b9)
Task 6: minor (deferred): stub stability between ingests not asserted by a test; base64 secrets with `/` or letters-only secrets pass R24 by design
Task 6: complete (commits 32b6b1b..f0bc8b9, review clean)
Task 7: dispatched (sonnet, base f0bc8b9)
Ruling R27: touched findings also bounded by lastSeen <= run.finishedAt when the run has finished — otherwise later runs leak into older reports — cost: none.
Task 7: review 1 → Needs fixes (I1 Markdown links/images pass clean(); I2 headline lacks score/grade/trend) + R27
Ruling R28: Windows opener uses `explorer.exe <file>` (no cmd.exe parsing) — cmd /c start re-parses `&^%` — cost: explorer may return exit 1 even on success, handled as a warning only.
Task 7: minor (deferred): readFindings called repeatedly; no test for bypass-shape value in a location
Task 7: fix round 1/5 (4 addressed, 1 new — R27 bound drops a run's own findings once a later run re-sees them, since lastSeen/verification.run are overwritten; commits 03ed095..9620205)
Ruling R29 (supersedes R27): hunt-io assemble persists the ids it upserted (verified) and closed in the run dir as `findings.json` {verified:[ids], closed:[ids]}; render-report uses that list when present, else falls back to `verification.run === runId || (lastSeen >= startedAt && firstSeen <= finishedAt)` — store keeps only the latest sighting, so per-run membership must be recorded at assemble time — cost: one more run-dir file.
Task 7: minor (deferred): bare email autolinks and `~` not escaped; escaped title can exceed 140 cap; main→run argv and win32 exit-1 path untested; no non-null trend test
Task 7: fix round 2/5 (1 addressed, 0 open; commits 9620205..218e63c)
Task 7: minor (deferred): render-report.cjs:191 `if (!list)` vs touchedBy's Array check disagree on malformed findings.json (closed count 0); findings.json list branch has no system/layer filter; render test regex `[fixed]` is a char class
Task 7: complete (commits f0bc8b9..218e63c, review clean)
Task 8: dispatched (opus high, base 218e63c)
Task 8: implementer DONE 9f045eb (concerns: verifier lacks Severity rubric; host verifier reads raw probe files — Task 10 must scrub raw; prompt-only write confinement; host verifier can't re-probe → CHANGELOG; git log/show need cwd = repo root)
PAUSED 2026-10-23 at parent session's request (Pedro switching machines). OPEN: Task 8 — implementation committed (9f045eb), task review NOT yet run, no fix round open. NEXT ACTION: build review package 218e63c..9f045eb and dispatch the Task 8 reviewer (opus); then Task 9 (load workflow-authoring first). Briefs, design note (task-6-design.md) and reports live in .superpowers/sdd/2026-10-23-rampart-hunt-engine/ (git-ignored, local to this machine) — the copy below carries the ledger only.
RESUMED 2026-10-26 on new machine (worktree nostalgic-mccarthy-dfa0ac); npm test 683/2 skip, validate green at af0ef91. Briefs rebuilt via task-brief; task-6-design.md from handoff.
Task 8: review dispatched (opus, base 218e63c head 9f045eb; report reconstructed from ledger concerns)
Task 8: review 1 → Needs fixes (I1 verifier rates severity / applies class exclusions without the class's Severity and Look for text)
Ruling R30: the verifier's dispatch carries the whole class text (`classText` = the five paragraphs exactly as units.json/args.classes[].text) in place of confirmBy/disproveBy only; it rates severity by the class's Severity when confirmed paragraph — R7 makes verifier severity user-visible, so it must be anchored; Task 9 passes class text — cost: longer verifier prompts.
Ruling R31: reviewer Minors M1 (location = sink in the unit; a root cause outside the unit is named in evidence), M2 (prompt-injection: `symbol` null for file-level text, never `location` null) and M3 (report injection text only in the unit's own files) go into the Task 8 fix round — M2 silently drops a security candidate as invalid, M1/M3 decide what Task 9's verifier fan-out sees — cost: a few lines of prompt.
Task 8: minor (deferred): git log/show usable only when cwd = repoRoot (no pwd, git -C not granted) — Task 9/13 to note; Write confinement prompt-only (CHANGELOG known limitation, T14); hunter reply titles not hunt-io-cleaned (prefer hunt-io list for chat); tests pin prose; round-trip lacks a confirmed vote with severity/confidence
Task 8: fix round 1 dispatched (opus, fresh implementer — original lost in machine switch; findings I1+R31 minors in task-8-fix1.md; FIX_BASE 9f045eb... note: head before fix = af0ef91)
Ruling R32: hunt-io init adds `paths` (repo-relative files of the unit: L3 from the walk, L2 the unit's changed non-deleted files) to each args unit; `files` stays the count — the brief promises the hunter a files list and args carry only a count; for L2 the hunter must see which files changed — cost: larger args on big repos. Implemented in Task 9 with a test.
Ruling R33: the workflow re-applies only the LOW class filter (args.units carry no `reachable`; init already dropped background units below high) — R4's "same filter again" is satisfied for the part args can express — cost: none.
Ruling R34: INFRA verify-only — hunt-io list adds `classId` to each entry; the workflow takes `args.candidates [{candidateRef, file, severity, classId}]`, looks up the class text in args.classes by classId, passes `observationsPath = <runDir>/observations.json` and optional `args.baseline` (string, supplied by the Task 13 recipe) to each verifier — the verifier needs class text (R30) and baseline, and the script cannot read files — cost: one more field.
Ruling R35: the workflow never logs or returns candidate titles or evidence (hunter titles are not yet hunt-io-cleaned); log/return only counts, refs and unit ids — Review Focus 1 — cost: less informative progress lines.
Task 8: fix round 1/5 (5 addressed, 0 open — I1 classText, M1–M3, confirmed-vote round trip; commits af0ef91..c749522)
Task 8: minor (deferred): hunter.md data-not-instructions paragraph says "Report it as a candidate" without the unit-file qualifier (points to the qualified section)
Task 8: complete (commits 218e63c..c749522, review clean)
Task 9: dispatched (opus, base c3ef8e5; context task-9-context.md, workflow-api.md)
Task 9: implementer DONE_WITH_CONCERNS 1b230c0,15b9afa (pipeline stub semantics unconfirmed till T14; validator ignores workflows/ — plugin discovery unconfirmed; paths fallback text)
Task 9: controller check — claude-security plugin ships workflows/scan.js with agentType 'claude-security:<agent>', so plugin workflows/ discovery and agentType naming match (implementer concern 2 resolved). It also parses args when they arrive as a JSON string.
Task 9: review 1 → Approved (no Critical/Important)
Task 9: minor (deferred): stage 1 `(item)=>` relies on pipeline passing the item as prevResult — use `(_, item)`; paths-missing fallback widens L2 hunt; HUNTER/VERDICT schemas lack additionalProperties:false; untested stage-2-throw and failedUnits dedup; args arriving as a JSON string not parsed (claude-security's scan.js parses them)
Ruling R36: Task 9's deferred minors M1 (stage-1 `(_, item)`) and JSON-string args go to the Task 13 implementer (it wires the Workflow call and may touch workflows/audit.js) — both could break the first live run in Task 14 — cost: Task 13 diff grows slightly.
Task 9: complete (commits c3ef8e5..15b9afa, review clean)
Task 10: dispatched (sonnet, base e21657f)
Task 10: implementer DONE ef63b6a (host.ssh refused if whitespace/leading -; http ok=true on any response; reused run never marked failed on exception; unreachable writes observations with rest skipped)
Task 10: review 1 → Needs fixes (C1 --probe with --run overwrites observations.json and can mark the shared run skipped; I2 env scrubber misses CRLF, export, `KEY = v`, quoted/JSON, `KEY: v`, path:-prefixed and continuation forms)
Ruling R37: with `--run`, when observations.json already exists the runner merges into it (an entry with the same probeId is replaced; skipped[] entries for a probe that now has an observation are dropped) and never finishes or re-skips that run; the first-probe-unreachable skip rule applies only when no observations.json existed before the call — Task 11's prober runs extra probes this way — cost: none.
Ruling R38: "first probe" = the first probe that actually attempted to reach the host (refused probes don't count) — otherwise a down host makes every later ssh probe wait its ConnectTimeout (Review Focus 3) — cost: none.
Ruling R39 (amends R19): drop `~` from the sitePath charset; sitePath is relative to the ssh user's home (or absolute) — quoting stops tilde expansion, so `~` never works — cost: owners must write paths without `~`.
Task 10: minor (deferred): reused --run not checked for layer INFRA/system/status; exception on reused run leaves no observations.json (assemble marks all failed — document); http ok=true on any response incl. 5xx (document for Task 11); non-Set-Cookie headers kept verbatim behind redact(); runner has no allowlist of its own (pack templates enforce R17); ProxyCommand/ControlMaster grandchild may hold stdio past the kill
Ruling R40: JSON-style lines keep boolean/number/array values (only quoted string values → key=[set]) — daemon-config's tlsverify/hosts must stay judgeable; redact() still runs over arrays — cost if wrong: a secret inside a JSON array relies on redact() alone.
Task 10: fix round 1/5 (4 addressed, 0 open — C1 merge, I2 scrub forms, R38, R39; commits ef63b6a..bbb9641)
Task 10: minor (deferred): scrubber line-anchored — minified JSON `{"k":"v"}`, one-line Env arrays, grep-prefixed JSON pairs, `/p:export K=v`, YAML `- KEY=v`/lowercase `key: v` pass (no current probe prints them; redact() backstop); `"EMPTY=",` swallows later JSON-array lines (fails closed); unreachable extra probe replaces an earlier good observation with skipped; corrupt observations.json treated as absent; YAML_PAIR turns `ERROR: text` into ERROR=[set]; unquoted multi-line (PEM) not swallowed
Task 10: complete (commits e21657f..bbb9641, review clean)
Task 11: dispatched (opus, base 956b4e5)
Ruling R41: Task 12 maps the real claude-security JSONL record (checked against the installed plugin's scripts/lib/finding.py): fields id, title, impact, file, line, description, exploit_scenario, preconditions[], category, severity (upper), confidence (lower: low|medium|high), recommendation, cwe_id (one string), snippet, symbol, declared_line, via_change, other_cwe_ids[], claudeSecurityPluginFindingId; report dir `CLAUDE-SECURITY-<digits/dashes>`; findings are panel-verified 2-of-3 so verification = {verifiers: 3, confirmed: 2} — the plan's fixture shape (cwe[], votes) is a guess; `snippet`, `description`, `impact`, `exploit_scenario` are never stored — cost if wrong: field renames.
Task 11: implementer DONE_WITH_CONCERNS 7fdef49 (renamed colliding probe ids containers/image-digests in n8n+supabase packs, no version bump; ${CLAUDE_PLUGIN_ROOT} in subagent Bash unverified live; recipe must pass all host packs' baseline/classes; agent value-token test loosened to ≥2 digits; flaky render-report test 1/3)
Ruling R42: probe-id renames in n8n/supabase packs keep version 1.0.0 — the packs have never shipped (Plan 2 unreleased), so no coverage ledger holds the old ids — cost if wrong: none outside this branch.
Task 11: review 1 → Approved (no Critical/Important)
Task 11: minor (deferred): agent value-token test ≥2 digits misses AWS-style ids/letter-only secrets (exempt identifier shapes instead); probe-id uniqueness test per type only (assert global); prober doesn't say what to do on runner exit 1; normalizeCandidate falls back to named[0] when pack missing/wrong (Task 6 parser); example evidence overclaims TLS proxy; ${CLAUDE_PLUGIN_ROOT} expansion in subagent tool pattern unverified (T13/T14 live check)
Task 11: complete (commits 956b4e5..7fdef49, review clean)
Task 12: dispatched (sonnet, base 7fdef49; context task-12-context.md, R41)
Task 12: implementer DONE_WITH_CONCERNS 2a82ba7 (ruleId claude-security/<cwe_id>; job import; fixture outside CLAUDE-SECURITY-* dir due to .gitignore; merge into fixed → regressed; --json omits skipped list; re-import counts merged 3 unchanged 3)
Task 12: review 1 → Needs fixes (I1 merge into a fixed finding goes through upsertFindings and re-opens it as regressed with a made-up "reappeared" disposition from a possibly stale report)
Ruling R43: an import never changes a finding's status — merge targets whose status is fixed, false_positive or accepted_risk get only the external id recorded (and the higher verification) by a write that leaves status/disposition/lastSeen untouched; open/regressed targets merge through upsertFindings as now — an import carries no freshness, and the record's own "regressed" must come from a Rampart sighting — cost if wrong: a genuinely reappeared flaw is not re-opened until Rampart's own audit sees it. Also ruled in (cheap, count correctness): dedupe records that resolve to the same finding id within one report (keep the stronger, count once), and include `skipped` (line + fixed reason) in --json.
Task 12: minor (deferred): no size cap on JSONL read; "merged" label on re-import could read "matched"
Task 12: fix round 1/5 (3 addressed, 0 open — R43 annotateFinding, in-report dedupe, --json skipped; commits 2a82ba7..b8e84fe)
Task 12: minor (deferred): R43 residual — a no-CWE record whose computed id equals a stored fixed finding's id goes via upsert and regresses it (rare); test .slice(0,2) order-dependent
Task 12: complete (commits ca97a31..b8e84fe, review clean)
Task 13: dispatched (opus, context task-13-context.md)
Task 13: implementer DONE_WITH_CONCERNS 1b0c923,81978f5,0019899,85cfc83 (Workflow async completion + wait.cjs loop unverified; CLAUDE_CODE_REMOTE as cloud signal unverified; Supabase advisors weak; 50k/agent estimate guess; small hunks outside owned sections; render-static with no args rewrote real ~/.rampart/dashboard.html (0 projects); no C-cap exists in code — README line removed only)
Task 13: review 1 → Needs fixes (I1 verify.md step 4.2 and audit.md INFRA step 4 don't handle a background Agent launch → reverify/list run before agents finish, silent failed outcomes)
Ruling R44: ruled into the Task 13 fix round: M1 (wait loop: go on if the Workflow call already returned its result; cap the loop, then assemble anyway), M2 (CLAUDE_CODE_REMOTE cloud gate also in infra-probe.cjs), M4 (reverify confirm path refreshes verification verifiers/confirmed, not only run) — each cheap and each could corrupt a live run or touch a host from the cloud — cost: slightly larger fix diff.
Task 13: minor (deferred): verify.md hard-codes 50k vs TOKENS_PER_AGENT; hostNameOf mangles bare IPv6; claude-security hand-off offered when only on disk (marketplace) not enabled; Supabase advisors appended to baseline (observations treated as expectations; project not tied to system); list titles reach Workflow args (/workflows view); verify run left running if session ends; L2/L3 lack cloudAllowed check (spec §5.8, Plan 3); CLAUDE_CODE_REMOTE signal and Workflow async-completion pattern unverified until T14; implementer rewrote real ~/.rampart/dashboard.html (0 projects) via render-static with no args
Task 13: fix round 1/5 (4 addressed, 0 open — I1 background agents, M1 wait cap, M2 probe cloud gate, M4 reverify counts; commits 85cfc83..4ed12d3)
Task 13: minor (deferred): verify.md "run step 3 before then" ambiguous (two step 3s); reverify overwrites the hunt's multi-verifier tally with the verify run's
Task 13: complete (commits 2cf1b68..4ed12d3, review clean)
Ruling R45: Task 14 acceptance runs headless `claude -p --plugin-dir <worktree> --model sonnet` with a temp RAMPART_HOME, `--max-budget-usd` caps (L3 25, L2 10, INFRA 10, verify 5) and an explicit --allowedTools list (no bypassPermissions) — sonnet keeps the many-agent fan-out affordable; caps bound spend — cost if wrong: acceptance does not reflect Opus behaviour.
Task 14: dispatched (opus, base a6e705a; context task-14-context.md, R45)
Task 14: implementer DONE_WITH_CONCERNS d886506,5bc538b,f06f8d1,0dad755; tag rampart--v0.2.0-alpha.1 local (all acceptance steps pass, $4.07 on sonnet; one flaw → one finding per matching class; agent Bash tools pattern not a permission grant — prober extra probes need session allow, unexercised; SKILL.md still calls import Plan 4)
Task 14: review 1 → Approved
Task 14: minor (deferred): answeredOk treats every grep exit 1 as clean, incl. ufw-enabled and the WP version grep where no-match ≠ healthy (prefer a per-probe opt-in); infra-prober.md:34 ok semantics stale; SKILL.md:41 and README.md:34 list import as Plan 4 while `audit --import` ships; marketplace.json version copy untested against plugin.json; scripts/*.cjs pre-approval covers every script (narrow to named scripts later)
Task 14: complete (commits a6e705a..0dad755, review clean)
Final review: dispatched (opus, 17d4ac6..0dad755)
