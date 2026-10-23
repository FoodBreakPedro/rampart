---
name: web-nextjs
version: 1.0.0
appliesTo:
  - web-nextjs
kinds:
  - code
sources:
  - https://owasp.org/Top10/2025/ | 2026-10-23
  - https://github.com/OWASP/ASVS/tree/v5.0.0 | 2026-10-23
  - https://nextjs.org/docs/app/guides/data-security | 2026-10-23
  - https://nextjs.org/docs/app/guides/authentication | 2026-10-23
  - https://nextjs.org/blog/security-nextjs-server-components-actions | 2026-10-23
  - https://nextjs.org/docs/app/guides/environment-variables | 2026-10-23
lastReviewed: 2026-10-23
---

<!-- Code pack for Next.js apps (App Router and Pages Router). Each class below is handed verbatim to one hunter per code unit and,
     for its Confirm by and Disprove by paragraphs, to the verifiers. Write for an agent reading real code: name code shapes, name
     the controls that make a candidate false. Next.js 16 renamed middleware.ts to proxy.ts; both names appear on purpose. -->

# Next.js app

## Hunt classes

### authz-scoping: Record access not scoped to the caller

**Look for:** Server code that reads, changes or deletes a record by an id the request supplies and never ties that record to the signed-in user. Entry points: App Router route handlers (`app/**/route.ts` exporting `GET`, `POST`, `PATCH`, `PUT`, `DELETE`), Server Actions (functions under `'use server'`), Pages Router API routes (`pages/api/**`), `getServerSideProps`, and Server Components that load data from `params`, `searchParams` or a dynamic segment such as `[id]`. Data calls: `prisma.x.findUnique({ where: { id } })`, `db.select().from(t).where(eq(t.id, id))`, `supabase.from('t').select().eq('id', id)` with a service-role client, `Model.findById(id)`. Watch for handlers that check only that someone is signed in, a `userId` or `role` read from the body or query instead of the session, and role checks that exist only in the UI (a hidden button).
**Confirm by:** Name the entry point (file:symbol) and the data call. Trace the id from the request to the query and show that (1) a signed-in user who does not own the record, or an anonymous caller, can reach the handler, (2) the query has no condition derived from the session (owner, member, author), (3) no authorization helper runs on the loaded record before it is returned, rendered or written, and (4) the record or the change reaches the response, the rendered page or the database. A check in `middleware.ts` or `proxy.ts` counts only if its matcher covers this route and it compares ownership, which it rarely does.
**Disprove by:** Find the control on the path: the where clause includes the session user (`where: { id, userId: session.user.id }`) or the record is loaded from the session itself (a `/me` route); a central data-access layer or policy call (`assertCanAccess`, `can(user, 'update', doc)`, CASL, Cerbos, Oso, Permit) runs before the result is used; Postgres row-level security applies because the client acts as the user (a Supabase server client built from the request cookies, not the service-role key) and the table has a policy; the record is public by design (published post, product page); or the handler is admin-only behind a server-side role check. Unguessable ids (UUIDs) reduce exposure but are not a control on their own.
**Severity when confirmed:** HIGH. Any signed-in user reads or changes another user's records. CRITICAL when no sign-in is needed or the records hold credentials, payment or health data; MEDIUM when the only exposed fields are low-sensitivity and the ids cannot be learned without a separate leak.
**CWE:** CWE-639, CWE-862, CWE-863

### tenant-isolation: One tenant reaches another tenant's data

**Look for:** Multi-tenant apps (an `orgId`, `teamId`, `workspaceId` or `tenantId` column, routes such as `app/[orgSlug]/...`, subdomain tenants) where the tenant used in a query comes from the URL, the body, a header (`x-tenant-id`, `host`) or a cookie the client controls, and nothing checks that the session user belongs to it. Also caches that mix tenants: `unstable_cache`, `'use cache'`, `fetch` with `next: { revalidate, tags }`, or statically rendered pages whose cache key or tag omits the tenant while the function reads tenant data. If the app has no tenant concept at all, this class does not apply: report nothing.
**Confirm by:** Show the tenant id that scopes the query comes from client input (name the input) and that no membership check against the session runs before the query, or show a cached function that reads tenant data under a key or tag that lacks the tenant id and is served to requests from other tenants. Name the route a member of tenant A uses to read or change tenant B's data.
**Disprove by:** A membership lookup tied to the session (`memberships.findFirst({ where: { orgId, userId: session.user.id } })`) gates the query; the tenant is taken from the session or a server-set claim, never from input; row-level security policies key on the JWT's tenant claim and the client acts as the user; the cache key or tag includes the tenant id, or the cached data is the same for every tenant. A single-tenant app is not a finding under this class.
**Severity when confirmed:** HIGH. A member of one organization reads or changes another organization's data. CRITICAL when no sign-in is needed or the cross-tenant path allows writes to billing, members or credentials.
**CWE:** CWE-566, CWE-639, CWE-668

### bulk-export: Lists and exports that hand out more than the caller may see

**Look for:** Route handlers, Server Actions and pages that return many records at once: CSV, JSON or PDF export routes, report downloads, admin tables, `findMany()` or `select('*')` with no where clause scoped to the user or tenant, GraphQL resolvers that list a collection, `include` or joins that pull related rows owned by other users, and member or user directories that return every column (email, phone, address) of every user. Also export features available to every role when the UI shows them only to admins. A missing page-size cap on the caller's own data is an availability concern, not this class.
**Confirm by:** Show the list or export query (file:symbol) and that its result reaches the response or file, then show either that it is not scoped to what the caller may see (no session-derived filter, no tenant filter), or that the endpoint is callable by a role that should not export (no server-side role check), or that it returns sensitive fields of other users that the page never needs. Name the fields or rows a low-privilege caller gets.
**Disprove by:** The query is filtered by the session user or a membership-checked tenant; a server-side role check (`requireRole('admin')`, a policy call) guards the export; a `select`, `omit` or DTO mapper limits the columns to what the viewer may see; or the data is public by design. Rate limits and page-size caps are hardening, not the control this class is about.
**Severity when confirmed:** HIGH. One request downloads records of many users or tenants. CRITICAL when no sign-in is needed or the export holds credentials, payment or health data; MEDIUM when the over-shared fields are low-sensitivity contact details visible to other members anyway.
**CWE:** CWE-200, CWE-359, CWE-862

### session-handling: Forgeable or unverified sessions

**Look for:** Identity taken from something the client can forge: an unsigned `userId` or `role` cookie, a JWT read with `jwt.decode` or a hand-rolled base64 split instead of a verified signature, `jwt.verify` without pinned `algorithms`, a signing secret with a literal fallback (`process.env.AUTH_SECRET || 'dev'`), or `supabase.auth.getSession()` used for an authorization decision in server code (it trusts the cookie; `getUser()` or `getClaims()` validates it). Auth.js / NextAuth: a Credentials `authorize` that returns a user without checking the secret, `jwt` and `session` callbacks that copy client-controlled values into the token. Reset, magic-link and invite tokens made with `Math.random`, without expiry, or reusable. Login that keeps a pre-login session id. Cookie-authenticated route handlers that change state on `GET` or accept cross-site posts (cookies with `SameSite=None` and no Origin or token check).
**Confirm by:** Show the exact weakness on a reachable path: the value that establishes identity, where it is read, and that nothing verifies it before it is trusted for an authorization decision; or the token generator and that it is predictable, long-lived or reusable; or the state-changing handler and that a cross-site request carries the session cookie and passes. Name what an attacker forges or replays and what it gets them.
**Disprove by:** Identity comes from a maintained library that verifies it (Auth.js `auth()`, Clerk `auth()`, iron-session, `jose` `jwtVerify` with a fixed algorithm and a secret with no literal fallback, Supabase `getUser()` or `getClaims()`); tokens come from `crypto.randomBytes` or `crypto.randomUUID`, are stored hashed, expire and are deleted on use; Server Actions are protected by the built-in Origin and Host comparison; state-changing route handlers require a CSRF token or check Origin, or cookies are `SameSite=Lax` or `Strict`. A missing cookie flag on its own (`httpOnly`, `secure`) is hardening for L1, not a finding.
**Severity when confirmed:** HIGH. An attacker acts as another user. CRITICAL when any account, including an admin, can be taken over without interaction; MEDIUM for cross-site request forgery of low-impact actions or reset tokens that need a second weakness to exploit.
**CWE:** CWE-287, CWE-345, CWE-384, CWE-352, CWE-640

### search-injection: Input parsed as query syntax by a search or filter language

**Look for:** User input placed into a query language as syntax rather than as a value: Supabase/PostgREST filter strings (``.or(`title.ilike.%${q}%`)``, `.filter(col, op, value)` with an operator from input), MongoDB filters built from a parsed body or query object (an object such as `{ "$ne": null }` arriving where a string was expected), `$where` or `$regex` from input, Elasticsearch/OpenSearch `query_string` with raw input, Algolia `filters`, Meilisearch `filter` and Typesense `filter_by` strings built by concatenation on the server, Prisma `where` objects spread from `searchParams` so the caller can add conditions on hidden columns, and `new RegExp(input)` run on the server.
**Confirm by:** Show the input reaches the query as syntax on a server path (name the sink) and show what changes: rows outside the caller's scope come back, a filter that hides private records is bypassed, a condition on a hidden column (a hash or a token) can be probed character by character, or an attacker-chosen regex runs against server data (catastrophic backtracking). A filter the client can already set freely through a public, scoped search key is not injection.
**Disprove by:** The input is passed as a value (``.ilike('title', `%${q}%`)``, `{ match: { title: q } }`, an Algolia `query` parameter rather than `filters`); a schema validator (zod `z.string()`, valibot, yup) rejects objects before the query; Mongoose `sanitizeFilter` or `mongo-sanitize` strips operators; filter keys are checked against an allowlist; `escapeRegExp` or a safe-regex check guards the pattern; or the searched index holds only public data so altered filters expose nothing.
**Severity when confirmed:** HIGH. The caller reads records or fields beyond their scope. CRITICAL when no sign-in is needed and the injected filter exposes credentials or every user's data; MEDIUM for a regular-expression denial of service or a bypass that only widens public results.
**CWE:** CWE-943, CWE-1333

### sql-injection: Request input concatenated into SQL

**Look for:** SQL text built with interpolation or concatenation on a server path: Prisma `$queryRawUnsafe` and `$executeRawUnsafe`, `Prisma.raw(...)`, `$queryRaw` called with a plain string instead of a tagged template; Drizzle `sql.raw(...)`; Knex `.raw`, `whereRaw`, `orderByRaw` with template strings; `pg` ``client.query(`... ${x}`)``; `@vercel/postgres` or Neon `sql.query(text)` with built text; Kysely `sql.raw`; and column or sort names taken from `searchParams` (`orderBy`, `sort`, `dir`) and placed in SQL. Include Supabase `.rpc()` calls when the repo's own migrations define the function with `EXECUTE format('%s', ...)` or string concatenation.
**Confirm by:** Trace request input (name it) to the SQL text on a reachable route handler, Server Action or server render, and show that nothing between them forces a safe shape (a number, a UUID, an identifier from a fixed list). Show the SQL statement and the position the input lands in.
**Disprove by:** Values are bound: tagged templates (``prisma.$queryRaw`... ${x}` ``, Drizzle ``sql`...` ``, postgres.js and `@vercel/postgres` tagged `sql`), `$1` or `?` placeholders with a values array, or the ORM's query builder. Identifiers are checked against an allowlist or a fixed map before use. The input is coerced and validated first (`z.coerce.number().int()`, `z.string().uuid()`, `Number.isInteger`). The raw query only ever receives constants.
**Severity when confirmed:** CRITICAL. Reachable without sign-in, the attacker reads or changes the database with the app's role. HIGH when a signed-in user is needed or the database role is limited to the caller's own data; MEDIUM when only an `ORDER BY` position is injectable and the role is read-only.
**CWE:** CWE-89

### ssrf: Server-side requests to attacker-chosen URLs

**Look for:** Server code that fetches a URL, host or port the request controls: route handlers that proxy images or files, link-preview and unfurl endpoints, Open Graph image routes (`app/api/og`, `opengraph-image.tsx`) that fetch a URL param, "test webhook" actions, import-from-URL features, Server Actions that fetch a user-supplied URL, stored webhook URLs called later by a job, and `new URL(input, base)` where an absolute input replaces the base. Also `next.config` `images.remotePatterns` with `hostname: '**'` on a self-hosted deployment that can reach internal services through `/_next/image`.
**Confirm by:** Show the input that sets the scheme, host or port of the outbound request and that no allowlist runs on the parsed host before the request. Then show what the attacker gains: the response body is returned, or the request reaches something internal (a cloud metadata address such as 169.254.169.254 on a self-hosted VM or container, an admin port on localhost, a private service), or it carries the app's credentials (an `Authorization` header with a server secret).
**Disprove by:** The host is compared, after `new URL()` parsing, against a fixed allowlist with exact matching (not `startsWith` or `includes`); only a path or query is user-controlled on a fixed origin; the scheme is forced and the resolved address is checked against private ranges (`request-filtering-agent`, `ssrf-req-filter`, or an equivalent check after DNS resolution); or requests go through an egress proxy that blocks internal ranges. On a serverless host with no internal network and no credentials attached, a blind request is at most hardening.
**Severity when confirmed:** HIGH. The attacker reads internal services or cloud credentials through the app. CRITICAL when cloud metadata or an unauthenticated admin interface is reachable without sign-in; MEDIUM for a blind request with no internal target and no credentials attached.
**CWE:** CWE-918

### secrets-handling: Server secrets sent to the browser or logs

**Look for:** Code paths that move a secret to where users can read it: environment variables with the `NEXT_PUBLIC_` prefix whose names say secret, private, service role, admin or a paid API key; the `env` block in `next.config.*`, which inlines values into client bundles; modules that read secrets imported by a `'use client'` file (directly or through a shared util) without `import 'server-only'`; Server Actions, route handlers or `getServerSideProps` returning a config object or an error that includes a secret; a Supabase service-role client created in code that ships to the browser; `console.log(process.env)` or logging request headers that carry tokens. Committed literal credentials are L1's secrets scan; this class is about code that exposes secrets at run time.
**Confirm by:** Name the variable or field (never its value) and show the path by which it reaches client code, a response or a log: the `NEXT_PUBLIC_` prefix, the `next.config` `env` entry, the import chain from a client component, or the return statement. Show the secret grants something a visitor should not have (admin database access, a paid API, signing ability).
**Disprove by:** The variable has no `NEXT_PUBLIC_` prefix and is read only in server code (route handler, Server Action, a module with `import 'server-only'`); the value is meant to be public (publishable payment keys, a Supabase anon or publishable key with row-level security on, Firebase web config, analytics or error-reporting ids); `experimental.taint` with `taintUniqueValue` guards it; or the log sink strips the field.
**Severity when confirmed:** CRITICAL. A service-role, admin or payment secret key is readable in the browser. HIGH for a paid third-party API key or a signing secret; LOW for a key that is scoped to public data or restricted to the app's own origin.
**CWE:** CWE-200, CWE-540, CWE-532

### deserialization: Untrusted data turned into code or object structure

**Look for:** Request, cookie or stored data reaching an unsafe deserializer or code sink on the server: `eval`, `new Function`, `vm.runInNewContext` or `vm.Script` on input; `node-serialize` `unserialize`, `serialize-to-js` evaluation, `js-yaml` 3.x `load` (4.x `load` is safe); and prototype pollution through deep merge or set-by-path of request JSON (`lodash.merge`, `_.set(obj, input.path, value)`, `deepmerge`, hand-written recursive merges) where a later read of a polluted property changes a decision (`if (user.isAdmin)`, options objects). Framework advisories in React Server Components or Server Action serialization are dependency findings for L1, not this class. Plain `JSON.parse` followed by schema validation is not a finding.
**Confirm by:** Show the input reaching the sink on a reachable path and show the effect: code runs with the server's privileges, or a polluted key (`__proto__`, `constructor.prototype`) survives the merge and a named property read later changes an authorization or execution decision. Prototype pollution with no reachable property read that matters is not a finding.
**Disprove by:** Input goes through `JSON.parse` into a schema validator (zod, valibot, ajv) before use; merge helpers skip `__proto__`, `constructor` and `prototype` keys or merge into `Object.create(null)`; `js-yaml` is 4.x or uses `JSON_SCHEMA`; the code sink only ever receives constants; or the process runs with `--disable-proto=throw`.
**Severity when confirmed:** CRITICAL. Code execution on the server without sign-in. HIGH when a signed-in user is needed or the effect is privilege escalation through a polluted property; MEDIUM when the polluted property only changes non-security behaviour that still matters (crash loop, feature toggle).
**CWE:** CWE-502, CWE-94, CWE-1321

### misconfig: Configuration that opens a concrete attack path

**Look for:** Settings in `next.config.*`, route handlers and deployment files that create a real path, not a missing hardening header: `experimental.serverActions.allowedOrigins` with wildcards (weakens the built-in cross-site check); `images.dangerouslyAllowSVG: true` without the matching `contentSecurityPolicy`; `rewrites` that proxy a public path to an internal service (`destination: 'http://localhost:...'` or a private host); CORS headers on cookie-authenticated route handlers that reflect any `Origin` with `Access-Control-Allow-Credentials: true`; debug, seed, reset, preview or test routes (`app/api/debug`, `app/api/seed`, draft-mode enablers) reachable in production without a secret or admin check; route handlers that echo `error.stack` and internal config.
**Confirm by:** Name the setting or route and show the attack it enables in this app: which origin can make credentialed requests and read a named authenticated response, which internal service the rewrite exposes, or what the debug route does for an anonymous caller in a production build (show no `NODE_ENV` or secret gate).
**Disprove by:** The setting only affects public, unauthenticated data; the debug route is excluded from production (`if (process.env.NODE_ENV === 'production') notFound()`) or requires a server-checked secret or admin role; CORS allows a fixed list of the app's own origins. A missing Content-Security-Policy, HSTS, `X-Frame-Options`, source maps in production or a verbose `X-Powered-By` header is hardening graded by L1, never a finding here.
**Severity when confirmed:** MEDIUM. A configuration choice gives attackers a usable foothold. HIGH when it exposes an internal service, an admin or seeding function, or authenticated data cross-origin without sign-in; LOW when the exposed surface is informational.
**CWE:** CWE-284, CWE-942, CWE-489, CWE-209

### server-action-exposure: Server Actions callable without the check their page implies

**Look for:** Functions in files that start with `'use server'` and inline `'use server'` functions. Every exported async function in such a file becomes a public POST endpoint addressed by its action id, callable directly with the `Next-Action` header whether or not the page that renders the form is protected. Find actions that read or change data without calling the session or authorization check inside the action body (or in a data-access function it calls), that rely on a layout or page `redirect`, a hidden button or `middleware.ts`/`proxy.ts`, or that trust arguments such as `userId`, `role`, `price`, `orgId` or values passed with `.bind(...)`.
**Confirm by:** Name the exported action (file:symbol) and show it performs a privileged read or write, and that neither its body nor the functions it calls before the data access verify the session and the caller's right to the object. Show that any argument used to decide authorization or price comes from the client. Layout, page and component checks do not count, because the action can be invoked directly.
**Disprove by:** The action starts with a server-side check (`const session = await auth(); if (!session) ...` plus an ownership or role check), or calls a data-access layer marked `import 'server-only'` that verifies the session itself; a wrapper such as `next-safe-action` with an authentication middleware (`authActionClient`) defines it; or the action does only what an anonymous visitor may do (newsletter sign-up, public contact form), in which case rate limiting is hardening, not a finding.
**Severity when confirmed:** HIGH. Any visitor or signed-in user runs a privileged action directly. CRITICAL when no sign-in is needed and the action changes accounts, roles, billing or other users' data.
**CWE:** CWE-862, CWE-306, CWE-285

### middleware-auth-bypass: Routes protected only by middleware or proxy, with gaps

**Look for:** Apps where `middleware.ts` (Next.js 15 and earlier) or `proxy.ts` (Next.js 16 and later) is the only place a route is protected. Check `config.matcher`: negative-lookahead patterns that exclude `/api` (`'/((?!api|_next/static|_next/image|favicon.ico).*)'`), patterns that cover `/dashboard` but not `/dashboard/:path*`, missing locale prefixes, route groups, trailing-slash or case variants. Check what the middleware decides on: the presence of a cookie (`if (req.cookies.get('session'))`) rather than a verified token; a request header such as `x-user-id` it sets for downstream code that a client can also send on paths the middleware does not run on.
**Confirm by:** Name a route meant to be protected and show a request path that reaches it without the check: a path the matcher regex does not match (show the regex and the path), or a forged or arbitrary cookie value that passes a presence check, or a client-sent header that downstream code trusts. Show the route handler, Server Action, `getServerSideProps` or page performs no check of its own.
**Disprove by:** The route, Server Action or data-access layer re-checks the session itself (then the matcher gap is hardening, not a finding); the middleware verifies the token (`jose` `jwtVerify`, the Auth.js `auth` wrapper, Clerk `clerkMiddleware` with `auth.protect()`); the matcher does cover the path (test the regex against it); headers passed downstream are always deleted or overwritten before use. Framework-level middleware bypass advisories are dependency findings for L1, not this class.
**Severity when confirmed:** HIGH. Protected pages or APIs are reachable without signing in. CRITICAL when the bypassed routes expose admin functions or other users' data in bulk; MEDIUM when they expose only pages whose data loads through separately protected calls.
**CWE:** CWE-288, CWE-863, CWE-284

### client-data-exposure: Server data over-shared to the browser

**Look for:** Server data crossing to the client with more fields than the viewer may see. Everything passed as a prop to a `'use client'` component, returned in `props` from `getServerSideProps` or `getStaticProps`, or returned from a Server Action or route handler is serialized into the HTML or RSC payload and visible in the page source even if never rendered. Find whole ORM records passed across (`<Profile user={user} />` where `user` came from `findUnique` with no `select`), `include` of related users, and JSON responses of full rows. Sensitive fields: password hashes, reset or verification tokens, MFA secrets, API keys, internal notes, other users' emails or phone numbers.
**Confirm by:** Show the object reaching the client boundary (name the component prop, `props` key or response) and that it carries a sensitive field: read the query (no `select` or `omit`) and the model or table definition (the field exists). Show the viewer is not entitled to that field.
**Disprove by:** A `select`, `omit` (including Prisma's global omit), DTO or mapper (`toPublicUser`) strips the field before the boundary; `experimental.taint` with `taintObjectReference` covers the record; or the fields are the viewer's own non-secret data, which is not a finding.
**Severity when confirmed:** HIGH. Credential material or other users' personal data is readable in the page source. MEDIUM for internal-only fields that help a further attack; not a finding for the viewer's own non-secret fields.
**CWE:** CWE-200, CWE-213, CWE-359

## Baseline

A healthy Next.js app checks the session and the caller's rights inside every route handler, Server Action and data-access function, not only in `middleware.ts` or `proxy.ts`, which is used for optimistic redirects. Data access goes through a server-only layer (`import 'server-only'`) that returns DTOs with only the fields the viewer may see. Queries use the ORM or tagged SQL templates with bound values, scoped by the session user and, in multi-tenant apps, by a membership-checked tenant taken from the session. Secrets live in environment variables without the `NEXT_PUBLIC_` prefix and are read only in server code; anything in `NEXT_PUBLIC_` or `next.config` `env` is public by design. Outbound fetches go to fixed origins or an allowlist. Sessions come from a maintained library with verified tokens and random, expiring, single-use reset tokens. Security headers (CSP, HSTS, framing) are graded by L1 as hardening.

## Sources

- https://owasp.org/Top10/2025/ (2026-10-23)
- https://github.com/OWASP/ASVS/tree/v5.0.0 (2026-10-23)
- https://nextjs.org/docs/app/guides/data-security (2026-10-23)
- https://nextjs.org/docs/app/guides/authentication (2026-10-23)
- https://nextjs.org/blog/security-nextjs-server-components-actions (2026-10-23)
- https://nextjs.org/docs/app/guides/environment-variables (2026-10-23)
