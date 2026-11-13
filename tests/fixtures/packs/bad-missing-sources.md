---
name: bad-missing-sources
version: 1.0.0
appliesTo:
  - nextjs
kinds:
  - code
lastReviewed: 2026-10-01
---

## Hunt classes

### idor: Broken object-level authorization

**Look for:** Handlers that load a record by an id from the request.
**Confirm by:** Show no ownership check.
**Disprove by:** Find a guard.
**Severity when confirmed:** HIGH
**CWE:** CWE-639

## Baseline

Nothing special.

## Sources
