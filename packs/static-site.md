---
name: static-site
version: 1.0.0
appliesTo:
  - static-site
kinds:
  - code
sources:
  - https://owasp.org/Top10/2025/ | 2026-11-12
  - https://github.com/OWASP/ASVS/tree/v5.0.0 | 2026-11-12
  - https://cheatsheetseries.owasp.org/cheatsheets/DOM_based_XSS_Prevention_Cheat_Sheet.html | 2026-11-12
  - https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html | 2026-11-12
  - https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Subresource_Integrity | 2026-11-12
  - https://vite.dev/guide/env-and-mode | 2026-11-12
  - https://docs.astro.build/en/guides/environment-variables/ | 2026-11-12
  - https://docs.netlify.com/manage/routing/headers/ | 2026-11-12
  - https://developers.cloudflare.com/pages/configuration/redirects/ | 2026-11-12
  - https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/ | 2026-11-12
lastReviewed: 2026-11-12
---

<!-- Code pack for sites built ahead of time and served as files: Astro without a server adapter, Vite, Eleventy, Hugo, Jekyll,
     Gatsby, VitePress, Docusaurus, SvelteKit with adapter-static, and hand-written HTML. There is no server of the site's own, so
     the classes are about what the build puts in the published files, what client scripts do with content and URLs, and what the
     host's config files allow. A site with server routes (an Astro adapter, Netlify or Vercel functions, Pages Functions) also gets
     its runtime's pack (node-api, cloudflare-workers); judge those routes there, not here. Of the five low-effort class ids only
     authz-scoping applies to a site with no server; the others (tenant isolation, bulk export, sessions, search injection) are
     server problems and are left out on purpose. Each class is handed verbatim to the hunters and, for Confirm by and Disprove by,
     to the verifiers. -->

# Static site

## Hunt classes

### authz-scoping: Gated content shipped to every visitor

**Look for:** Pages or data that are meant for some visitors only (members, paying customers, staff, a password-protected page, unpublished drafts) but are built into the public output and hidden only by client code. Shapes: a `<script>` or island that checks `localStorage`, a cookie, a query string (`?key=`, `?preview=1`) or a decoded token and then reveals content that is already in the HTML or in a bundled JSON file; a "password" compared in client JavaScript; `getStaticPaths`, `_data`, content collections or `public/*.json` that include member-only or draft entries; pages excluded from the navigation or `robots.txt` but still generated; a client-side router guard (`if (!user) navigate('/login')`) in front of pages whose data ships in the bundle.
**Confirm by:** Name the gated content and the file of the build output (or the source that generates it) that holds it, and show the check that hides it runs only in the browser: the content, or the JSON it loads, is in the published files or fetched from a public URL with no credential the server checks. Show that a visitor who skips the script (view source, fetch the JSON, open the page path directly) reads it.
**Disprove by:** The protected content is not in the build: it is fetched at run time from an API or storage that checks the caller (a Supabase query under row-level security as the signed-in user, a signed URL, a serverless function that verifies a session); the host enforces access before serving the files (Netlify or Cloudflare Access, basic auth configured on the host, a password-protected deploy); drafts are filtered out at build time (`draft: true` excluded, `import.meta.env.PROD` checks in `getStaticPaths`); or the "gated" content is public by design and the gate is only a nag screen.
**Severity when confirmed:** HIGH. Every visitor can read content that was meant for members or staff. CRITICAL when it holds personal data of other people or credentials; MEDIUM when it is unpublished marketing content or a soft paywall over material that is not sensitive.
**CWE:** CWE-602, CWE-284, CWE-200

### secrets-handling: Build-time secrets inlined into the bundle or public files

**Look for:** Secrets that the build copies into files every visitor downloads. Environment variables with a client prefix whose names say secret, private, token, service role, admin or a paid API key: `PUBLIC_` (Astro), `VITE_` (Vite, SvelteKit, VitePress), `GATSBY_`, `NEXT_PUBLIC_` in a static export, `REACT_APP_`, `HUGO_PARAMS_`. Also values the build inlines whatever their name: Vite `define`, `envPrefix: ''` or a prefix list that includes `''` or a broad prefix, webpack `DefinePlugin` or `EnvironmentPlugin` with `process.env`, Eleventy `_data/*.js` returning `process.env`, Hugo `getenv` in a template, Jekyll `site.env` printed into a page, `astro:env` variables declared with `context: "client"`, and a config object serialized into a `<script>` tag. Committed literal credentials are L1's secrets scan; this class is about the build path that exposes a secret held in the environment.
**Confirm by:** Name the variable or setting (never its value) and show the path into the output: the prefix that marks it public, the `define` or plugin entry, the data file and the template that prints it, or the client import that reads it. Show what the key grants a visitor who copies it from the bundle: admin access to a database or CMS, a paid API billed to the owner, the ability to send mail, write to a form backend or sign tokens.
**Disprove by:** The variable has no client prefix and is read only by build code that does not print it (a CMS token used to fetch content at build time stays in the build); the value is public by design and restricted (a Stripe publishable key, a Supabase anon or publishable key with row-level security on every table it reaches, Firebase web config with security rules, a Maps key restricted to the site's referrer, an analytics or error-reporting id, an Algolia search-only key); or the built files do not contain it (check the output folder or the bundle source when it is committed).
**Severity when confirmed:** CRITICAL. A service-role, admin, CMS write or payment secret key is readable by every visitor. HIGH for a paid third-party API key or a mail or form-backend key that sends as the owner; LOW for a key limited to public data or to the site's own origin.
**CWE:** CWE-200, CWE-540, CWE-798

### dom-xss: Content or URL values written into the page as HTML by client scripts

**Look for:** Client-side sinks that turn a string into markup or script: `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `Range.createContextualFragment`, jQuery `.html()`, `.append(string)` and `$(string)`, Astro `set:html`, Svelte `{@html}`, Vue `v-html`, React `dangerouslySetInnerHTML` in an island, Alpine `x-html`, `eval`, `new Function`, `setTimeout(string)`, and `href`, `src` or `srcdoc` set from a variable. Sources a visitor or attacker controls: `location.search`, `location.hash`, `URLSearchParams`, `document.referrer`, `window.name`, `postMessage` data without an origin check, and content other people write that the site renders on the client or at build time (comments, a headless CMS many editors use, guest posts, a search index built from user submissions, markdown converted with raw HTML allowed).
**Confirm by:** Name the sink (file and function, or the template line) and trace the value to a source another person controls: a crafted link to the site, a message from another origin, or stored content an untrusted author can change. Show nothing on the path escapes or sanitizes it for that context (no `textContent`, no DOMPurify, no scheme check before a URL attribute) and say what the injected script reaches on that origin (tokens in `localStorage`, a signed-in third-party widget, a form that posts as the visitor).
**Disprove by:** The value is written with `textContent`, `innerText`, `setAttribute` on a non-URL attribute, or a framework's escaped interpolation (`{value}` in Astro, Svelte, Vue or JSX); the exact string goes through DOMPurify or `sanitize-html` with a strict configuration before the sink; URL attributes pass a scheme allowlist (`new URL(value, location.href).protocol` is `https:` or `http:`); `postMessage` handlers check `event.origin` against a fixed value; the markdown renderer escapes raw HTML or runs a sanitizer; or only the site owner writes the content. A missing Content-Security-Policy is L1 hardening; a strict CSP without `unsafe-inline` lowers severity but does not disprove the sink.
**Severity when confirmed:** MEDIUM. A crafted link runs script on the site's origin for whoever opens it. HIGH when stored content runs script for every visitor without a click, or when the origin holds tokens or a signed-in widget that acts for the visitor; LOW when the origin holds nothing of value and the script can only change what the victim sees.
**CWE:** CWE-79, CWE-83, CWE-95

### third-party-scripts: Third-party code loaded without integrity or from a URL others control

**Look for:** `<script src>`, `<link rel="stylesheet">` and `import()` of code from another origin: CDN links (`cdn.jsdelivr.net`, `unpkg.com`, `cdnjs.cloudflare.com`, `code.jquery.com`) with no `integrity` attribute, or with a moving version (`@latest`, a bare package name, `/npm/pkg` without a version) where SRI cannot hold; scripts whose URL is built from a query string, a CMS field, a config value editors can change or `location`; tag-manager or widget snippets that load further scripts chosen in a remote dashboard; script hosts on domains that have lapsed or been sold (old analytics or CDN hosts such as polyfill.io); and `<script>` inserted at run time from a `fetch` response.
**Confirm by:** Name the include (file and line) and show either that it loads executable code from a third-party origin with no `integrity` hash and no pinned version, or that its URL comes from input someone other than the owner controls (name the input). Say what the script can reach on the page: forms, tokens in storage, the DOM of a checkout or sign-in page.
**Disprove by:** The resource is self-hosted from the build output, or loaded with `integrity="sha384-..."` and `crossorigin` on a fixed, versioned URL; the URL is a constant in the source; the third party is a first-party service the owner controls; or the script runs in a sandboxed `<iframe>` (with `sandbox` and no `allow-same-origin`) on another origin, which isolates it from the page. Tag managers are an accepted business risk when only the owner can publish to them; report them only when others can.
**Severity when confirmed:** MEDIUM. Whoever controls the third-party host or the URL input runs script on every visit. HIGH when the page takes payments, credentials or personal data, or when the URL is set from input any visitor controls; LOW for a pinned, versioned URL on a major CDN that lacks only the integrity hash, on a page with nothing to steal.
**CWE:** CWE-829, CWE-353, CWE-494

### open-redirect: Redirects to an address the visitor or a link chooses

**Look for:** Client code that navigates to a URL from input: `location.href = params.get('next')`, `location.assign`, `location.replace`, `window.open(input)`, a `<meta http-equiv="refresh">` built from a query string, a link "redirector" page (`/out?url=`, `/go/`), and post-login `returnTo` or `redirect` values. Redirect rules in host files: Netlify `_redirects` and `netlify.toml` `[[redirects]]`, Cloudflare Pages `_redirects`, `vercel.json` `redirects`, Astro `redirects`, `firebase.json` `redirects`, Apache `RewriteRule` and `Redirect` in `.htaccess`, nginx `return 30x` in a shipped config, where a splat or placeholder lands in the host part of the destination (`/out/*  https://:splat  302`, `/r/:target  https://:target`).
**Confirm by:** Show the input or the rule and a crafted address on the site's own domain that sends the visitor to an attacker's host: the query value reaches the navigation without a host check, or the splat or placeholder fills the scheme or host of the destination. Show the redirect matters: it is on a sign-in, payment or email-link path, it carries a token or code onward, or the site's domain is trusted for links (an email campaign, an OAuth return).
**Disprove by:** The destination is parsed with `new URL(value, location.origin)` and its origin compared exactly with the site's own or a fixed allowlist; only relative paths are accepted (`value.startsWith('/') && !value.startsWith('//')` with a check for backslashes); the redirect rule's destination host is fixed and the splat lands only in the path; or the redirect page shows the destination and asks the visitor to continue. A `javascript:` destination is dom-xss, not this class.
**Severity when confirmed:** MEDIUM. Links on the site's domain send visitors to an attacker's page. HIGH when the redirect forwards a token, an OAuth code or a password-reset link to the attacker; LOW for a redirector that needs an extra click on an interstitial.
**CWE:** CWE-601

### client-write-endpoints: Forms and client calls that write to a backend with the owner's key

**Look for:** Browser code that writes to a third-party backend using a credential that lets any visitor do more than submit one form: direct calls to Airtable, Notion, Google Sheets, a headless CMS write API, SendGrid, Mailgun, Resend, Mailchimp, Twilio or an LLM API with the owner's token in the request; Slack, Discord or Teams incoming-webhook URLs in client code or a form `action`; Firebase or Supabase writes from the client to tables whose rules allow any write (`allow write: if true`, a policy `using (true)` for insert or update); a form backend whose key also reads submissions; and `mailto:` or form handlers that post visitor input to a shared inbox with headers the visitor chooses. The key reaching the bundle is secrets-handling; this class is about a client design that hands out write access even when the key is meant to be public.
**Confirm by:** Name the call or form (file and line) and the endpoint, and show what a visitor can do with what the page gives them, outside the form's intent: read or change other submissions, post arbitrary messages into the owner's chat, send mail or SMS as the owner, spend the owner's API credit, or write rows the site then shows to others. Name the rule or key scope that allows it.
**Disprove by:** The form posts to a service built for public forms with a submit-only key (Formspree, Netlify Forms, Basin, Web3Forms access keys) and spam protection; the client key is public by design and the backend rules restrict it (Supabase row-level security that allows insert only, with a check on the inserted columns; Firebase rules that validate the document and deny reads); the write goes through the owner's serverless function that holds the secret and validates input; or the webhook only receives data that is public anyway and its abuse costs nothing. Missing CAPTCHA or rate limits alone are hardening.
**Severity when confirmed:** HIGH. Any visitor reads, changes or sends data as the owner through the site's backend. CRITICAL when it exposes other people's personal data or allows writing content every visitor sees; MEDIUM when the abuse is limited to spam into the owner's own channel.
**CWE:** CWE-284, CWE-306, CWE-522

### published-files: Sensitive files published with the site

**Look for:** Files that end up in the deployed output and should not be public. Under `public/`, `static/`, `assets/`, `_site/`, `dist/` or the folder the host publishes: `.env*`, `.git/` or `.svn/` folders, backups (`*.bak`, `*.old`, `*.orig`, `*.zip`, `*.tar.gz`, `*.sql`), editor and OS leftovers, `config.json`, `firebase-debug.log`, `npm-debug.log`, `.htpasswd`, private notes or exports (`*.csv` of customers), and source maps (`*.map`) produced for production when the original source holds secrets, internal endpoints or comments not meant to ship. Build settings that cause it: Vite `build.sourcemap: true` or `'hidden'` maps copied to the output, Astro `vite.build.sourcemap`, Eleventy `addPassthroughCopy` of a broad glob or the project root, Hugo `staticDir` pointing at the repo root, Jekyll without `exclude` for private folders, and a host whose publish directory is the repository root.
**Confirm by:** Name the file, or the setting and the file it publishes (its path, never its contents), and show it is in the deployed output: it sits in the folder the host publishes (the host's build settings, `netlify.toml` `publish`, the `vercel.json` output, the Pages build output) and no exclude rule removes it. Show what it reveals: a credential, personal data, the repository's history, or source and endpoints that enable another finding.
**Disprove by:** The file is excluded from the build (`.gitignore` does not count; the generator's own exclude list, `.vercelignore`, or a build step that deletes it does); the host blocks it (dotfiles are not served by Netlify, Cloudflare Pages or GitHub Pages; check the host); the source maps contain only the site's own public code with no secret, private endpoint or sensitive comment; or the file is public by design (`robots.txt`, `security.txt`, a sitemap, a public dataset).
**Severity when confirmed:** HIGH. A file anyone can download holds credentials, personal data or the repository. CRITICAL when it holds a working secret key or a database export; LOW for source maps of public code that reveal only internal names.
**CWE:** CWE-538, CWE-540, CWE-530

### build-pipeline-input: Build scripts and content pipelines that run or fetch untrusted input

**Look for:** The build turning input from people other than the owner into code or requests: MDX, `.astro` or Svelte content files contributed by outside authors (MDX is code and runs at build); markdown plugins configured to execute (remark or rehype plugins that `eval`, Eleventy shortcodes that run shell commands, Hugo or Jekyll plugins with `exec`); build scripts (`package.json` `prebuild`, `postinstall`, Makefiles, `scripts/*.mjs`) that fetch a URL from a CMS field, a pull-request file or an environment the contributor controls and then run, import or `eval` the result; content fetched at build from a URL list editors can change, with the build's secrets in the request; and CI that builds pull requests from forks with secrets available (`pull_request_target` checking out the fork's head, then running `npm install` or the build), or deploy previews that hand those secrets to fork code.
**Confirm by:** Name the input and its author (an outside contributor, a CMS role, a fork) and trace it to execution or to a request that carries a secret: the MDX that runs, the plugin that evaluates, the script that imports the fetched file, or the workflow that runs fork code with secrets in its environment (name the workflow, its trigger and the step). Show what it reaches: the build's secrets, the deploy token, or the published site for every visitor.
**Disprove by:** Only the owner and trusted maintainers can change the content and scripts (check the repository's contributors and the CMS roles); outside content is plain markdown rendered without raw HTML or code execution; fetched content is parsed as data and validated, never imported or evaluated; CI runs fork pull requests with `pull_request` (no secrets) or checks out only the base branch under `pull_request_target`; and deploy previews of forks get no production secrets.
**Severity when confirmed:** HIGH. Someone outside the owner's team runs code in the build with its secrets, or publishes script to the live site. CRITICAL when the build holds a deploy or cloud token that controls more than this site; MEDIUM when the build has no secret and its output is reviewed before it goes live.
**CWE:** CWE-94, CWE-829, CWE-913

### misconfig: Host config files that weaken the site

**Look for:** Host configuration shipped with the site that actively opens something, not a missing hardening header: `.htaccess` with `Options +Indexes` (directory listing), `AddHandler` or `SetHandler` that lets uploaded or static files run as PHP or CGI, `Header unset` of a security header the host sets, or rewrite rules that proxy to an internal host; Netlify `_headers` and `netlify.toml`, Cloudflare Pages `_headers`, `vercel.json` `headers`, `firebase.json` `headers` or `staticwebapp.config.json` that set `Access-Control-Allow-Origin: *` on files that are not public, a Content-Security-Policy with `script-src *` or `unsafe-inline` that replaces a stricter one, or `Basic-Auth` lines with credentials in the file; proxy rules (`200` or `200!` status in `_redirects`, `rewrites` to an absolute URL) that put an internal or private service behind the public domain; and `Cache-Control: public` on pages that show visitor-specific data from a client call.
**Confirm by:** Name the file and the rule, and show the attack it enables on this site: which listing or file it exposes, which file it makes executable, which private service it puts on the public domain, which origin can read which non-public response, or which credential sits in the file. A weakened policy counts only if this site then has a concrete gap (a dom-xss or third-party-scripts candidate the stricter policy would have blocked).
**Disprove by:** The host ignores the file (an `.htaccess` on Netlify, Cloudflare Pages or GitHub Pages does nothing; check which host serves the site); the rule applies only to public, static files; the proxied target is a public service meant to be reached; or the credential lines hold placeholders. A missing Content-Security-Policy, HSTS or `X-Frame-Options` is hardening graded by L1's header check, never a finding here.
**Severity when confirmed:** MEDIUM. The host config gives attackers a usable path into the site. HIGH when it exposes a private service, makes files executable on the server, or publishes a working credential; LOW when the exposed surface is a listing of public files.
**CWE:** CWE-548, CWE-942, CWE-284, CWE-260

## Baseline

A healthy static site ships only what visitors may read: the build output holds the pages, assets and public data, and nothing from the repository root, no `.env`, backups or private exports, and production source maps only when they contain nothing secret. Content that is not for everyone is never in the build; it comes at run time from an API or storage that checks the caller, or the host protects the deploy. Only variables meant to be public carry a client prefix (`PUBLIC_`, `VITE_`, `GATSBY_`), and those hold keys that are public by design and restricted by the backend's own rules. Client scripts write text with `textContent` or a framework's escaped interpolation, sanitize any HTML they must insert, check URL schemes before setting `href` or `src`, check `event.origin` on messages, and only navigate to same-origin or allowlisted addresses. Third-party code is self-hosted or pinned with an `integrity` hash. Forms post to a submit-only form service or to the owner's own function that holds any secret. Builds and CI run outside contributors' content as data and never give fork code the deploy secrets. Host config files set headers and redirects with fixed destinations; security headers are graded by L1 as hardening.

## Sources

- https://owasp.org/Top10/2025/ (2026-11-12)
- https://github.com/OWASP/ASVS/tree/v5.0.0 (2026-11-12)
- https://cheatsheetseries.owasp.org/cheatsheets/DOM_based_XSS_Prevention_Cheat_Sheet.html (2026-11-12)
- https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html (2026-11-12)
- https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Subresource_Integrity (2026-11-12)
- https://vite.dev/guide/env-and-mode (2026-11-12)
- https://docs.astro.build/en/guides/environment-variables/ (2026-11-12)
- https://docs.netlify.com/manage/routing/headers/ (2026-11-12)
- https://developers.cloudflare.com/pages/configuration/redirects/ (2026-11-12)
- https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/ (2026-11-12)
