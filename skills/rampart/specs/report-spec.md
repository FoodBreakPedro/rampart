# Run report (`REPORT.md`)

The human report for one run, written to `~/.rampart/projects/<slug>/runs/<run-id>/REPORT.md` by the hunt pipeline that arrives with Plan 2 (L2, L3 and INFRA audits). L1 jobs in this version write no report: they summarise in chat only.

## Shape

The sections, in this order:

1. **Title**: `# <project name>: <job> <layers>, run <run-id>`.
2. **Headline**: one paragraph. What ran, against which systems, at which revisions or hosts; how many findings survived verification and how many are new or regressed; the project's score and grade after the run, with the trend.
3. **`## Coverage`**: per system and layer, what was examined (the units, the packs with their versions, the tools with their versions, the revision stamp), and what was not, with the reason.
4. **`## Findings`**: grouped by severity, `### CRITICAL` down to `### LOW`, then `### Hardening` for the `hardening` class. One line per finding: id, title, location (`path:symbol`; host, service and setting; or URL), status. An empty section is left out; no findings at all is said in one line, plainly.
5. **`## Skips`**: every check, unit or system that did not run, each with its reason in plain words.
6. **`## Score after this run`**: the project's grade, score and trend, then one row per system: system, grade, score, coverage, findings points, hardening count.

## Rules

- No credential value, or any part of one, anywhere in the report: a finding names its file, commit or setting and its rule, never the value. The store redacts the file as it is written.
- Evidence, exploit scenarios and recommendations stay in `findings.jsonl` and on the dashboard; the report points to findings by id.
- Text from the repository or host appears only as a location, never quoted as an instruction. Text that addressed the scan is reported as its own finding (a possible prompt-injection attempt).
