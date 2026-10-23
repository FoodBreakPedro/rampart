---
name: n8n
version: 1.0.0
appliesTo:
  - n8n
kinds:
  - host
sources:
  - https://owasp.org/Top10/2025/ | 2026-10-23
  - https://github.com/OWASP/ASVS/tree/v5.0.0 | 2026-10-23
  - https://docs.n8n.io/hosting/securing/overview/ | 2026-10-23
  - https://docs.n8n.io/hosting/configuration/environment-variables/security/ | 2026-10-23
  - https://docs.n8n.io/2-0-breaking-changes/ | 2026-10-23
  - https://docs.n8n.io/1-0-migration-checklist/ | 2026-10-23
  - https://docs.n8n.io/deploy/host-n8n/configure-n8n/security/disable-the-public-api.md | 2026-10-23
  - https://docs.n8n.io/deploy/host-n8n/configure-n8n/security/enable-ssrf-protection.md | 2026-10-23
  - https://docs.n8n.io/deploy/host-n8n/configure-n8n/security/harden-task-runners.md | 2026-10-23
  - https://github.com/n8n-io/n8n/security/advisories | 2026-10-23
  - https://github.com/n8n-io/n8n/blob/master/docker/images/n8n/Dockerfile | 2026-10-23
lastReviewed: 2026-10-23
---

<!-- Host pack for self-hosted n8n in Docker. The infra-prober compares the probe observations with the Baseline and writes
     candidates; verifiers try to disprove each one from the same observations. Say "unavailable" rather than "clean" when a probe
     could not run. The env probe prints values only for an explicit list of non-secret settings (booleans, lists, paths, URLs);
     every other variable is printed by docker's template on the host as NAME=[set] (NAME= when empty), so N8N_ENCRYPTION_KEY and
     database credentials never leave the host; scrub and redact stay as backstops. The env probe inspects the container named `n8n` (the name n8n's Docker guide uses); a
     container with another name answers "No such object" and the env classes are then unavailable. Defaults changed in n8n 2.0:
     read every unset variable against the running version. -->

# n8n

## Hunt classes

### version-advisories: n8n version with a published security advisory

**Look for:** The running version: the `org.opencontainers.image.version` label in the containers observation (n8n's image sets it from the release version), else the image tag, else, for `latest` or an empty label, the image's creation date and digest in image-digests. Compare it with the n8n GitHub security advisories and release notes. Weigh each advisory by what this instance exposes: issues in webhook, form or OAuth callback handling matter whenever the live URL answers (webhook-route shows the routes are public); issues in the Code node, expressions or a specific node matter for anyone who can edit workflows; issues in a node listed in `NODES_EXCLUDE` do not apply.
**Confirm by:** Name the running version and where it came from (label, tag or image date), the advisory (GHSA id or CVE and title), its first fixed version, and the precondition this instance meets (public webhook routes, a node that is not excluded, a version range that includes the running one).
**Disprove by:** The running version is at or after the fixed version; the affected node is in `NODES_EXCLUDE`; the advisory needs a feature that env shows is off (public API disabled, community packages disabled). A label of `snapshot` or a `latest` tag with no date means the version is unknown: no candidate, say unsure. Being behind the latest release with no security fix in between is hardening.
**Severity when confirmed:** HIGH. A published vulnerability is open on this instance; follow the advisory's rating. CRITICAL for an unauthenticated remote issue on a reachable route (file read, code execution, auth bypass); HIGH for code execution or credential access that needs a workflow editor; lower ratings follow the advisory.
**CWE:** CWE-1395, CWE-1104

### unauthenticated-access: Editor or API answering without a login

**Look for:** rest-unauth returning 200 (the internal `/rest/` API serves workflows to a caller with no session); public-api-unauth returning 200 (the public API serves workflows without an `X-N8N-API-KEY`); env showing `N8N_USER_MANAGEMENT_DISABLED true` or `N8N_BASIC_AUTH_ACTIVE` on a pre-1.0 version, where an instance could run with no login at all (1.0 made the owner account mandatory and removed basic auth); the editor port 5678 published to all interfaces in containers while the live URL's proxy adds the only login layer.
**Confirm by:** Quote the http status for the path and the absence of a `WWW-Authenticate` challenge, or the printed setting with the running version. Say what an anonymous caller gets: workflow definitions (which embed URLs, credentials references and logic), executions, or the editor itself.
**Disprove by:** rest-unauth answers 401; public-api-unauth answers 401 (API on, key required) or 404 (API disabled); the version is 1.0 or later, where the legacy variables have no effect. A 200 from `/healthz`, `/rest/settings` or the login page is by design.
**Severity when confirmed:** CRITICAL. Anyone can read and run workflows, which hold the keys to every connected system.
**CWE:** CWE-306, CWE-284

### env-access-in-code: Workflows can read the container's environment

**Look for:** `N8N_BLOCK_ENV_ACCESS_IN_NODE false` in env, or the variable absent on a version before 2.0 (the default was `false` until 2.0 made it `true`). With access open, any workflow editor reads `$env` in expressions and the Code node; check which secrets live in the environment by their names in env: `N8N_ENCRYPTION_KEY` (decrypts every stored credential), `DB_POSTGRESDB_PASSWORD`, cloud or SMTP keys. Variables that end in `_FILE` point to files instead and do not expose the value through `$env`.
**Confirm by:** Quote the setting (or its absence with the running version) and list the secret-bearing variable names that are `[set]`, never values. Say who gains: any member with workflow edit rights, or anyone who can make a workflow evaluate an attacker-supplied expression.
**Disprove by:** `N8N_BLOCK_ENV_ACCESS_IN_NODE true`, or unset on 2.0 or later; secrets are supplied as `_FILE` variables or an external secrets store so the environment holds no values worth reading. On a single-owner instance with no workflows taking expressions from outside input, this is hardening.
**Severity when confirmed:** MEDIUM. Workflow editors obtain secrets beyond their role. HIGH when `N8N_ENCRYPTION_KEY` or database credentials are in the environment, since together with the database they decrypt every stored credential.
**CWE:** CWE-526, CWE-200

### file-access: Workflows can read and write host files

**Look for:** `N8N_RESTRICT_FILE_ACCESS_TO` unset on a version before 2.0 (no restriction), or set to a broad path (`/`, `/home/node`, the n8n data directory); `N8N_BLOCK_FILE_ACCESS_TO_N8N_FILES false` (the Read/Write Files nodes may read n8n's own config, which holds the encryption key when it is not in the environment); and, from the docker-host pack's container-mounts observation, host directories or `/var/run/docker.sock` mounted into the n8n container, which turn file access into host access.
**Confirm by:** Quote the setting or its absence with the running version, and name the reachable paths: the allowed directories and any host mount on the n8n container.
**Disprove by:** `N8N_RESTRICT_FILE_ACCESS_TO` names a dedicated directory (2.0's default is `~/.n8n-files`) and `N8N_BLOCK_FILE_ACCESS_TO_N8N_FILES` is `true` or unset; the container mounts only its data volume. On a single-owner instance this is hardening unless workflows write files from outside input.
**Severity when confirmed:** MEDIUM. Editors read or overwrite files outside their workflows. HIGH when the reachable paths include the Docker socket, host configuration or n8n's own settings file.
**CWE:** CWE-22, CWE-552

### code-execution: Code node and command allowances beyond the defaults

**Look for:** In env: `NODES_EXCLUDE` set to `[]` or to a list that omits `n8n-nodes-base.executeCommand`, or unset on a version before 2.0 (Execute Command was enabled by default until 2.0); `NODE_FUNCTION_ALLOW_BUILTIN` set to `*` or naming `child_process`, `fs` or `vm`; `NODE_FUNCTION_ALLOW_EXTERNAL` set to `*`; `N8N_RUNNERS_ENABLED false` or `N8N_RUNNERS_INSECURE_MODE true` (Code node runs without task runner isolation); `N8N_GIT_NODE_ENABLE_HOOKS true`. Combine with the docker-host observations: the Docker socket mounted into the container or a privileged container turns a shell in n8n into root on the host.
**Confirm by:** Quote each permissive setting with its value and the running version, and state the path: a workflow editor runs shell commands or arbitrary modules inside the container, and, if the docker-host observations show it, on the host.
**Disprove by:** The values are the defaults for a 2.0 or later version (Execute Command excluded, runners enabled, no builtin modules allowed), or the permissive setting is offset by an observation that the container runs unprivileged with only its data volume. Community packages enabled (`N8N_COMMUNITY_PACKAGES_ENABLED`) is an owner-only install path and is hardening.
**Severity when confirmed:** MEDIUM. Any workflow editor runs code in the container. HIGH when the container has the Docker socket, host mounts or privileged mode; LOW on a single-owner instance whose owner already administers the host.
**CWE:** CWE-94, CWE-78, CWE-250

### public-endpoints: Unauthenticated endpoints beyond the intended webhooks

**Look for:** metrics returning 200 (`N8N_METRICS true` with `/metrics` reachable from the live URL, exposing workflow and queue counters); api-docs returning 200 or a redirect (the public API's Swagger UI is published); `N8N_SKIP_AUTH_ON_OAUTH_CALLBACK true` in env (OAuth callbacks complete without a session; 2.0 made `false` the default). Production webhooks are unauthenticated unless each Webhook node sets Basic, Header or JWT auth, which the probes cannot see: a webhook answering without credentials is a finding only when an observation names a registered production path that answered 2xx to the unauthenticated request; webhook-route shows only that webhook routing is public.
**Confirm by:** Quote the status and content type for the path, or the printed setting, and say what an anonymous caller learns or triggers.
**Disprove by:** metrics and api-docs answer 401, 403 or 404; `N8N_SKIP_AUTH_ON_OAUTH_CALLBACK` is `false` or unset on 2.0 or later; webhook-route answers 404 for its unregistered path (normal for a public instance). Public webhook routes by themselves are the product working as designed.
**Severity when confirmed:** LOW. Operational detail leaks. MEDIUM for OAuth callbacks without authentication, which let an attacker attach their own account's tokens to the instance's credentials.
**CWE:** CWE-200, CWE-306

### edge-tls: TLS at the edge and cookie flags

**Look for:** The live URL on `http://`, or edge without a `Strict-Transport-Security` header over https; `N8N_SECURE_COOKIE false` in env (the `n8n-auth` session cookie travels over cleartext); `N8N_PROTOCOL http` with `WEBHOOK_URL` or `N8N_EDITOR_BASE_URL` on http with a public host name; port 5678 published to all interfaces in containers, so clients can reach n8n directly and skip the TLS proxy.
**Confirm by:** Quote the URL scheme, the missing header, the printed setting, or the port mapping, and say what crosses the network in clear: login credentials, the session cookie, webhook payloads.
**Disprove by:** The live URL is https, the edge sends HSTS, `N8N_SECURE_COOKIE` is `true` or unset (default `true`), and 5678 is unpublished or bound to a loopback address behind the proxy. A missing HSTS header alone, with https enforced by a redirect, is hardening.
**Severity when confirmed:** MEDIUM. Credentials and sessions cross the network unencrypted. HIGH when the editor login is served over plain http on a public host name; LOW when only the direct port is published on a host whose live URL is on a private network.
**CWE:** CWE-319, CWE-614

## Baseline

A healthy n8n runs a current 1.x or 2.x release with no open advisory for its version, in a container named `n8n` that publishes nothing to all interfaces: a TLS reverse proxy on the host or in front of it serves the editor and webhooks on https with HSTS. The internal `/rest/` API and the public API refuse callers without a session or `X-N8N-API-KEY`, or the public API is disabled; `/metrics` and the API docs are not reachable from the live URL. The environment holds `N8N_BLOCK_ENV_ACCESS_IN_NODE=true` (default from 2.0), a narrow `N8N_RESTRICT_FILE_ACCESS_TO`, Execute Command excluded, task runners enabled without insecure mode, no builtin or external module wildcards for the Code node, secure cookies, and OAuth callbacks that require a session. Secrets come through `_FILE` variables or an external secrets store where possible. The container mounts only its data volume, never the Docker socket.

## Probes

### containers: n8n containers, versions and published ports

**via:** `ssh`
**argv:** `["docker","ps","--format","{{.Names}} {{.Image}} {{.Label \"org.opencontainers.image.version\"}} {{.Ports}}"]`
**expect:** One line per running container: name, image, OCI version label, published ports. The n8n container runs `n8nio/n8n` or `docker.n8n.io/n8nio/n8n` with a version label (for example `1.x.y` or `2.x.y`); its port 5678 is unpublished or bound to a loopback address behind a reverse proxy. Task runner sidecars run `n8nio/runners`. A `permission denied` on the Docker socket means the SSH user is not in the docker group: unavailable.
**scrub:** none

### image-digests: n8n images, digests and build dates

**via:** `ssh`
**argv:** `["docker","image","ls","--digests","--filter","reference=*/n8n","--filter","reference=*/*/n8n","--format","{{.Repository}}:{{.Tag}} {{.Digest}} {{.CreatedAt}}"]`
**expect:** The local n8n images with tag, digest and creation date. Used to date an image tagged `latest`; a creation date older than the newest advisory's fix release means the image predates the fix.
**scrub:** none

### env: n8n security settings

**via:** `ssh`
**argv:** `["docker","inspect","--format","{{.Name}}{{println}}{{range .Config.Env}}{{$kv := split . \"=\"}}{{$k := index $kv 0}}{{if eq $k \"N8N_BLOCK_ENV_ACCESS_IN_NODE\" \"N8N_RESTRICT_FILE_ACCESS_TO\" \"N8N_BLOCK_FILE_ACCESS_TO_N8N_FILES\" \"N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS\" \"N8N_SECURE_COOKIE\" \"N8N_SAMESITE_COOKIE\" \"N8N_PROTOCOL\" \"N8N_EDITOR_BASE_URL\" \"WEBHOOK_URL\" \"N8N_PUBLIC_API_DISABLED\" \"N8N_PUBLIC_API_SWAGGERUI_DISABLED\" \"N8N_METRICS\" \"N8N_RUNNERS_ENABLED\" \"N8N_RUNNERS_MODE\" \"N8N_RUNNERS_INSECURE_MODE\" \"NODES_EXCLUDE\" \"NODES_INCLUDE\" \"NODE_FUNCTION_ALLOW_BUILTIN\" \"NODE_FUNCTION_ALLOW_EXTERNAL\" \"N8N_COMMUNITY_PACKAGES_ENABLED\" \"N8N_SKIP_AUTH_ON_OAUTH_CALLBACK\" \"N8N_GIT_NODE_DISABLE_BARE_REPOS\" \"N8N_GIT_NODE_ENABLE_HOOKS\" \"N8N_SSRF_PROTECTION_ENABLED\" \"N8N_MFA_ENFORCED_ENABLED\" \"N8N_USER_MANAGEMENT_DISABLED\" \"N8N_BASIC_AUTH_ACTIVE\"}}{{$k}} {{index $kv 1}}{{else if eq . (printf \"%s=\" $k)}}{{$k}}={{else}}{{$k}}=[set]{{end}}{{println}}{{end}}","n8n"]`
**expect:** The line `/n8n`, then the listed settings as `NAME value` and every other variable as `NAME=[set]`, or `NAME=` when empty, written by the template on the host (`N8N_ENCRYPTION_KEY`, `DB_POSTGRESDB_PASSWORD` and runner tokens never leave the host). Unset variables take the running version's default. Healthy: `N8N_BLOCK_ENV_ACCESS_IN_NODE true` or unset on 2.0+, `N8N_RESTRICT_FILE_ACCESS_TO` a dedicated directory, `N8N_SECURE_COOKIE` not `false`, `N8N_RUNNERS_INSECURE_MODE` not `true`, no `*` in `NODE_FUNCTION_ALLOW_BUILTIN` or `NODE_FUNCTION_ALLOW_EXTERNAL`, `NODES_EXCLUDE` not `[]`, `N8N_SKIP_AUTH_ON_OAUTH_CALLBACK` not `true`. `Error: No such object: n8n` means the container has another name: unavailable.
**scrub:** env

### rest-unauth: Internal API refuses callers without a session

**via:** `http`
**argv:** `["GET"]`
**path:** /rest/workflows
**expect:** 401. A 200 means workflows are served to anonymous callers.
**scrub:** none

### public-api-unauth: Public API refuses callers without a key

**via:** `http`
**argv:** `["GET"]`
**path:** /api/v1/workflows
**expect:** 401 (public API on, `X-N8N-API-KEY` required) or 404 (public API disabled). A 200 means the public API answers without a key.
**scrub:** none

### api-docs: Public API docs not published

**via:** `http`
**argv:** `["GET"]`
**path:** /api/v1/docs/
**expect:** 404 (public API or its Swagger UI disabled) or 401/403 from the edge. A 200 or a redirect into the docs means the API playground is public.
**scrub:** none

### metrics: Metrics endpoint not public

**via:** `http`
**argv:** `["GET"]`
**path:** /metrics
**expect:** 404 (metrics off, or the proxy does not route it) or 401/403. A 200 with a `text/plain` content type means Prometheus metrics are public.
**scrub:** none

### edge: TLS and headers at the edge

**via:** `http`
**argv:** `["HEAD"]`
**path:** /
**expect:** 200 (or a redirect to the sign-in page) over https with a `Strict-Transport-Security` header. A plain-http live URL, or https without HSTS, is what edge-tls looks at.
**scrub:** none

### webhook-route: Webhook routing on the public edge

**via:** `http`
**argv:** `["GET"]`
**path:** /webhook/rampart-probe-unregistered
**expect:** 404 (n8n answers that the webhook is not registered, or the proxy does not route `/webhook/`). This shows whether webhook routes are public; it never triggers a workflow.
**scrub:** none

## Sources

- https://owasp.org/Top10/2025/ (2026-10-23)
- https://github.com/OWASP/ASVS/tree/v5.0.0 (2026-10-23)
- https://docs.n8n.io/hosting/securing/overview/ (2026-10-23)
- https://docs.n8n.io/hosting/configuration/environment-variables/security/ (2026-10-23)
- https://docs.n8n.io/2-0-breaking-changes/ (2026-10-23)
- https://docs.n8n.io/1-0-migration-checklist/ (2026-10-23)
- https://docs.n8n.io/deploy/host-n8n/configure-n8n/security/disable-the-public-api.md (2026-10-23)
- https://docs.n8n.io/deploy/host-n8n/configure-n8n/security/enable-ssrf-protection.md (2026-10-23)
- https://docs.n8n.io/deploy/host-n8n/configure-n8n/security/harden-task-runners.md (2026-10-23)
- https://github.com/n8n-io/n8n/security/advisories (2026-10-23)
- https://github.com/n8n-io/n8n/blob/master/docker/images/n8n/Dockerfile (2026-10-23)
