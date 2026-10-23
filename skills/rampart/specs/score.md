# Score sheet

How `scripts/score.cjs` scores a system and a project. The numbers are tunable; change this file, the script and `tests/score.test.cjs` together.

## Per system

A system's score is its coverage points plus its findings points, out of 100.

- **Coverage, 40 points.** For each layer the system declares (`L1`, `L2`, `L3`, `INFRA`, each with a `cadenceDays`), the credit is 1 when the layer's last run finished within one cadence window, 0.5 within two windows, and 0 beyond that or when it never ran. A run exactly on a window's edge gets the better credit. Coverage is 40 times the mean credit of the system's layers; a system that declares no layers has nothing missing and gets the full 40.
- **What counts as a run.** A run with status `done` whose `systems` include the system and whose `layers` include the layer. Skipped and failed runs earn nothing. A run's time is `finishedAt`, else `startedAt`; the next due date is that time plus the cadence.
- **Findings, 60 points.** Start at 60 and subtract for every finding of the system with status `open` or `regressed`, by class and severity:

  | Class | CRITICAL | HIGH | MEDIUM | LOW |
  |---|---|---|---|---|
  | `verified` | 25 | 12 | 5 | 1 |
  | `tool` | 12.5 | 6 | 2.5 | 0.5 |
  | `hardening` | 0 | 0 | 0 | 0 |

  The findings points never go below 0. Findings that are `fixed`, `false_positive` or `accepted_risk` cost nothing. Dependency advisories arrive grouped, one finding per vulnerable package, so a package with ten CVEs costs once.
- **Hardening column.** The number of open or regressed `hardening` findings, shown beside the grade so a missing header is visible without sinking the grade.
- Coverage, findings points and the score are each rounded to one decimal.

## Per project

- The project score is the mean of its systems' rounded scores, weighted by each system's `criticality`: `auth`, `billing` and `data` weigh 3, `public` 2, `internal` 1. A system with no tag, or a tag outside these five, weighs as `public`. The mean is rounded to one decimal. A project with no systems has measured nothing and scores 0, an F.
- **Trend** is this score minus the latest saved project snapshot (`scores.jsonl`, `kind: "project"`), rounded to one decimal; there is none before the first snapshot. `score.cjs <slug>` computes the trend first, then saves this score as the next snapshot; `--no-save` leaves the file alone.

## Grades

A at 90 or more, B at 75, C at 60, D at 40, F below 40. A score exactly on a boundary gets the higher grade.

**Ruling: grades are taken from the one-decimal rounded score, at both levels,** so the sheet and the grade always agree: a project whose weighted mean is 89.97 prints 90.0 and is an A, never "90.0, B". The cost is that anything from 89.95 up rounds to an A.

## Worked examples

From `tests/score.test.cjs`, every layer fresh unless said otherwise:

| Case | Arithmetic | Score | Grade |
|---|---|---|---|
| No findings | 40 + 60 | 100 | A |
| One `verified` HIGH, two `tool` MEDIUM | 40 + 60 − 12 − 2.5 − 2.5 | 83 | B |
| Four `tool` HIGH | 40 + 60 − 4 × 6 | 76 | B |
| Four `verified` HIGH | 40 + 60 − 4 × 12 | 52 | D |
| Project: an `auth` system at 50, a `public` system at 100 | (50·3 + 100·2) / 5 | 70 | C |

The third row is the spec's calibration check: a typical Node repository with a handful of untriaged dependency highs and nothing verified lands in the B range, not D.
