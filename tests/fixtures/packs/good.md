---
name: good
version: 1.2.0
appliesTo:
  - nextjs
  - node-api
kinds:
  - code
  - host
sources:
  - https://example.com/guide | 2026-09-01
  - https://example.org/advisory | 2026-08-15
lastReviewed: 2026-10-01
---

# Good pack

## Hunt classes

### idor: Broken object-level authorization

**Look for:** Handlers that load a record by an id from the request without checking the caller owns it.
**Confirm by:** Trace the id from the route to the query and show no ownership check lies between them.
**Disprove by:** Find a policy, a row-level filter or a guard that scopes the query to the caller.
**Severity when confirmed:** HIGH. Any signed-in user can read or change other users' records.
**CWE:** CWE-639, CWE-862

### open-redirect: Unvalidated redirect target

**Look for:** Redirects built from a query parameter.
**Confirm by:** Show the parameter reaches the redirect without an allow-list.
**Disprove by:** Show the target is checked against a fixed list or made relative.
**Severity when confirmed:** low
**CWE:** CWE-601

## Baseline

Expect a reverse proxy in front of the app and no container publishing a database port.

## Probes

### containers: Running containers

**via:** `ssh`
**argv:** `["docker","ps","--format","{{.Names}} {{.Image}}"]`
**expect:** Only the app, the proxy and the database are running.
**scrub:** none

## Sources

- https://example.com/guide (2026-09-01)
- https://example.org/advisory (2026-08-15)
