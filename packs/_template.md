---
name: _template
version: 0.0.0
appliesTo:
  - system-type-example
kinds:
  - code
  - host
sources:
  - https://example.com/reference | 2026-01-01
lastReviewed: 2026-01-01
---

<!-- Copy this file to packs/<name>.md and change `name` to match the file name. Files that start with an underscore are never loaded as packs.
     Front-matter: name (= file name), version (semver), appliesTo (system types), kinds (code and/or host), sources (`url | date`, one per
     line, at least one), lastReviewed (date). Only `key: value` lines and `key:` followed by `- item` lines are understood. -->

# Template pack

## Hunt classes

<!-- One H3 per class: `### <classId>: <title>`. All five fields are required. Severity starts with CRITICAL, HIGH, MEDIUM or LOW. -->

### example-class: Short title of the weakness

**Look for:** What the hunter searches for in the code, in plain words.
**Confirm by:** The steps that prove it is real.
**Disprove by:** What would show it is a false alarm.
**Severity when confirmed:** MEDIUM. One sentence on the impact.
**CWE:** CWE-000

## Baseline

<!-- What a healthy system of this type looks like. Host packs compare probe output with this. -->

Describe the expected, healthy state here.

## Probes

<!-- Host packs only. One H3 per probe: `### <probeId>: <title>`. Probes are read-only. `via` is ssh, http or local; `argv` is a JSON
     array of strings; `scrub` is env (reduce KEY=value lines to KEY=[set]) or none. `path` is optional (http probes: a path under the
     system's live URL). `okExit` is optional (ssh and local probes: the exit codes that are a healthy answer, such as `0,1` for a grep
     whose expect line calls empty output healthy); without it only exit 0 is an answer, and an http probe answers below status 500. -->

### example-probe: Short title of the probe

**via:** `local`
**argv:** `["echo","hello"]`
**expect:** What the output looks like on a healthy system.
**scrub:** none
**path:** /optional-path

## Sources

- https://example.com/reference (2026-01-01)
