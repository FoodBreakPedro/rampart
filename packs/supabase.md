---
name: supabase
version: 1.0.0
appliesTo:
  - supabase
kinds:
  - host
sources:
  - https://owasp.org/Top10/2025/ | 2026-10-23
  - https://github.com/OWASP/ASVS/tree/v5.0.0 | 2026-10-23
  - https://supabase.com/docs/guides/self-hosting/docker | 2026-10-23
  - https://github.com/supabase/supabase/blob/master/docker/docker-compose.yml | 2026-10-23
  - https://github.com/supabase/supabase/blob/master/docker/.env.example | 2026-10-23
  - https://github.com/supabase/auth/blob/master/example.env | 2026-10-23
  - https://supabase.com/docs/guides/database/database-linter | 2026-10-23
  - https://supabase.com/docs/guides/database/postgres/row-level-security | 2026-10-23
  - https://supabase.com/docs/guides/storage/security/access-control | 2026-10-23
  - https://supabase.com/docs/guides/getting-started/mcp | 2026-10-23
lastReviewed: 2026-10-23
---

<!-- Host pack for self-hosted Supabase (the official docker compose stack). The infra-prober compares the observations of the
     probes below with the Baseline and writes candidates; verifiers try to disprove each one from the same observations. Every
     class must be checkable from probe output: say "unavailable" rather than "clean" when a probe could not run.
     The env probes print values only for an explicit list of non-secret settings (booleans, numbers, URLs); every other variable
     is printed as NAME=value and reduced to NAME=[set] by the scrubber. The default-secrets probe compares values with the published
     .env.example placeholders inside docker's template on the host and prints only the variable name and a marker. Probes use the
     container names the official compose file sets (supabase-auth, supabase-db, ...); a stack that renamed them answers
     "No such object" and those observations are unavailable. -->

# Self-hosted Supabase

## Hunt classes

### default-secrets: Published placeholder secrets still in use

**Look for:** Lines `<NAME> uses-published-default` in the default-secrets observation. The comparison is made on the host against the placeholders shipped in the official `.env.example`: the JWT secret (as `GOTRUE_JWT_SECRET`, `PGRST_JWT_SECRET` or `JWT_SECRET`), the Postgres password (`POSTGRES_PASSWORD`, `PGPASSWORD`) and the Studio dashboard password (`DASHBOARD_PASSWORD` on the `supabase-kong` or `supabase-envoy` gateway). With the published JWT secret anyone can sign a `service_role` token, which bypasses row level security on every table and every storage bucket; the published dashboard password opens Studio; the published Postgres password opens the database to anyone who reaches the pooler.
**Confirm by:** Quote the marker line: the container (`/supabase-auth`) and the variable name, never a value. For the dashboard password add the studio-auth observation (401 with `WWW-Authenticate: Basic` from the live URL shows the placeholder guards a reachable Studio); for the Postgres password add the containers line that publishes the pooler (`0.0.0.0:5432->5432/tcp` or `6543`). The JWT secret needs nothing more than a live API.
**Disprove by:** The observation lists the container names with no marker lines (every compared value differs from the placeholder). If the probe answered `No such object` for `supabase-auth` and `supabase-db`, the comparison never ran: no candidate, and the class stays uncovered rather than clean. One `No such object` for `supabase-kong` or `supabase-envoy` is normal, since a stack runs one gateway.
**Severity when confirmed:** CRITICAL. The JWT placeholder lets anyone mint an admin token, and the dashboard placeholder on a reachable Studio is full database control. HIGH for the Postgres placeholder when the pooler port is published; MEDIUM when neither the pooler nor the database publishes a port, so only the host and its Docker networks reach it.
**CWE:** CWE-1392, CWE-798, CWE-321

### studio-and-meta-exposed: Studio or postgres-meta answering without credentials

**Look for:** studio-auth returning 200 (an HTML page with no `WWW-Authenticate` challenge), so Studio, which runs with the service key, is open to anyone; pg-meta-no-key returning 200, so postgres-meta (schema listing and SQL execution) answers without the service key; containers lines where `supabase-studio` (port 3000) or `supabase-meta` (port 8080) publish a port to all interfaces (`0.0.0.0:` or `[::]:`), which skips the gateway's basic auth and key checks entirely.
**Confirm by:** Quote the status line and the absence of a challenge header from the http observation, or the port mapping from the containers observation with the container name. Say what it gives: Studio's table editor and SQL editor, or postgres-meta's endpoints.
**Disprove by:** studio-auth answers 401 with `WWW-Authenticate: Basic` (the gateway's basic auth is in front; whether its password is the placeholder is default-secrets' question), 403, or 404 (no dashboard route on this URL); pg-meta-no-key answers 401, 403 or 404; Studio and meta publish no port, or publish only on a loopback address. A 401 page that leaks the Studio version in a header is informational, not this class.
**Severity when confirmed:** CRITICAL. An unauthenticated caller administers the database. HIGH when only a published port shows it and no http observation from the live URL reached it, since the observations cannot show whether that port is reachable from outside.
**CWE:** CWE-306, CWE-284

### auth-config: Auth and gateway settings that admit unverified callers

**Look for:** In auth-env: `GOTRUE_MAILER_AUTOCONFIRM true` or `GOTRUE_SMS_AUTOCONFIRM true` (accounts become active without proving they own the address, so any rule that trusts the email, such as an admin email list, a domain-based role or an invite matched by email, is open to whoever types that address); `GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED true` (anonymous sign-ins receive the `authenticated` role, so policies written `TO authenticated` admit them); `GOTRUE_URI_ALLOW_LIST` entries with a wildcard over a host the owner does not control (`**`, `https://*.vercel.app/**`, `https://*.netlify.app/**`), which lets magic-link, recovery and OAuth redirects carry tokens to an attacker's site; `GOTRUE_SITE_URL` or `API_EXTERNAL_URL` on `http://` with a public host name, which sends tokens in URLs over cleartext. In service-env: `VERIFY_JWT false` on `supabase-edge-functions`, which makes every function under `/functions/v1/` callable without a token.
**Confirm by:** Quote the setting name and the printed value and state the consequence in this stack: which identity check is skipped, which wildcard host an attacker can register, or that functions answer anonymous callers. For anonymous sign-ins, cite advisor lint `0012_auth_allow_anonymous_sign_ins` when the run has advisor results.
**Disprove by:** The settings hold the safe values (`false` for autoconfirm, anonymous users off or deliberately on with policies that check `is_anonymous`, allow-list entries that are exact origins or wildcards under the owner's own domain, https URLs, `VERIFY_JWT true`). `GOTRUE_DISABLE_SIGNUP false` on an app with public sign-up is by design. A short `GOTRUE_PASSWORD_MIN_LENGTH`, captcha off, a long `GOTRUE_JWT_EXP`, refresh token rotation settings and absent MFA are hardening, not findings here.
**Severity when confirmed:** MEDIUM. Strangers get an identity the app treats as verified, or functions lose their default gate. HIGH when the allow list admits a host on a shared platform anyone can register (token theft), or when autoconfirm meets email-based authorization the observations name; LOW for an http site URL on a host that only answers on a private network.
**CWE:** CWE-287, CWE-306, CWE-601, CWE-319

### rls-coverage: API-exposed tables without row level security

**Look for:** This class needs Supabase advisor results; the probes cannot see per-table policies without a database login. When the run includes the security advisors (the Supabase MCP server's advisors tool, or Studio's Security Advisor results saved into the run), look for `0013_rls_disabled_in_public`, `0007_policy_exists_rls_disabled`, `0024_permissive_rls_policy` (a write policy whose check is always true), `0002_auth_users_exposed`, `0010_security_definer_view`, `0023_sensitive_columns_exposed`, `0028_anon_security_definer_function_executable` and `0026_pg_graphql_anon_table_exposed`. Cross-check the schema against `PGRST_DB_SCHEMAS` in service-env: a schema listed there is reachable at `/rest/v1/` with the public anon key, which every visitor of the app holds.
**Confirm by:** Name the lint and the object it reports (`schema.table`, view or function) and show its schema is in `PGRST_DB_SCHEMAS` (or that the lint concerns pg_graphql, which exposes it at `/graphql/v1`). Say what an anon-key holder can do: read, insert, update or delete which table.
**Disprove by:** The run has no advisor results: no candidate, since absence of evidence here is not a clean result. The reported schema is not in `PGRST_DB_SCHEMAS` and not exposed by pg_graphql; the lint is `0008_rls_enabled_no_policy`, which denies everything and is safe; the table is reference data the owner documents as public, exposed for SELECT only.
**Severity when confirmed:** HIGH. Anyone with the anon key reads or writes the table. CRITICAL when the table holds personal, payment or auth data, or anonymous callers can write; MEDIUM for read-only access to non-sensitive data.
**CWE:** CWE-862, CWE-284, CWE-639

### storage-access: Buckets and objects readable or listable beyond intent

**Look for:** storage-no-key returning 200, so the bucket API answers a caller with no token at all; advisor lint `0025_public_bucket_allows_listing` (a public bucket whose policies also allow listing, so every file name is discoverable); advisor or service-env evidence that a bucket marked public holds content the app treats as private (names like invoices, documents, exports, backups). Public buckets serve every object at a stable URL with no check; policies on `storage.objects` decide everything else.
**Confirm by:** Quote the http status and headers, or the lint with the bucket name, and say what an anonymous caller obtains: the bucket list, object names, or object contents.
**Disprove by:** storage-no-key answers 400, 401 or 403; the run has no advisor results (no candidate for the policy part); the public bucket holds public assets by design (avatars, product images) and listing is not allowed. A missing file size limit or image transformation settings are hardening.
**Severity when confirmed:** MEDIUM. Files leave without authorization. HIGH when the exposed bucket holds personal or business documents; LOW when only the bucket names are listed.
**CWE:** CWE-284, CWE-200, CWE-552

### exposed-ports: Database and internal services published beyond the host

**Look for:** containers lines where a service other than the gateway publishes a port to all interfaces (`0.0.0.0:` or `[::]:`): the pooler `supabase-pooler` on 5432 or 6543, `supabase-db` on 5432, PostgREST (`supabase-rest`, 3000), Auth (`supabase-auth`, 9999), Storage (`supabase-storage`, 5000), Realtime or Analytics (4000), Studio (3000) or postgres-meta (8080). The official compose file publishes the pooler's 5432 and 6543 on all interfaces by default, and Docker's published ports are not filtered by `ufw` (see the docker-host pack), so a host firewall rule is no defence here.
**Confirm by:** Quote the mapping with the container name and say what an outside caller reaches: a Postgres login (which turns the database password into the only control and invites credential guessing), or an internal API without the gateway's key checks.
**Disprove by:** The port is bound to a loopback address or to a specific private interface address, or is not published; only the gateway publishes. A gateway on 8000 or 8443 is the intended entry point. Studio and meta are covered by studio-and-meta-exposed; report the port here only when that class did not.
**Severity when confirmed:** HIGH. The database or an internal API is reachable without passing the gateway. MEDIUM for the pooler when default-secrets showed the Postgres password is not the placeholder and the system's live URL is on a private network; LOW when the published port belongs to a service with its own authentication and no data (imgproxy behind signed URLs).
**CWE:** CWE-668, CWE-284

### stale-services: Service images behind a release that fixes a security issue

**Look for:** The image tags in the containers observation (`supabase/gotrue:v2.x`, `supabase/postgres:<major>.<minor>.<build>`, `postgrest/postgrest:v<x>`, `supabase/storage-api:v<x>`, `supabase/realtime:v<x>`, `supabase/studio:<date>`, `kong` or `envoyproxy/envoy`, `supabase/supavisor`), compared with the fixed versions named in the vendors' security advisories (supabase/auth, supabase/storage, PostgREST, PostgreSQL minor releases, Kong or Envoy) and with the tags in the current official compose file. Tags `latest` or untagged images hide the version: say so rather than guess.
**Confirm by:** Name the image, the running tag, the advisory (id or title) and the first fixed version, and say whether the affected feature is in use in this stack (for example, a storage advisory needs Storage running).
**Disprove by:** The running tag is at or after the fixed version, the advisory concerns a component this stack does not run, or it needs a configuration the observations show is off. Being behind the latest release without a security fix in between is hardening.
**Severity when confirmed:** HIGH. A service carries a known, fixed vulnerability; follow the advisory's rating, capped at MEDIUM when the affected service publishes no port and is reached only through the gateway with key checks; CRITICAL only for an unauthenticated remote issue in a service the live URL routes to.
**CWE:** CWE-1395, CWE-1104

## Baseline

A healthy self-hosted Supabase runs the official compose services on pinned version tags no older than the last release with a security fix. Only the API gateway (Kong or Envoy, port 8000 or 8443) publishes a port, ideally behind a TLS reverse proxy on the same host; the database, pooler, Studio, postgres-meta and the individual APIs publish nothing, or only on a loopback address. Every secret from `.env.example` was regenerated before first start: no published placeholder remains for the JWT secret, the Postgres password or the dashboard password. Studio answers only behind the gateway's basic auth; postgres-meta, PostgREST and Storage refuse callers without a key. Auth does not auto-confirm email or phone, keeps anonymous sign-ins off unless the app uses them, redirects only to exact origins the owner controls, and uses https URLs. Edge Functions verify JWTs. The Supabase security advisors report no table without row level security in an exposed schema and no public bucket that allows listing.

## Probes

### containers: Supabase containers, images and published ports

**via:** `ssh`
**argv:** `["docker","ps","--format","{{.Names}} {{.Image}} {{.Ports}}"]`
**expect:** One line per running container: name, image with tag, published ports. Healthy: the official names (`supabase-auth`, `supabase-db`, `supabase-rest`, `supabase-storage`, `supabase-studio`, `supabase-meta`, `supabase-pooler`, `supabase-edge-functions`, `supabase-kong` or `supabase-envoy`, `realtime-dev.supabase-realtime`) on version-tagged images; only the gateway shows a mapping to all interfaces (`0.0.0.0:8000->8000/tcp`), or none when a proxy on the host reaches it on a loopback address; database, pooler, Studio and meta show no mapping or a loopback one. A `permission denied` on the Docker socket means the SSH user is not in the docker group: unavailable, not clean.
**scrub:** none

### auth-env: Auth (GoTrue) settings

**via:** `ssh`
**argv:** `["docker","inspect","--format","{{.Name}}{{println}}{{range .Config.Env}}{{$kv := split . \"=\"}}{{$k := index $kv 0}}{{if eq $k \"GOTRUE_DISABLE_SIGNUP\" \"GOTRUE_MAILER_AUTOCONFIRM\" \"GOTRUE_SMS_AUTOCONFIRM\" \"GOTRUE_EXTERNAL_EMAIL_ENABLED\" \"GOTRUE_EXTERNAL_PHONE_ENABLED\" \"GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED\" \"GOTRUE_SITE_URL\" \"API_EXTERNAL_URL\" \"GOTRUE_URI_ALLOW_LIST\" \"GOTRUE_JWT_EXP\" \"GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED\" \"GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION\" \"GOTRUE_MAILER_SECURE_EMAIL_CHANGE_ENABLED\" \"GOTRUE_SECURITY_CAPTCHA_ENABLED\" \"GOTRUE_SECURITY_MANUAL_LINKING_ENABLED\" \"GOTRUE_PASSWORD_MIN_LENGTH\"}}{{$k}} {{index $kv 1}}{{else}}{{.}}{{end}}{{println}}{{end}}","supabase-auth"]`
**expect:** The line `/supabase-auth`, then the listed non-secret settings as `NAME value` and every other variable as `NAME=[set]` (secrets such as `GOTRUE_JWT_SECRET` and `GOTRUE_DB_DATABASE_URL` never show a value). Healthy: `GOTRUE_MAILER_AUTOCONFIRM false`, `GOTRUE_SMS_AUTOCONFIRM false`, `GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED false` unless the app uses anonymous sign-ins, `GOTRUE_DISABLE_SIGNUP true` for invite-only apps, `GOTRUE_SITE_URL` and `API_EXTERNAL_URL` on https, `GOTRUE_URI_ALLOW_LIST` with exact origins or wildcards under the owner's domain only, and `GOTRUE_SMTP_HOST=[set]` so confirmation mail can go out. `Error: No such object: supabase-auth` means the stack uses other container names: unavailable.
**scrub:** env

### service-env: REST, Storage and Edge Functions settings

**via:** `ssh`
**argv:** `["docker","inspect","--format","{{.Name}}{{println}}{{range .Config.Env}}{{$kv := split . \"=\"}}{{$k := index $kv 0}}{{if eq $k \"PGRST_DB_SCHEMAS\" \"PGRST_DB_ANON_ROLE\" \"PGRST_DB_MAX_ROWS\" \"VERIFY_JWT\" \"FILE_SIZE_LIMIT\" \"STORAGE_BACKEND\" \"ENABLE_IMAGE_TRANSFORMATION\"}}{{$k}} {{index $kv 1}}{{else}}{{.}}{{end}}{{println}}{{end}}","supabase-rest","supabase-storage","supabase-edge-functions"]`
**expect:** For each container a `/name` line, then the listed settings as `NAME value` and the rest as `NAME=[set]`. Healthy: `PGRST_DB_SCHEMAS` names only the schemas meant for the API (the default is `public,storage,graphql_public`; never `auth`, `vault` or a private schema), `PGRST_DB_ANON_ROLE anon`, a `PGRST_DB_MAX_ROWS` value, and `VERIFY_JWT true` on `/supabase-edge-functions`. `No such object` for one container means that service is not running under its official name.
**scrub:** env

### default-secrets: Published placeholder secrets still in use

**via:** `ssh`
**argv:** `["docker","inspect","--format","{{.Name}}{{println}}{{range .Config.Env}}{{$kv := split . \"=\"}}{{if eq (index $kv 1) \"your-super-secret-jwt-token-with-at-least-32-characters-long\" \"your-super-secret-and-long-postgres-password\" \"this_password_is_insecure_and_should_be_updated\"}}{{index $kv 0}} uses-published-default{{println}}{{end}}{{end}}","supabase-auth","supabase-db","supabase-kong","supabase-envoy"]`
**expect:** Only the container names (`/supabase-auth`, `/supabase-db`, and one of `/supabase-kong` or `/supabase-envoy`), with no `uses-published-default` line. The values are compared on the host; only the variable name and the marker are ever printed. `No such object` for one of the two gateway names is normal; for `supabase-auth` and `supabase-db` it means the comparison did not run.
**scrub:** env

### studio-auth: Studio behind the gateway's basic auth

**via:** `http`
**argv:** `["GET"]`
**path:** /
**expect:** 401 with a `WWW-Authenticate: Basic` header (Studio is served at the root of the gateway behind basic auth), or 403 or 404 when this URL does not route to Studio. A 200 with an HTML content type and no challenge means Studio is open. Over https, a `Strict-Transport-Security` header.
**scrub:** none

### rest-no-key: REST API refuses callers without a key

**via:** `http`
**argv:** `["GET"]`
**path:** /rest/v1/
**expect:** 401 (the gateway requires an `apikey`); a 200 means PostgREST answers callers without any key, so the gateway is not in front of it.
**scrub:** none

### pg-meta-no-key: postgres-meta refuses callers without the service key

**via:** `http`
**argv:** `["GET"]`
**path:** /pg/tables
**expect:** 401 or 403 (the gateway restricts `/pg/` to the service key), or 404 when the gateway does not route `/pg/` at all. A 200 means postgres-meta answers anonymous callers.
**scrub:** none

### storage-no-key: Storage refuses bucket listing without a token

**via:** `http`
**argv:** `["GET"]`
**path:** /storage/v1/bucket
**expect:** 400, 401 or 403 (Storage requires a JWT to list buckets). A 200 means the bucket API answers a caller with no token.
**scrub:** none

## Sources

- https://owasp.org/Top10/2025/ (2026-10-23)
- https://github.com/OWASP/ASVS/tree/v5.0.0 (2026-10-23)
- https://supabase.com/docs/guides/self-hosting/docker (2026-10-23)
- https://github.com/supabase/supabase/blob/master/docker/docker-compose.yml (2026-10-23)
- https://github.com/supabase/supabase/blob/master/docker/.env.example (2026-10-23)
- https://github.com/supabase/auth/blob/master/example.env (2026-10-23)
- https://supabase.com/docs/guides/database/database-linter (2026-10-23)
- https://supabase.com/docs/guides/database/postgres/row-level-security (2026-10-23)
- https://supabase.com/docs/guides/storage/security/access-control (2026-10-23)
- https://supabase.com/docs/guides/getting-started/mcp (2026-10-23)
