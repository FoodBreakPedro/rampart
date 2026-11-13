---
name: cloudflare-workers
version: 1.0.0
appliesTo:
  - cloudflare-workers
kinds:
  - code
sources:
  - https://owasp.org/Top10/2025/ | 2026-10-23
  - https://github.com/OWASP/ASVS/tree/v5.0.0 | 2026-10-23
  - https://developers.cloudflare.com/workers/reference/security-model/ | 2026-10-23
  - https://developers.cloudflare.com/workers/configuration/secrets/ | 2026-10-23
  - https://developers.cloudflare.com/workers/configuration/environment-variables/ | 2026-10-23
  - https://developers.cloudflare.com/workers/runtime-apis/bindings/ | 2026-10-23
  - https://developers.cloudflare.com/d1/worker-api/prepared-statements/ | 2026-10-23
  - https://developers.cloudflare.com/workers/runtime-apis/cache/ | 2026-10-23
  - https://developers.cloudflare.com/workers/configuration/routing/workers-dev/ | 2026-10-23
  - https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/ | 2026-10-23
  - https://developers.cloudflare.com/workers/best-practices/workers-best-practices/ | 2026-10-23
lastReviewed: 2026-10-23
---

<!-- Code pack for Cloudflare Workers and Pages Functions: module workers (`export default { fetch(request, env, ctx) }`), Hono or
     itty-router on Workers, Durable Objects, Queues consumers, and their bindings (KV, D1, R2, Durable Objects, service bindings,
     Hyperdrive). Each class below is handed verbatim to one hunter per code unit and, for its Confirm by and Disprove by
     paragraphs, to the verifiers. Wrangler config is `wrangler.toml`, `wrangler.json` or `wrangler.jsonc`. -->

# Cloudflare Workers

## Hunt classes

### authz-scoping: Binding access not scoped to the caller

**Look for:** Handlers (`fetch(request, env, ctx)`, Hono `app.get('/docs/:id', ...)`, itty-router routes, Pages Functions `onRequest`) that read or change storage by an id or key from the URL, query or body without tying it to the authenticated caller: D1 ``env.DB.prepare('SELECT * FROM docs WHERE id = ?').bind(id)`` with no owner condition, KV ``env.KV.get(`doc:${id}`)`` where the key has no user component, R2 `env.BUCKET.get(key)` with `key` taken from the path, Durable Objects addressed by a client-supplied name (`env.ROOM.idFromName(url.searchParams.get('room'))`) whose methods trust any caller, and handlers that authenticate (verify a token) but never compare the subject to the resource owner. Also routes registered before or outside the authentication middleware (Hono `app.use('/api/*', auth)` that does not cover `/v1/...`).
**Confirm by:** Name the route and the binding call. Show (1) a caller who does not own the resource, or an anonymous caller, reaches the handler, (2) the D1 query, KV key or R2 key has no component derived from the verified identity, (3) nothing checks ownership on the loaded value before it is returned or changed, and (4) the value or change reaches the response or storage.
**Disprove by:** The query binds the caller (`WHERE id = ? AND owner_id = ?` bound with the verified subject); KV and R2 keys are built from the verified user id (``user:${sub}:doc:${id}``) and the id cannot contain a separator that climbs out; the Durable Object id comes from the verified identity, or the object checks the caller on every method; a policy check runs on the loaded record; the resource is public by design.
**Severity when confirmed:** HIGH. Any authenticated caller reads or changes another user's data. CRITICAL when no authentication is needed or the data is credentials, payment or health records; MEDIUM when keys cannot be learned without a separate leak and the data is low-sensitivity.
**CWE:** CWE-639, CWE-862, CWE-863

### tenant-isolation: One tenant reaches another tenant's data

**Look for:** Multi-tenant Workers where the tenant comes from the hostname (`new URL(request.url).hostname` split into a subdomain), a header (`X-Tenant-Id`), the path or the body, and selects storage without a membership check: D1 queries filtered by that tenant, KV and R2 key prefixes built from it, per-tenant Durable Objects named from it, and per-tenant D1 databases or bindings chosen from it. Also caches (`caches.default`, KV used as a cache) whose key omits the tenant while the value is tenant data. If the Worker has no tenant concept, this class does not apply: report nothing.
**Confirm by:** Show the tenant that scopes the storage call comes from client input (name it) and that no comparison with the verified identity's tenant or memberships runs before it, or show a cache key without the tenant that serves tenant data. Name the request a member of tenant A sends to reach tenant B's data.
**Disprove by:** The tenant is taken from a verified token claim or a server-side session, or the hostname-derived tenant is compared with the caller's memberships before any storage call; key prefixes and DO names use the verified tenant; caches key on the tenant. A single-tenant Worker is not a finding under this class.
**Severity when confirmed:** HIGH. A member of one organization reads or changes another organization's data. CRITICAL when no authentication is needed or the cross-tenant path writes to billing, members or credentials.
**CWE:** CWE-566, CWE-639, CWE-668

### bulk-export: Listings and exports that hand out more than the caller may see

**Look for:** Routes that enumerate storage: `env.KV.list({ prefix })` or `env.BUCKET.list({ prefix })` with a caller-controlled or empty prefix, D1 `SELECT *` without a filter scoped to the caller or tenant, export routes that stream every row or object, and Durable Object methods that return all stored state. Also responses that return whole rows with hidden columns. A missing page-size cap on the caller's own data is an availability concern, not this class.
**Confirm by:** Show the listing or export call and its result reaching the response, and that it is not scoped to what the caller may see (no prefix or filter from the verified identity), or that a role that should not export can call it. Name the keys, objects or columns a low-privilege caller gets.
**Disprove by:** The list prefix or query filter is built from the verified identity or a membership-checked tenant; a role check guards the route; the response maps rows to an allowlisted set of fields; or the data is public by design (a public asset bucket). Rate limits and page-size caps are hardening.
**Severity when confirmed:** HIGH. One request enumerates or downloads data of many users or tenants. CRITICAL when no authentication is needed or the objects hold credentials, personal or payment data; MEDIUM when only key names or low-sensitivity metadata leak.
**CWE:** CWE-200, CWE-359, CWE-862

### session-handling: Forgeable or unverified tokens and sessions

**Look for:** Identity established from something the client can forge: a JWT whose payload is base64-decoded (`atob(token.split('.')[1])`) without verifying the signature, `jose` `decodeJwt` used where `jwtVerify` is needed, `crypto.subtle.verify` results ignored, HMAC session cookies compared with `===`, a signing secret with a literal fallback (`env.SESSION_SECRET ?? 'dev'`), session records in KV without `expirationTtl` and not deleted on sign-out, reset or magic-link tokens from `Math.random`, and OAuth callbacks that skip the `state` check. Cookie-authenticated state-changing routes accepting cross-site requests (cookies with `SameSite=None` and no Origin or token check). Cloudflare Access headers are the access-header-trust class.
**Confirm by:** Show the exact weakness on a reachable path: where identity is read and that nothing verifies it before an authorization decision; or the token generator and why it is predictable, long-lived or reusable; or the cross-site request that carries the cookie and passes. Name what an attacker forges or replays and what it gains.
**Disprove by:** Tokens are verified with pinned algorithms and audience or issuer checks (`jose` `jwtVerify`, Hono `jwt()` or `verify` with the algorithm set, `crypto.subtle.verify` whose result gates the handler); secrets are required (the Worker fails when `env` lacks them); tokens come from `crypto.getRandomValues` or `crypto.randomUUID`, expire and are deleted on use; cookies are `SameSite=Lax` or `Strict` or state-changing routes check Origin. KV's eventual consistency delaying a revocation by seconds is hardening, and a missing cookie flag alone is L1 hardening.
**Severity when confirmed:** HIGH. An attacker acts as another user. CRITICAL when any account, including an admin, can be taken over without interaction; MEDIUM for replay windows or cross-site request forgery of low-impact actions.
**CWE:** CWE-287, CWE-345, CWE-347, CWE-352, CWE-384

### search-injection: Input parsed as key paths, list prefixes or query syntax

**Look for:** Input that becomes structure rather than a value: KV and R2 keys or list prefixes built by concatenating input that may contain the key separator (``env.KV.get(`${tenant}:${input}`)`` where `input` holds `:` or `/`, ``env.BUCKET.get(`uploads/${userId}/${name}`)`` where `name` holds `../` or a different user id); D1 FTS5 `MATCH ?` with input, where FTS query syntax (column filters such as `secret_col:term`, `OR`, `NEAR`) reaches columns the caller should not search; Vectorize or AI Search metadata filters built from a parsed client object; external search services (Algolia `filters`, Meilisearch `filter`) called with concatenated strings; and `new RegExp(input)` over stored data.
**Confirm by:** Show the input reaching the key, prefix or query as syntax and the effect: another user's or tenant's key is read or listed, a hidden FTS column is searched, a filter hiding private records is bypassed, or a caller-chosen regex burns the CPU limit on every request.
**Disprove by:** Input is validated against a strict pattern before use (`/^[A-Za-z0-9_-]{1,64}$/`, a UUID check) so it cannot contain separators; key components come from the verified identity; the FTS table indexes only columns every caller may search, or input is quoted as an FTS string literal; filter objects are built from allowlisted fields with values only; `escapeRegExp` guards the pattern.
**Severity when confirmed:** HIGH. The caller reads or lists data outside their scope. CRITICAL when no authentication is needed and other users' private objects can be read; MEDIUM for regular-expression denial of service or widened public results.
**CWE:** CWE-943, CWE-74, CWE-1333

### sql-injection: Request input concatenated into D1 or Hyperdrive SQL

**Look for:** SQL text built with interpolation: ``env.DB.prepare(`SELECT ... WHERE name = '${q}'`)``, `env.DB.exec(text)` with input in `text` (`exec` takes raw SQL and no bindings), `env.DB.batch` of prepared statements built from strings, Drizzle `sql.raw` over D1, and `postgres` or `pg` clients over Hyperdrive with interpolated text; plus `ORDER BY`, column or table names taken from the query string.
**Confirm by:** Trace request input (name it) to the SQL text on a reachable route and show nothing between them forces a safe shape (integer, UUID, identifier from a fixed list). Show the statement and where the input lands.
**Disprove by:** Values are bound with `.bind(...)` on `prepare('... ?')` or `?1`, `?2` numbered parameters; Drizzle or Kysely query builders or tagged `sql` templates; identifiers come from an allowlist or a fixed map; `exec` only ever receives constant migration text; the input is validated or coerced first.
**Severity when confirmed:** CRITICAL. Reachable without authentication, the attacker reads or changes the D1 or Postgres database. HIGH when authentication is needed or the database holds only the caller's data; MEDIUM when only an `ORDER BY` position is injectable.
**CWE:** CWE-89

### ssrf: Worker fetches to attacker-chosen URLs

**Look for:** `fetch(url)` where the URL, host or scheme comes from input: proxy and "fetch this URL" routes, image resizing or HTML rewriting of a user URL, link previews, webhook senders with user-registered URLs, and pass-through proxies that rebuild the upstream URL from the incoming one (`fetch(new URL(url.pathname + url.search, input))`, ``fetch(`https://${request.headers.get('x-upstream')}${url.pathname}`)``). A Worker runs on Cloudflare's network, not inside the owner's network, so there is no cloud metadata service or private subnet behind it as on a VM; the targets that matter are origins and services that trust the Worker: origins behind Cloudflare that allow traffic from the Worker or skip the WAF, private networks reached through Workers VPC, Tunnel or Hyperdrive bindings, and requests that attach `env` secrets (`Authorization: Bearer` with a server key) to whatever host was given.
**Confirm by:** Show the input that sets the host or scheme and that no allowlist runs on the parsed host, then show the gain: the response is returned to the caller, the request reaches an origin or private service that trusts the Worker, or a server credential from `env` is sent to the attacker's host.
**Disprove by:** The host is checked after `new URL()` against a fixed allowlist with exact matching; only path segments are user-controlled on a fixed origin and cannot be absolute; credentials are attached only for the fixed upstream; or the endpoint fetches only public URLs, returns nothing sensitive and attaches no credentials, which is at most hardening (open proxy abuse is an availability and reputation issue).
**Severity when confirmed:** HIGH. The attacker leaks a server credential or reaches an origin or private service that trusts the Worker. CRITICAL when that service is an unauthenticated admin or database interface reachable without authentication; MEDIUM for a reflected fetch of arbitrary public URLs with no credentials.
**CWE:** CWE-918, CWE-201

### secrets-handling: Secrets in plaintext config, responses or logs

**Look for:** Sensitive values declared as plaintext `vars` in the Wrangler config (`[vars]` in `wrangler.toml`, `"vars"` in `wrangler.jsonc`) whose names say secret, token, key, private or a paid API, instead of secrets set with `wrangler secret put` or Secrets Store bindings (plaintext vars are stored in config and shown in the dashboard); runtime paths that expose secrets: handlers returning `env`, an error with `env` contents or a stack trace to the client, `console.log(env)` or logging `Authorization` headers (kept by Workers Logs and `wrangler tail`), secrets embedded in HTML or JSON sent to the browser, and static assets directories that include `.dev.vars` or `.env`. Committed literal credentials (including a tracked `.dev.vars`) are L1's secrets scan; name the config entry and the code path here.
**Confirm by:** Name the variable or binding (never its value) and show where it is declared (a `vars` entry) or the code path that sends it to a response, a log or a third party, and what it grants (an API billed to the owner, admin access to an upstream, signing ability).
**Disprove by:** The value is declared as a secret (`wrangler secret put`, a Secrets Store binding, a CI secret applied at deploy) and `vars` holds only non-sensitive settings; handlers return generic errors; logs redact headers; the value is public by design (a publishable key, a public site id).
**Severity when confirmed:** HIGH. A secret is readable by anyone with dashboard or repo access, or leaks to clients and logs. CRITICAL when an unauthenticated request returns an admin or payment secret; MEDIUM when a low-privilege token sits in plaintext `vars` visible only to account members.
**CWE:** CWE-312, CWE-532, CWE-200, CWE-209

### deserialization: Untrusted data turned into object structure or trusted context

**Look for:** The Workers runtime blocks `eval` and `new Function` by default, so code-execution deserializers rarely apply; report one only if the code bundles an interpreter or sandbox that evaluates input. Focus on: prototype pollution through deep merge or set-by-path of request JSON (`lodash.merge`, `defu`, hand-written merges) where a polluted property later changes a decision; Queue consumers (`queue(batch, env)`) and Durable Object `webSocketMessage` handlers that trust `userId`, `role` or `tenantId` fields in message bodies that originate from client input; and cookies or KV values holding serialized state (JSON or base64) that is trusted for authorization without a signature.
**Confirm by:** Show the untrusted source, the place it is deserialized, and the effect: a polluted key changes an authorization decision, a consumer acts with a privilege taken from a client-written message, or an unsigned serialized cookie grants a role when edited.
**Disprove by:** Input passes a schema validator before use; merge helpers skip `__proto__`, `constructor` and `prototype`; the producer sets identity fields from the verified caller and the consumer only receives messages from that producer; serialized state is signed (HMAC with `crypto.subtle`) or encrypted and verified before use.
**Severity when confirmed:** HIGH. A caller escalates privileges by shaping serialized data. CRITICAL when the escalation is to admin without authentication; MEDIUM when the effect is limited to non-security behaviour that still matters (poisoned queue processing, crash loops).
**CWE:** CWE-502, CWE-1321, CWE-565

### misconfig: Wrangler and routing configuration that opens a concrete path

**Look for:** Settings in the Wrangler config and code that create a real path: CORS that reflects any `Origin` with `Access-Control-Allow-Credentials: true` on cookie-authenticated routes; `assets.directory` or Pages output pointing at the project root (serving source, `.dev.vars`, `.git`); an R2 bucket with public access (`r2.dev` URL or a public custom domain) used for private uploads; `routes` or `custom_domain` patterns that send an admin path to a Worker with no auth; debug, seed or migration endpoints left in the Worker. Exposure through `workers_dev` and `preview_urls` matters when a check lives in front of the Worker (Access, WAF, a reverse proxy): see access-header-trust.
**Confirm by:** Name the setting or route and show the attack in this Worker: which origin can make credentialed requests and read which response, which files the assets directory serves, which private objects the public bucket exposes, or what an anonymous caller does through the debug route in production.
**Disprove by:** CORS lists the app's own origins or the API uses bearer tokens with no cookies; the assets directory is a dedicated build folder; the bucket is private and objects are served through an authenticated Worker or signed URLs; debug routes are absent from production builds or require a secret checked in code. Missing security headers, HSTS or a CSP are hardening graded by L1, never findings here.
**Severity when confirmed:** MEDIUM. A configuration choice gives attackers a usable foothold. HIGH when it exposes private objects, source with secrets, an admin function or authenticated data cross-origin; LOW when the exposed surface is informational.
**CWE:** CWE-284, CWE-942, CWE-552, CWE-489

### access-header-trust: Identity trusted from Cloudflare Access headers without verification

**Look for:** Workers that rely on Cloudflare Access or another gateway for authentication and read identity from request headers: `Cf-Access-Authenticated-User-Email`, `Cf-Access-Jwt-Assertion` decoded without verification, `CF_Authorization` cookie payload parsed with `atob`, or custom headers set by a fronting proxy (`X-User`, `X-Forwarded-User`). Then check whether the Worker is reachable without passing the gateway: `workers_dev` not set to `false` (the `*.workers.dev` URL), `preview_urls` enabled, other `routes` or a `custom_domain` not covered by the Access application, or service bindings from public Workers.
**Confirm by:** Show the header or cookie the Worker trusts for identity and that its signature and audience are not verified, and show an alternate route that reaches the same handler without the gateway (name the config entry). Name what an attacker gains by sending the header themselves (an admin email, another user's identity).
**Disprove by:** The Worker verifies the Access JWT on every request (`jose` `jwtVerify` with `createRemoteJWKSet` on the team's `/cdn-cgi/access/certs` endpoint, checking `aud` against the application's audience tag and the issuer); or `workers_dev` is `false`, `preview_urls` is `false` and every route and custom domain is covered by the Access application, so the header cannot arrive from anyone else (say which entries prove it); or the header is used only for display, not authorization.
**Severity when confirmed:** CRITICAL. An unauthenticated attacker sets the header and becomes any user, including an admin. HIGH when the alternate route is harder to reach (preview URLs only) or the impersonated identities hold limited rights.
**CWE:** CWE-290, CWE-288, CWE-345

### cache-poisoning: Private responses cached for everyone, or cache keys that can be poisoned

**Look for:** Workers that cache with the Cache API (`caches.default.put(request, response)`, `caches.open(name)`) or `fetch` options (`cf: { cacheEverything: true, cacheTtl, cacheKey }`) where the response depends on the caller (an `Authorization` header, a session cookie, the user's tenant) but the cache key is only the URL; custom `cacheKey` values that drop the query parameters or headers the response varies on; responses that reflect unkeyed request headers (`X-Forwarded-Host`, `X-Original-URL`, `Accept-Language`) into the body or links and are then cached; and KV used as a response cache with keys that omit the user.
**Confirm by:** Show the response depends on per-user or per-header input (name it), the cache key that lacks that input (the `put` or `cacheKey` call), and that later requests from other callers are served from that entry. For poisoning, show the reflected unkeyed header and the cached page it changes for every visitor.
**Disprove by:** Only unauthenticated, public responses are cached (the code skips caching when `Authorization` or the session cookie is present); the cache key includes the user, tenant or varying header; per-user responses carry `Set-Cookie` (never stored by the Cache API) or `Cache-Control: private`/`no-store` and the code does not override them; reflected headers are validated against an allowlist before use.
**Severity when confirmed:** HIGH. One user's private data is served to others, or an attacker changes a cached page for every visitor (stored script injection). CRITICAL when the cached private responses include credentials or session tokens; MEDIUM when the poisoned content is a harmless redirect or a denial of service on one URL.
**CWE:** CWE-524, CWE-349, CWE-639

## Baseline

A healthy Worker verifies every non-public request itself with a maintained JWT library and pinned algorithms, including the Access JWT when Cloudflare Access fronts it, and sets `workers_dev = false` and `preview_urls = false` when a gateway is the outer check. Storage access is scoped: D1 queries bind the verified subject or a membership-checked tenant, KV and R2 keys and list prefixes start from the verified identity and validated components, and Durable Object ids come from the verified identity. SQL uses `prepare(...).bind(...)` and `exec` runs only constant migrations. Secrets are set with `wrangler secret put` or a Secrets Store binding, never as plaintext `vars`, and are never returned or logged. Outbound fetches go to fixed upstreams, and credentials are attached only for them. Only public responses are cached, under keys that include whatever the response varies on. Security headers are graded by L1 as hardening.

## Sources

- https://owasp.org/Top10/2025/ (2026-10-23)
- https://github.com/OWASP/ASVS/tree/v5.0.0 (2026-10-23)
- https://developers.cloudflare.com/workers/reference/security-model/ (2026-10-23)
- https://developers.cloudflare.com/workers/configuration/secrets/ (2026-10-23)
- https://developers.cloudflare.com/workers/configuration/environment-variables/ (2026-10-23)
- https://developers.cloudflare.com/workers/runtime-apis/bindings/ (2026-10-23)
- https://developers.cloudflare.com/d1/worker-api/prepared-statements/ (2026-10-23)
- https://developers.cloudflare.com/workers/runtime-apis/cache/ (2026-10-23)
- https://developers.cloudflare.com/workers/configuration/routing/workers-dev/ (2026-10-23)
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/ (2026-10-23)
- https://developers.cloudflare.com/workers/best-practices/workers-best-practices/ (2026-10-23)
