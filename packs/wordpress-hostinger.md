---
name: wordpress-hostinger
version: 1.0.0
appliesTo:
  - wordpress-hostinger
kinds:
  - host
sources:
  - https://owasp.org/Top10/2025/ | 2026-10-23
  - https://github.com/OWASP/ASVS/tree/v5.0.0 | 2026-10-23
  - https://developer.wordpress.org/advanced-administration/security/hardening/ | 2026-10-23
  - https://developer.wordpress.org/advanced-administration/security/brute-force/ | 2026-10-23
  - https://developer.wordpress.org/advanced-administration/debug/debug-wordpress/ | 2026-10-23
  - https://developer.wordpress.org/cli/commands/plugin/list/ | 2026-10-23
  - https://developer.wordpress.org/cli/commands/theme/list/ | 2026-10-23
  - https://developer.wordpress.org/cli/commands/core/version/ | 2026-10-23
  - https://developer.wordpress.org/cli/commands/config/list/ | 2026-10-23
  - https://www.hostinger.com/tutorials/wp-cli | 2026-10-23
lastReviewed: 2026-10-23
---

<!-- Host pack for a WordPress site on Hostinger web or managed WordPress hosting, reached over the plan's SSH access (hPanel,
     Advanced, SSH Access) and its live URL. The infra-prober compares the probe observations with the Baseline and writes
     candidates; verifiers try to disprove each one from the same observations. Say "unavailable" rather than "clean" when a probe
     could not run. SSH probes name the site directory with the placeholder `<sitePath>`, which the probe runner replaces with the
     system's `host.sitePath` from the inventory (default `public_html`, relative to the SSH login's home directory). On Hostinger the
     documented default is `domains/<domain>/public_html`, so the inventory should set `host.sitePath` to that; a wrong path makes
     these probes answer "No such file" or "This does not seem to be a WordPress installation": unavailable. WP-CLI probes pass `--skip-plugins --skip-themes` and
     `--skip-update-check` so no third-party code runs and nothing is written. -->

# WordPress on Hostinger

## Hunt classes

### outdated-components: Core, plugins or themes with known vulnerabilities

**Look for:** Versions from core-version (or core-version-header when WP-CLI is missing), plugin-versions and theme-versions (or plugin-headers), compared with the WordPress security releases and with public vulnerability databases for each plugin and theme slug (the WPScan and Wordfence Intelligence databases, the plugin's changelog). Weigh by what is active: an `active` plugin's code runs on every request; an `inactive` one is still reachable when its files can be requested directly. Plugins that are closed on wordpress.org or have had no release for years are a warning sign, not a finding.
**Confirm by:** Name the component (slug), the installed version, the advisory (CVE or database id and title) and the first fixed version, and say whether the vulnerable path needs a login (subscriber, contributor, administrator) or none.
**Disprove by:** The installed version is at or after the fixed version, the advisory concerns a feature the site does not use per the advisory's own preconditions, or the plugin is listed as a must-use or drop-in that the advisory does not cover. A minor release behind with no security fix in between is hardening.
**Severity when confirmed:** HIGH. A component with a published vulnerability runs on the site; follow the advisory's rating. CRITICAL for unauthenticated code execution, file upload, SQL injection or privilege escalation in an active plugin; HIGH for those that need a subscriber login on a site with open registration; MEDIUM for stored XSS or issues that need a contributor.
**CWE:** CWE-1395, CWE-1104

### debug-exposure: Debug output and logs readable from the web

**Look for:** debug-log returning 200 (`wp-content/debug.log` is served to anyone; it holds file paths, SQL errors and sometimes request data); config-constants showing `WP_DEBUG` true with `WP_DEBUG_DISPLAY` true or unset (errors printed into pages, where its default is true) on the production site, or `WP_DEBUG_LOG` true or a path inside the site directory without a server rule that blocks it.
**Confirm by:** Quote the http status and content type for the log, or the constants with their values, and say what an anonymous visitor reads.
**Disprove by:** debug-log answers 403 or 404; `WP_DEBUG` is false, or true with `WP_DEBUG_DISPLAY` false and the log written outside the site directory. Debug settings on a staging site the owner names as such are not this class.
**Severity when confirmed:** MEDIUM. Internal paths, queries and error details reach anyone. HIGH when the readable log is large and recent, since logs often capture request parameters, emails or tokens; LOW for display-only warnings with no log exposed.
**CWE:** CWE-532, CWE-209, CWE-200

### file-permissions: Site files writable or readable beyond the owner

**Look for:** file-modes showing `wp-config.php` world-readable or writable (mode ending in 4, 6 or 7 for others, or group-writable) and directories at 777; world-writable listing paths under the site directory writable by every account on the server (core files, `wp-content/plugins`, `.htaccess`), or files owned by a different user than the site's SSH user. The hardening guide's baseline is 755 for directories, 644 for files and 400 or 440 for `wp-config.php`.
**Confirm by:** Quote the mode, owner and path, and say who else can write or read it: other local accounts, the web server user when PHP runs as another user.
**Disprove by:** Modes are at or below the baseline; world-writable is empty, or lists only cache or upload subdirectories a plugin requires and the server runs PHP as the site user (on Hostinger shared hosting accounts are isolated from each other, which lowers the impact of other-user bits). A `wp-config.php` at 644 on an isolated account is hardening.
**Severity when confirmed:** MEDIUM. Another local process can change site code or read the database credentials. HIGH when `wp-config.php`, `.htaccess` or plugin code is world-writable; LOW for over-broad read bits on an isolated account.
**CWE:** CWE-732, CWE-276

### config-hardening: wp-config placement and dashboard code editing

**Look for:** file-modes showing whether `wp-config.php` sits in the site directory or one level above it (outside the web root); config-constants without `DISALLOW_FILE_EDIT` true (an administrator, or anyone who steals an administrator session, edits theme and plugin PHP from the dashboard, which turns an account takeover into code execution) and without `DISALLOW_FILE_MODS`; `FORCE_SSL_ADMIN` false on a site whose live URL answers over http; `AUTOMATIC_UPDATER_DISABLED` true or `WP_AUTO_UPDATE_CORE` false (security releases are not applied automatically). These raise the impact of other weaknesses; on their own they are mostly hardening.
**Confirm by:** Quote the constant (or its absence from config-constants) and the path from file-modes. Report as a finding only when an observation shows the weakness is reachable: core auto-updates disabled while core-version is behind a security release, or admin login served over plain http (login-surface's edge observation).
**Disprove by:** `DISALLOW_FILE_EDIT` true, automatic core updates on, admin over https. A `wp-config.php` inside the site directory is normal and safe while PHP executes it; the hardening guide notes moving it gives little benefit. Missing `DISALLOW_FILE_EDIT` alone is hardening.
**Severity when confirmed:** MEDIUM. A known fix is withheld or admin credentials cross the network in clear. LOW for constants that only add defense in depth.
**CWE:** CWE-1188, CWE-94

### login-surface: XML-RPC and login endpoints open to guessing

**Look for:** xmlrpc answering 405 with `Allow: POST`, or 200 (XML-RPC is live: `system.multicall` lets one request try many passwords, and pingbacks can be used to make the site send requests); login-page answering 200 over http, or with no sign of rate limiting or a second factor in the response headers; the live URL serving `wp-login.php` and `/wp-admin/` with no extra layer (no 401 or 403 from an IP rule or basic auth). The hardening guides advise disabling XML-RPC when unused and rate-limiting `wp-login.php`.
**Confirm by:** Quote the status and headers for each path, and say what an attacker can do: credential guessing through XML-RPC multicall, or a login form over plain http. Combine with user-enumeration when it names valid logins.
**Disprove by:** xmlrpc answers 403 or 404 (blocked), or the site uses a feature that needs it (Jetpack, the mobile app) and a security plugin rate-limits it; login-page answers 401, 403 or 404 for unknown visitors, or the edge shows rate limiting. A public `wp-login.php` over https is how WordPress works: hardening.
**Severity when confirmed:** LOW. Password guessing is easier than it needs to be. MEDIUM when XML-RPC is live and user-enumeration exposes administrator logins, or when the login form is served over plain http.
**CWE:** CWE-307, CWE-319

### user-enumeration: Author logins listed to anonymous visitors

**Look for:** rest-users answering 200 with an `X-WP-Total` header (the REST API lists every user who has published content, with their login slug, to anyone; this is WordPress's default).
**Confirm by:** Quote the status and the `X-WP-Total` value, and say that the slugs are login candidates for login-surface.
**Disprove by:** rest-users answers 401, 403 or 404 (a plugin or rule restricts the endpoint), or 200 with `X-WP-Total: 0`. On a site where the listed users are public authors by design and logins use email plus a second factor, this is hardening.
**Severity when confirmed:** LOW. Valid login names make password guessing cheaper.
**CWE:** CWE-200, CWE-204

## Baseline

A healthy WordPress site on Hostinger runs a current WordPress release with automatic core security updates, and only maintained plugins and themes at versions past every published fix; unused plugins and themes are deleted. `wp-config.php` is readable only by the site's own account (400 or 440, or 600 on an isolated account), directories are 755 and files 644, and nothing under the site directory is world-writable. `DISALLOW_FILE_EDIT` is true, `WP_DEBUG` is false on production (or logs outside the web root with display off), and `wp-content/debug.log` is not served. XML-RPC is blocked unless a feature needs it, `wp-login.php` is rate-limited or behind a second factor, and the whole site, admin included, is served over https. The REST users endpoint does not list logins to anonymous visitors, or the logins it lists are protected by a second factor.

## Probes

### core-version: WordPress core version (WP-CLI)

**via:** `ssh`
**argv:** `["wp","--path=<sitePath>","core","version","--extra"]`
**expect:** `WordPress version: <x.y.z>` with the database revision and language. Healthy: the current release or the latest security release of a supported branch. `wp: command not found` means WP-CLI is not on this plan (use core-version-header); "This does not seem to be a WordPress installation" means the site is not at `<sitePath>` (check `host.sitePath`): unavailable.
**scrub:** none

### plugin-versions: Installed plugins and versions (WP-CLI)

**via:** `ssh`
**argv:** `["wp","--path=<sitePath>","plugin","list","--skip-plugins","--skip-themes","--skip-update-check","--fields=name,status,version","--format=csv"]`
**expect:** A CSV header `name,status,version`, then one line per plugin (including `must-use` and `dropin`). Healthy: every plugin at a version past its published fixes, and no inactive plugins left installed. The update check is skipped so nothing is written; the prober compares versions with the advisories.
**scrub:** none

### theme-versions: Installed themes and versions (WP-CLI)

**via:** `ssh`
**argv:** `["wp","--path=<sitePath>","theme","list","--skip-plugins","--skip-themes","--skip-update-check","--fields=name,status,version","--format=csv"]`
**expect:** A CSV header `name,status,version`, then one line per theme. Healthy: the active theme (and its parent) at a version past its published fixes; unused themes removed except one default theme.
**scrub:** none

### core-version-header: WordPress core version from version.php

**via:** `ssh`
**argv:** `["grep","-H","^\\$wp_version","<sitePath>/wp-includes/version.php"]`
**expect:** `<sitePath>/wp-includes/version.php:$wp_version = '<x.y.z>';`. Used when WP-CLI is missing; `No such file` means the site is not at `<sitePath>` (check `host.sitePath`): unavailable.
**scrub:** none

### plugin-headers: Plugin versions from their file headers

**via:** `ssh`
**argv:** `["find","<sitePath>/wp-content/plugins","-maxdepth","2","-name","*.php","-exec","grep","-H","-m1","-i","^[[:space:]/*#@]*Version:","{}","+"]`
**expect:** `<plugin dir>/<file>.php: * Version: <x.y.z>` for each plugin's main file (other PHP files with a Version line may appear too; the plugin's main file is the one named after its folder or carrying the plugin header). Used when WP-CLI is missing; read-only.
**scrub:** none

### config-constants: Security-relevant wp-config constants (WP-CLI)

**via:** `ssh`
**argv:** `["wp","--path=<sitePath>","config","list","DISALLOW_FILE_EDIT","DISALLOW_FILE_MODS","WP_DEBUG","WP_DEBUG_DISPLAY","WP_DEBUG_LOG","FORCE_SSL_ADMIN","WP_AUTO_UPDATE_CORE","AUTOMATIC_UPDATER_DISABLED","--strict","--fields=name,value","--format=csv"]`
**expect:** A CSV header `name,value`, then only the listed constants that the config defines; a constant missing from the output is not defined and takes WordPress's default. Database credentials and salts are never selected. Healthy: `DISALLOW_FILE_EDIT,1`, `WP_DEBUG` empty or `0`, no `AUTOMATIC_UPDATER_DISABLED,1`.
**scrub:** env

### file-modes: Modes and owners of wp-config and key directories

**via:** `ssh`
**argv:** `["stat","-c","%a %U %n","<sitePath>/wp-config.php","<sitePath>/../wp-config.php","<sitePath>/.htaccess","<sitePath>","<sitePath>/wp-content","<sitePath>/wp-content/uploads"]`
**expect:** `<mode> <owner> <path>` per existing path (a `No such file` line for the others). `wp-config.php` appears in exactly one of `<sitePath>` or the directory above it (WordPress also loads it from one level up). Healthy: `wp-config.php` at 400, 440 or 600; `.htaccess` at 644 or tighter; directories at 755; all owned by the SSH user.
**scrub:** env

### world-writable: World-writable paths under the web root

**via:** `ssh`
**argv:** `["find","<sitePath>","-maxdepth","4","-perm","-o+w","-not","-type","l"]`
**expect:** No output (nothing under `<sitePath>` is writable by every account). Any path listed is writable by others.
**scrub:** none

### xmlrpc: XML-RPC endpoint

**via:** `http`
**argv:** `["GET"]`
**path:** /xmlrpc.php
**expect:** 403 or 404 when XML-RPC is blocked. WordPress itself answers a GET with 405 and `Allow: POST`, so 405 (or 200 through some proxies) means XML-RPC is live.
**scrub:** none

### rest-users: REST users endpoint

**via:** `http`
**argv:** `["GET"]`
**path:** /wp-json/wp/v2/users
**expect:** 401, 403 or 404 when user listing is restricted. WordPress's default is 200 with an `X-WP-Total` header counting the listed users; only status and headers are kept.
**scrub:** none

### login-page: Login page and admin edge

**via:** `http`
**argv:** `["GET"]`
**path:** /wp-login.php
**expect:** 200 over https with `Strict-Transport-Security` is the WordPress default; 401, 403 or 404 for unknown visitors means an extra layer (basic auth, an IP rule, a moved login). A plain-http live URL serving 200 here sends passwords in clear.
**scrub:** none

### debug-log: Debug log not served

**via:** `http`
**argv:** `["GET"]`
**path:** /wp-content/debug.log
**expect:** 403 or 404. A 200 with a `text/plain` content type means the debug log is public; only status and headers (including `Content-Length` and `Last-Modified`) are kept.
**scrub:** none

## Sources

- https://owasp.org/Top10/2025/ (2026-10-23)
- https://github.com/OWASP/ASVS/tree/v5.0.0 (2026-10-23)
- https://developer.wordpress.org/advanced-administration/security/hardening/ (2026-10-23)
- https://developer.wordpress.org/advanced-administration/security/brute-force/ (2026-10-23)
- https://developer.wordpress.org/advanced-administration/debug/debug-wordpress/ (2026-10-23)
- https://developer.wordpress.org/cli/commands/plugin/list/ (2026-10-23)
- https://developer.wordpress.org/cli/commands/theme/list/ (2026-10-23)
- https://developer.wordpress.org/cli/commands/core/version/ (2026-10-23)
- https://developer.wordpress.org/cli/commands/config/list/ (2026-10-23)
- https://www.hostinger.com/tutorials/wp-cli (2026-10-23)
