---
name: node-api
version: 1.0.0
appliesTo:
  - node-api
kinds:
  - code
sources:
  - https://owasp.org/Top10/2025/ | 2026-10-23
  - https://github.com/OWASP/ASVS/tree/v5.0.0 | 2026-10-23
  - https://expressjs.com/en/advanced/best-practice-security/ | 2026-10-23
  - https://nodejs.org/learn/getting-started/security-best-practices | 2026-10-23
  - https://cheatsheetseries.owasp.org/cheatsheets/Nodejs_Security_Cheat_Sheet.html | 2026-10-23
  - https://cheatsheetseries.owasp.org/cheatsheets/Mass_Assignment_Cheat_Sheet.html | 2026-10-23
  - https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/ | 2026-10-23
lastReviewed: 2026-10-23
---

<!-- Code pack for Node HTTP APIs: Express, Fastify, Hono, Koa and NestJS. Each class below is handed verbatim to one hunter per
     code unit and, for its Confirm by and Disprove by paragraphs, to the verifiers. Write for an agent reading real code. -->

# Node API

## Hunt classes

### authz-scoping: Record access not scoped to the caller

**Look for:** Handlers that load, change or delete a record by an id from `req.params`, `req.query` or `req.body` (Fastify `request.params`, Hono `c.req.param()`, NestJS `@Param()`) and never tie it to the authenticated caller: `Order.findById(req.params.id)`, `prisma.order.update({ where: { id } })`, ``db.query('select * from orders where id = $1', [id])``. Typical shape: an authentication middleware is present (`router.get('/orders/:id', requireAuth, ...)`, Fastify `preHandler: [authenticate]`, Hono `jwt()`, NestJS `@UseGuards(AuthGuard('jwt'))`) but nothing checks ownership. Also the subject taken from input (`req.body.userId`, `req.query.accountId`) instead of `req.user`, role checks against a client-sent role, and Express routes registered before the `app.use(authMiddleware)` line or on a router the middleware is not mounted on (Express runs middleware in registration order).
**Confirm by:** Name the route (method, path, file:symbol) and the data call. Show (1) a caller who does not own the record, or an anonymous caller, reaches the handler (check the middleware order and router mounts), (2) the query has no condition derived from `req.user` or the verified token, (3) no authorization helper runs on the loaded record before it is returned or written, and (4) the record or change reaches the response or the database.
**Disprove by:** The query includes the caller (`findOne({ _id: id, owner: req.user.id })`, `where: { id, userId: req.user.id }`); a policy or guard runs on the path and checks the resource (`authorize('order:read')` that loads and compares, CASL `ForbiddenError.from(ability).throwUnlessCan`, a NestJS guard or interceptor that checks ownership, Casbin, Cerbos, Oso); the database enforces it (Postgres row-level security with the caller's identity set per request through `set_config` or `SET LOCAL ROLE`); the resource is public by design; or the route is admin-only behind a server-side role check. Unguessable ids are not a control on their own.
**Severity when confirmed:** HIGH. Any authenticated caller reads or changes another user's records. CRITICAL when no authentication is needed or the records hold credentials, payment or health data; MEDIUM when the exposed fields are low-sensitivity and ids cannot be learned without a separate leak.
**CWE:** CWE-639, CWE-862, CWE-863

### tenant-isolation: One tenant reaches another tenant's data

**Look for:** Multi-tenant APIs (an `orgId`, `tenantId`, `accountId` or `workspaceId` column, routes like `/orgs/:orgId/...`, tenant from subdomain or an `X-Tenant-Id` header) where the tenant used in a query comes from the path, body, query or a client header and is never checked against the caller's memberships or the token's tenant claim. Also shared caches (Redis keys such as ``cache:${resourceId}``, in-memory LRU) that omit the tenant, background jobs and queue consumers that take `tenantId` from the message without re-checking, and connection-per-tenant setups that pick the database from input. If the API has no tenant concept, this class does not apply: report nothing.
**Confirm by:** Show the tenant that scopes the query comes from client input (name it) and that no membership check or claim comparison runs before the query, or show a cache key that lacks the tenant while the cached value is tenant data. Name the request a member of tenant A sends to read or change tenant B's data.
**Disprove by:** A tenant middleware resolves the tenant from the verified token or session and rejects a mismatch with the path (`if (req.params.orgId !== req.user.orgId) return 403`); a membership lookup tied to `req.user.id` gates the query; an ORM-level tenant scope (Prisma client extension, Sequelize default scope, Mongoose plugin) injects the tenant from the request context; Postgres row-level security keys on a per-request tenant setting; cache keys include the tenant. A single-tenant API is not a finding under this class.
**Severity when confirmed:** HIGH. A member of one organization reads or changes another organization's data. CRITICAL when no authentication is needed or the cross-tenant path writes to billing, members or credentials.
**CWE:** CWE-566, CWE-639, CWE-668

### bulk-export: Lists and exports that hand out more than the caller may see

**Look for:** Endpoints that return many records or a file: `GET /users`, `/export`, `/reports/*.csv`, admin list routes, GraphQL list resolvers, `find({})`, `findMany()` or `SELECT *` without a filter scoped to the caller or tenant, `populate` or `include` that pulls related records of other users, and responses that serialize whole documents (Mongoose documents, Sequelize instances, `res.json(rows)`) including hidden columns. Also export routes behind only `requireAuth` when the business rule says admins only. A missing page-size cap on the caller's own data is an availability concern, not this class.
**Confirm by:** Show the list or export query (file:symbol) and its result reaching the response, then show either that it is not scoped to what the caller may see, or that a role that should not export can call it (no server-side role check), or that it returns sensitive fields of other users (hashes, tokens, contact details) the client never needs. Name the rows or fields a low-privilege caller gets.
**Disprove by:** The query is filtered by `req.user` or a membership-checked tenant; a role or policy check guards the route; a projection or serializer limits fields (`select('-hash')`, Mongoose `select: false` on the schema field, `toJSON` transform, class-transformer `@Exclude()`, Fastify response schema, which drops properties not in the schema); or the data is public by design. Rate limits and page-size caps are hardening.
**Severity when confirmed:** HIGH. One request downloads records of many users or tenants. CRITICAL when no authentication is needed or the export holds credentials, payment or health data; MEDIUM when the over-shared fields are low-sensitivity and already visible to the same members elsewhere.
**CWE:** CWE-200, CWE-359, CWE-862

### session-handling: Forgeable or unverified tokens and sessions

**Look for:** Identity established from something the client can forge: `jwt.decode()` used where `jwt.verify()` is needed, `jwt.verify` without an `algorithms` list when the key could be a public key (algorithm confusion) or with `none` allowed, a secret with a literal fallback (`process.env.JWT_SECRET || 'secret'`), an `X-User-Id` header or an unsigned cookie trusted as identity, passport strategies whose verify callback accepts without checking, `express-session` or `cookie-session` with a hard-coded or default secret, sessions not regenerated after login (`req.session.regenerate` absent), logout or credential change that leaves refresh tokens valid, reset or invite tokens from `Math.random` or without expiry or single use, API keys compared with `===` against a stored plaintext value, and tokens accepted in the query string. Cookie-authenticated state-changing routes with no CSRF defence when cookies are `SameSite=None`.
**Confirm by:** Show the exact weakness on a reachable path: where the identity value is read, and that nothing verifies it before an authorization decision; or the token generator and why it is predictable, long-lived or reusable; or the cross-site request that carries the cookie and passes. Name what an attacker forges or replays and what it gains.
**Disprove by:** Tokens are verified by a maintained library with pinned algorithms and audience or issuer checks (`jose` `jwtVerify(token, key, { algorithms: ['HS256'] })`, `jsonwebtoken` `verify` with `algorithms`, `@fastify/jwt`, `passport-jwt` with `algorithms`), the secret is required at start-up with no fallback (the process exits when it is missing), session ids are regenerated on login, reset tokens are random (`crypto.randomBytes`), hashed at rest, expiring and deleted on use, and CSRF is handled by `SameSite=Lax`/`Strict` cookies, a token middleware or an Origin check. A missing cookie flag alone (`httpOnly`, `secure`) is L1 hardening, not a finding.
**Severity when confirmed:** HIGH. An attacker acts as another user. CRITICAL when any account, including an admin, can be taken over without interaction (forged tokens, a known fallback secret); MEDIUM for replay windows or cross-site request forgery of low-impact actions.
**CWE:** CWE-287, CWE-345, CWE-347, CWE-384, CWE-352, CWE-640

### search-injection: Input parsed as query syntax by NoSQL, search or filter languages

**Look for:** MongoDB and Mongoose filters that receive a parsed object where a string was expected (`User.findOne({ email: req.body.email })` when the body can carry `{ "$ne": null }` or `{ "$gt": "" }`; Express's `qs` parser turns `?email[$ne]=x` into an object), `$where`, `$expr` or `$regex` built from input, `mongoose.set('strictQuery', false)` combined with filters spread from `req.query`; Elasticsearch/OpenSearch `query_string` or `script` with raw input; Algolia `filters`, Meilisearch `filter`, Typesense `filter_by` strings built by concatenation; Prisma or Sequelize `where` objects spread from `req.query` so callers add conditions on hidden columns; Supabase/PostgREST ``.or(`...${q}...`)`` filter strings; LDAP filters built from input; and `new RegExp(input)` on request data.
**Confirm by:** Show the input reaching the query as syntax (name the sink and the parser that makes it an object or operator) and show the effect: authentication or ownership filters bypassed, rows outside the caller's scope returned, a hidden column probed character by character, or a caller-chosen regex run on server data with catastrophic backtracking.
**Disprove by:** A schema validator rejects non-strings before the query (zod, Joi, ajv, Fastify route `schema` with `type: 'string'`, class-validator `@IsString()` with a `ValidationPipe`); Mongoose `sanitizeFilter: true` or `express-mongo-sanitize` strips `$` keys; the value is cast (`String(req.body.email)`); filter keys are allowlisted; search input goes into a value parameter (`{ match: { field: q } }`); `escapeRegExp` or RE2 guards the pattern; or the index holds only public data.
**Severity when confirmed:** HIGH. The caller reads records beyond their scope or bypasses a login filter. CRITICAL when it bypasses authentication without credentials or exposes every user's data; MEDIUM for a regular-expression denial of service.
**CWE:** CWE-943, CWE-1333, CWE-90

### sql-injection: Request input concatenated into SQL

**Look for:** SQL text built with interpolation or concatenation: `pg` ``pool.query(`... ${x}`)``, `mysql2` `query('... ' + x)`, `knex.raw`, `whereRaw`, `orderByRaw` with template strings, Sequelize `sequelize.query` with interpolation instead of `replacements` or `bind`, `Sequelize.literal(input)`, TypeORM `query(text)` and ``createQueryBuilder().where(`id = ${id}`)``, Prisma `$queryRawUnsafe`, `$executeRawUnsafe` and `Prisma.raw`, Drizzle and Kysely `sql.raw`, `better-sqlite3` `prepare` with built text; and sort, column or table names from `req.query` placed into SQL. Include stored procedures in the repo's migrations that run `EXECUTE` on concatenated input.
**Confirm by:** Trace request input (name it) to the SQL text on a reachable route and show nothing between them forces a safe shape (number, UUID, identifier from a fixed list). Show the statement and where the input lands.
**Disprove by:** Values are bound (`$1` or `?` placeholders with a values array, Sequelize `replacements` or `bind`, TypeORM `.where('id = :id', { id })`, Prisma and Drizzle tagged templates, the ORM's query builder); identifiers come from an allowlist or a fixed map, or are escaped with the driver's identifier function (`pg-format` `%I`, `knex.ref`); input is validated or coerced first (`Number.isInteger`, zod `.uuid()`, Fastify schema `format: 'uuid'`).
**Severity when confirmed:** CRITICAL. Reachable without authentication, the attacker reads or changes the database with the API's role. HIGH when authentication is needed or the database role is limited; MEDIUM when only an `ORDER BY` position is injectable and the role is read-only.
**CWE:** CWE-89

### ssrf: Server-side requests to attacker-chosen URLs

**Look for:** Outbound requests whose URL, host or port comes from input: `fetch(req.body.url)`, `axios.get(req.query.url)`, `got`, `undici.request`, `http.get`; webhook registration and "test webhook" endpoints; image, PDF and HTML-to-PDF renderers (Puppeteer `page.goto(input)`) and link previews; import-from-URL features; `axios` calls with a `baseURL` where a caller-supplied absolute URL in `url` overrides the base; `new URL(input, base)` where an absolute input replaces the base; and redirects followed automatically to internal hosts.
**Confirm by:** Show the input that sets the scheme, host or port and that no allowlist runs on the parsed host before the request; then show the gain: the response is returned to the caller, the request reaches an internal target (cloud metadata such as 169.254.169.254, `localhost` admin ports, private services on the same network, the Docker socket over TCP), or it carries the API's credentials (an `Authorization` header with a server secret).
**Disprove by:** The host is checked after parsing against a fixed allowlist with exact matching (not `startsWith`, `includes` or a regex without anchors); only path segments are user-controlled on a fixed origin and the input cannot be absolute; the resolved address is checked against private and link-local ranges at connect time (`request-filtering-agent`, `ssrf-req-filter`, a custom `lookup`), redirects are disabled or re-checked; or egress goes through a proxy that blocks internal ranges.
**Severity when confirmed:** HIGH. The attacker reaches internal services or cloud credentials through the API. CRITICAL when cloud metadata or an unauthenticated admin interface is reachable without authentication; MEDIUM for a blind request with no internal target and no credentials attached.
**CWE:** CWE-918

### secrets-handling: Secrets exposed through responses, logs or weak defaults

**Look for:** Runtime paths that expose secrets: error handlers that send `err` or `err.stack` with config or connection strings to clients, debug routes returning `process.env` or `config`, request logging (morgan custom tokens, pino or winston serializers, `console.log(req.headers)`) that writes `Authorization` headers, cookies or API keys, secrets placed in JWT payloads or responses, secrets passed to child processes in command lines, outbound requests that send a server key to a caller-chosen host, and literal fallbacks for required secrets (`process.env.STRIPE_KEY || '...'`). Committed literal credentials are L1's secrets scan; this class is about code that exposes secrets at run time.
**Confirm by:** Name the secret variable or field (never its value) and show the path to the response, log or third party, on a reachable path, including the condition under which it happens (an error branch the caller can trigger, a route without authentication).
**Disprove by:** The error handler returns a generic message in production (checks `NODE_ENV` or uses a framework default that hides stacks); logger redaction is configured for the field (pino `redact: ['req.headers.authorization']`, a winston format that strips it); the value is public by design (publishable keys); the debug route is absent in production or behind an admin check; the process refuses to start without the secret instead of falling back.
**Severity when confirmed:** HIGH. A secret that grants database, payment or third-party access reaches an attacker. CRITICAL when an unauthenticated caller can trigger the leak of an admin or database credential; MEDIUM when the secret only reaches internal logs that a limited group can read.
**CWE:** CWE-200, CWE-209, CWE-532, CWE-1188

### deserialization: Untrusted data turned into code or object structure

**Look for:** Request, cookie, queue or stored data reaching an unsafe deserializer or code sink: `node-serialize` `unserialize`, `serialize-to-js` and `funcster` evaluation, `js-yaml` 3.x `load` (4.x `load` is safe), `eval`, `new Function`, `vm.runInContext` or the `vm2` sandbox on input (`vm` is not a security boundary); prototype pollution through deep merge or set-by-path of request JSON (`lodash.merge`, `_.set`, `_.defaultsDeep`, `deepmerge`, `dot-prop`, hand-written recursive merges, `qs` nested objects merged into options) where a polluted property later changes a decision or reaches a sink (`child_process` options such as `shell`, template engine options, `isAdmin` flags); and XML parsers with external entities enabled (`libxmljs` `noent: true`).
**Confirm by:** Show the input reaching the sink on a reachable path and the effect: code runs in the API process, or a polluted key (`__proto__`, `constructor.prototype`) survives the merge and a named property read later changes an authorization, file or process decision, or an external entity reads a local file. Prototype pollution with no reachable property read that matters is not a finding.
**Disprove by:** Input is `JSON.parse`d into a schema validator before use; merge helpers skip `__proto__`, `constructor` and `prototype` or target `Object.create(null)`; the library version is patched against the pollution (check the lockfile); `js-yaml` 4.x or `JSON_SCHEMA`; XML parsing with entities disabled (the default in most parsers); the code sink only ever receives constants; or Node runs with `--disable-proto=throw`.
**Severity when confirmed:** CRITICAL. Code execution in the API process without authentication. HIGH when authentication is needed or the effect is privilege escalation or local file read; MEDIUM when the polluted property only causes a crash loop or non-security behaviour change.
**CWE:** CWE-502, CWE-94, CWE-1321, CWE-611

### misconfig: Configuration that opens a concrete attack path

**Look for:** Server setup that creates a real path: `cors({ origin: true, credentials: true })` or a callback that reflects any `Origin` on a cookie-authenticated API; `app.set('trust proxy', true)` (or Fastify `trustProxy: true`) when `req.ip` feeds an allowlist, rate limit on login or audit decision and the app is reachable without a proxy that overwrites `X-Forwarded-For`; `express.static` or `@fastify/static` rooted at the project directory (serving `.env`, `.git`, source); admin and ops UIs mounted without authentication (Bull Board, Agenda dashboard, `swagger-ui` with try-it-out against production and stored credentials, `/metrics` with business data, `/debug`, `/graphql` with an unauthenticated mutation playground); body parsers with no size limit on unauthenticated routes (`limit: '1gb'`).
**Confirm by:** Name the setting and show the attack in this app: which origin makes credentialed requests and reads which authenticated response, which file the static root serves, what an anonymous caller can do through the mounted admin UI, or which IP-based decision a spoofed `X-Forwarded-For` defeats.
**Disprove by:** CORS allows a fixed list of the app's own origins or the API uses bearer tokens with no cookies; `trust proxy` is set to a hop count or a proxy address and the deployment always sits behind that proxy; the static root is a dedicated `public` folder; admin UIs sit behind an authentication middleware; the oversized body limit applies only to authenticated upload routes. Missing `helmet`, security headers, GraphQL introspection or a verbose `X-Powered-By` header are hardening graded by L1, never findings here.
**Severity when confirmed:** MEDIUM. A configuration choice gives attackers a usable foothold. HIGH when it exposes source and environment files, an admin interface or authenticated data cross-origin; LOW when the exposed surface is informational.
**CWE:** CWE-284, CWE-942, CWE-348, CWE-552

### mass-assignment: Request bodies written wholesale into models

**Look for:** Request bodies passed unfiltered into create or update calls: `User.create(req.body)`, `Model.findByIdAndUpdate(id, req.body)`, `prisma.user.update({ data: req.body })`, `Object.assign(user, req.body)`, `{ ...req.body }` into `save`, Sequelize `update(req.body)` without `fields`, TypeORM `repository.merge(entity, body)`, Knex `.update(req.body)`. The danger is fields a caller must not set: `role`, `isAdmin`, `emailVerified`, `ownerId`, `tenantId`, `balance`, `plan`, `credits`, `stripeCustomerId`.
**Confirm by:** Show the model has a privileged field (name it from the schema or migration), the body flows to the write without a filter that drops it, and the route is reachable by a caller who should not control that field. Show the field is honoured afterwards (read in an authorization check, billing or ownership).
**Disprove by:** A validator strips or rejects unknown keys before the write (zod object parse, which drops unknown keys unless `.passthrough()` is used; Joi `stripUnknown`; NestJS `ValidationPipe({ whitelist: true })` with DTOs; Fastify `schema.body` with `additionalProperties: false` and the default `removeAdditional`); explicit picks (`const { name, bio } = req.body`); Sequelize `fields: ['name']`; Mongoose schema without the field under default strict mode; or the privileged field is overwritten from the session after the spread.
**Severity when confirmed:** HIGH. A caller escalates privileges, changes ownership or moves money. CRITICAL when an unauthenticated sign-up sets an admin role; MEDIUM when only low-impact fields (display flags) can be set.
**CWE:** CWE-915, CWE-269

### path-traversal: File paths built from request input

**Look for:** File system calls with input in the path: `res.sendFile(path.join(dir, req.params.name))` (`path.join` keeps `..`), `res.download`, `fs.readFile`, `fs.createReadStream`, `fs.writeFile` or `unlink` with a name from params, query or body; upload handlers that keep `file.originalname` (multer `diskStorage` `filename` callbacks, busboy); archive extraction that writes entry names without a check (`adm-zip` `extractAllTo` on untrusted archives, `unzipper`, `tar` with absolute paths); template or view names from input (`res.render(req.query.view)`).
**Confirm by:** Show the input reaching the path, that no normalization and prefix check runs before the file call, and the resulting file outside the intended directory (a `../` sequence, an encoded variant the router decodes, an absolute path). Name the file an attacker reads or writes (`.env`, source, `~/.ssh`, a served script).
**Disprove by:** `res.sendFile(name, { root: dir })`, which refuses paths that climb out of `root`; `path.basename(input)`; `path.resolve(base, input)` followed by a check that the result starts with `base + path.sep`; names mapped from ids in the database; generated upload names (`crypto.randomUUID()`); archive libraries or checks that reject entries escaping the target directory.
**Severity when confirmed:** HIGH. The caller reads arbitrary files the process can read, including secrets. CRITICAL when the caller can write files (overwrite code, templates or keys) or no authentication is needed to read secrets; MEDIUM when reads are confined to a non-sensitive directory tree.
**CWE:** CWE-22, CWE-23, CWE-73

### webhook-verification: Inbound webhooks trusted without a valid signature

**Look for:** Webhook routes (`/webhooks/stripe`, `/github`, `/clerk`, `/shopify`, `/twilio`, `/slack`, Supabase or Svix hooks) that act on the body (mark paid, grant a plan, create users, change roles) with no signature check, with a check that runs on re-serialized JSON (`JSON.stringify(req.body)`) and is then disabled or wrapped in a `try` that ignores failure, with the secret falling back to a literal, with a plain `===` comparison of HMACs, or with a signed timestamp that is never checked (replay).
**Confirm by:** Name the route and the state change it makes, then show the request reaches that change without a valid signature: no verify call, a verify call whose failure does not stop the handler, or verification over data that is not the raw body (so it can never pass and is bypassed). Show an attacker can send the request (the route is public).
**Disprove by:** The provider SDK verifies the raw body before any change (`stripe.webhooks.constructEvent(rawBody, signature, secret)` with `express.raw({ type: 'application/json' })` on that route, `@octokit/webhooks` `verify`, `svix` `Webhook.verify`, Shopify HMAC with `crypto.timingSafeEqual`); or the handler treats the body only as a hint and re-fetches the object from the provider's API with server credentials before acting; or the route is reachable only from a private network or mTLS gateway declared in code.
**Severity when confirmed:** HIGH. Anyone forges provider events to grant paid features, change balances or create privileged accounts. CRITICAL when a forged event creates an admin or moves money; MEDIUM when forged events only trigger notifications or idempotent syncs, or when only a replay window is missing.
**CWE:** CWE-345, CWE-347, CWE-294

## Baseline

A healthy Node API authenticates every non-public route with a maintained library that verifies tokens with pinned algorithms, then authorizes per resource: queries include the caller or a membership-checked tenant, or a central policy runs before data leaves. Request bodies, params and queries pass a schema validator (zod, Joi, ajv or Fastify route schemas, NestJS `ValidationPipe` with `whitelist`) that rejects unknown keys and wrong types before they reach the database. SQL is parameterized; NoSQL filters receive only scalars. Responses go through a serializer or response schema that drops hidden fields. Outbound requests go to fixed origins or an allowlist with address checks. Secrets are required at start-up with no fallback and are redacted from logs and errors. Webhooks are verified on the raw body. CORS lists the app's own origins. Security headers (`helmet`) are graded by L1 as hardening.

## Sources

- https://owasp.org/Top10/2025/ (2026-10-23)
- https://github.com/OWASP/ASVS/tree/v5.0.0 (2026-10-23)
- https://expressjs.com/en/advanced/best-practice-security/ (2026-10-23)
- https://nodejs.org/learn/getting-started/security-best-practices (2026-10-23)
- https://cheatsheetseries.owasp.org/cheatsheets/Nodejs_Security_Cheat_Sheet.html (2026-10-23)
- https://cheatsheetseries.owasp.org/cheatsheets/Mass_Assignment_Cheat_Sheet.html (2026-10-23)
- https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/ (2026-10-23)
