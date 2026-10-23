---
name: mobile-expo
version: 1.0.0
appliesTo:
  - mobile-expo
kinds:
  - code
sources:
  - https://owasp.org/Top10/2025/ | 2026-10-23
  - https://github.com/OWASP/ASVS/tree/v5.0.0 | 2026-10-23
  - https://mas.owasp.org/MASVS/ | 2026-10-23
  - https://docs.expo.dev/versions/latest/sdk/securestore/ | 2026-10-23
  - https://docs.expo.dev/guides/environment-variables/ | 2026-10-23
  - https://docs.expo.dev/linking/overview/ | 2026-10-23
  - https://docs.expo.dev/versions/latest/sdk/auth-session/ | 2026-10-23
  - https://docs.expo.dev/eas-update/code-signing/ | 2026-10-23
  - https://reactnative.dev/docs/security | 2026-10-23
lastReviewed: 2026-10-23
---

<!-- Code pack for Expo and React Native apps. The app is a client: every request it sends can be replayed and changed by its
     user, and everything in its bundle can be read. So most server-side classes here are scoped to what the repo itself shows:
     backend rules committed alongside the app (Supabase migrations, Firebase rules, API routes), secrets shipped in the bundle,
     and data the app handles for the user against other parties. When the backend lives in another system, its pack hunts it. -->

# Expo app

## Hunt classes

### authz-scoping: Access control that exists only in the app

**Look for:** Authorization the client is trusted to enforce. The app talks straight to a backend-as-a-service with a client key (`createClient(url, anonKey)` from `@supabase/supabase-js`, Firebase `getFirestore()`, `getDatabase()`, Appwrite, PocketBase) and reads or writes records by id (`supabase.from('orders').select().eq('id', id)`, `getDoc(doc(db, 'orders', id))`), while the only ownership or role check is in the app: screens hidden by `user.role === 'admin'`, an `isPremium` flag read on the device, prices or quantities computed on the device and sent as-is. Look in the repo for the rules that would back it: `supabase/migrations/*.sql` (`enable row level security`, `create policy`), `firestore.rules`, `database.rules.json`, `storage.rules`, Expo Router API routes (`app/**/+api.ts`). If the backend is not in this repo, report only what the app itself proves (a client-side gate with no server call that could enforce it); do not guess about an unseen server.
**Confirm by:** Name the client call (file:symbol) and the table, collection or endpoint, then show from the repo's own rules that the server does not enforce the check: the table has no `enable row level security`, a policy is `using (true)` or `with check (true)` for `authenticated` or `anon`, Firebase rules say `allow read, write: if request.auth != null;` or `if true`, or an Expo API route has no session check. Show what another user's data or privileged action a user gets by sending the same request with a changed id, flag or price.
**Disprove by:** Row-level security is enabled with policies that compare the row owner to `auth.uid()` (or a membership table); Firebase rules compare `resource.data.ownerId == request.auth.uid`; the privileged action goes through a server function (Supabase Edge Function, Cloud Function, API route) that checks the caller; prices and entitlements are computed or verified on the server (RevenueCat or store receipt validation on the backend). A client-side check backed by a server rule is defence in depth, not a finding.
**Severity when confirmed:** HIGH. Any user of the app reads or changes other users' records by editing a request. CRITICAL when the anon key alone (no sign-in) reaches the data or the action, or the data is credentials, payment or health records; MEDIUM when the bypass only unlocks a client-side feature with no server data behind it.
**CWE:** CWE-602, CWE-639, CWE-862

### tenant-isolation: Cross-account data on the server or left on the device

**Look for:** Two shapes. On the backend rules committed in the repo: policies or Firebase rules that check sign-in but not membership in the organization, team or household (`create policy ... using (org_id is not null)`, rules that never read the member list), and client queries that pass an `orgId` from app state. On the device: per-user data that outlives the session on a shared device: React Query or SWR caches persisted to AsyncStorage or MMKV (`persistQueryClient`, `createAsyncStoragePersister`), Redux Persist, Zustand `persist`, SQLite tables and downloaded files keyed without the user id and not cleared on sign-out or account switch. If the app has no multi-account or tenant concept, report nothing for the backend shape.
**Confirm by:** For the backend shape, show the rule or policy (file and statement) that lets a member of one tenant match rows of another, and the client call that sends the tenant id. For the device shape, show the persisted store holding another account's data, the sign-out path (name it) that does not clear it, and the screen that then renders it to the next account.
**Disprove by:** Policies join a membership table on `auth.uid()`; the tenant comes from a JWT claim set by the server; the sign-out handler clears persisted caches (`queryClient.clear()` plus removing the persisted key, `persistor.purge()`, `AsyncStorage.clear()`, deleting the SQLite file) or caches are keyed by user id; the app supports only one account per install and wipes data on sign-out.
**Severity when confirmed:** HIGH for the backend shape: members of one organization read or change another's data. MEDIUM for the device shape: the next person on the same device sees the previous account's data (physical access to an unlocked device needed).
**CWE:** CWE-566, CWE-639, CWE-524

### bulk-export: Client queries or features that pull more than the user may see

**Look for:** Client calls that list whole collections the backend lets through: `supabase.from('profiles').select('*')` against a table whose policy is `using (true)`, Firestore `getDocs(collection(db, 'users'))` allowed by rules, GraphQL list queries, and Expo API routes that return every row. Also app features that write user data to places other apps can read: `expo-sharing` and `expo-media-library` exports of reports with other people's data, files written outside the app sandbox, and `Clipboard.setStringAsync` of sensitive records. Downloading the user's own data to their own device is not this class.
**Confirm by:** Show the call or route and the rule or policy in the repo that allows reading every row (or every sensitive column) to any signed-in or anonymous caller, and name the fields exposed; or show the export path that places other people's personal data in shared storage.
**Disprove by:** Policies or rules scope reads to the owner or members and the selected columns exclude sensitive fields (a view or a column-level grant); the list comes from a server function that filters by caller; the shared file contains only the user's own data; or the data is public by design (a public catalogue).
**Severity when confirmed:** HIGH. Any user, or anyone with the bundled anon key, downloads every user's records. CRITICAL when no sign-in is needed and the rows include contact, location, payment or health data; MEDIUM when the exposed columns are low-sensitivity.
**CWE:** CWE-200, CWE-359, CWE-862

### session-handling: Weak sign-in flows and token handling in the app

**Look for:** OAuth and sign-in flows with `expo-auth-session` or `expo-web-browser`: `usePKCE: false`, `ResponseType.Token` (implicit flow) for providers that support code with PKCE, the `state` parameter not checked on return, tokens or codes delivered to a custom scheme redirect (`myapp://auth`) that another app can register on Android; a `client_secret` used in the app for a token exchange; tokens read from deep-link query parameters and stored without validation; refresh tokens that are never rotated or revoked on sign-out (`supabase.auth.signOut()` missing, Firebase `signOut` not called, local token deleted but server session left); identity taken from the device (`userId` in AsyncStorage) and sent to an API that trusts it. Token storage location is the insecure-local-storage class.
**Confirm by:** Show the flow (file:symbol) and the step that lets an attacker obtain or replay a token: a code or token delivered without PKCE to a scheme any app can claim, a missing `state` check that allows login CSRF, an exchange using a shipped client secret, or an API call where identity is a client-supplied id the server trusts (show the server side if it is in the repo).
**Disprove by:** `expo-auth-session` with its default `usePKCE: true` and code flow; the provider SDK handles the flow (Supabase `signInWithOAuth` with PKCE flow type, Firebase, Clerk, Auth0 SDK); redirects use verified App Links or Universal Links; the token exchange happens on a server; sign-out calls the provider's sign-out so the refresh token is revoked; the server derives identity from the verified token.
**Severity when confirmed:** HIGH. A malicious app or link takes over a user's session. CRITICAL when the shipped client secret lets anyone mint tokens for any user; MEDIUM for login CSRF or sessions that survive sign-out on the server.
**CWE:** CWE-287, CWE-352, CWE-384, CWE-613

### search-injection: Query syntax built from untrusted input in the app

**Look for:** In a client app the user controls every request, so a filter the user builds for themselves is not injection. Report only when input from someone else (a deep link, a push notification payload, a shared record, a QR code) is placed into query syntax the app sends with the user's privileges: Supabase/PostgREST ``.or(`...${param}...`)`` or `.filter(col, op, param)` with an operator from the link, Firestore `where` with a field path from the link, Algolia `filters` strings assembled from a link, or a server-side search route in the repo (Expo API routes) that builds query syntax from request input. Also `new RegExp(input)` run on large local data.
**Confirm by:** Show the untrusted source (the deep link route or notification handler), the query it reaches as syntax, and what changes for the victim: their private records sent somewhere, a filter that hides other users' data widened, or an action performed on the wrong rows. For a server route in the repo, show the input reaching the query as syntax and rows outside the caller's scope returned.
**Disprove by:** The parameter is used as a value (`.eq('id', param)`, `.ilike('name', value)`), validated against a pattern or an allowlist of fields, or the query result never leaves the user's own scope (row-level security confines it), so the altered filter exposes nothing new.
**Severity when confirmed:** MEDIUM. A crafted link changes which of the user's own records are read or changed. HIGH when the server route in the repo returns other users' data through the injected filter.
**CWE:** CWE-943, CWE-74

### sql-injection: SQL built from input, in local SQLite or in repo backend code

**Look for:** `expo-sqlite` calls with interpolated text: ``db.execAsync(`... ${x}`)``, ``db.getAllAsync(`SELECT ... WHERE name = '${q}'`)``, `runAsync` with a built string, `op-sqlite`, WatermelonDB `Q.unsafeSqlQuery`, Drizzle `sql.raw` over expo-sqlite, where the input comes from a deep link, a notification, server data written by other users, or a search box. Also SQL in backend code committed to this repo (Supabase migrations defining functions with `EXECUTE` on concatenated arguments called through `supabase.rpc`, Expo API routes using `pg` with interpolation). A user injecting into their own local database harms only themselves: not a finding.
**Confirm by:** Show the input source and that it reaches SQL text, not a bound parameter. For local SQLite, show the source is controlled by someone other than the device's user and name the effect (other local data read into a sync payload, records deleted, app logic bypassed). For backend SQL, trace from the RPC or route argument to the `EXECUTE` or query text.
**Disprove by:** Values are bound (`runAsync('... WHERE id = ?', [id])`, `getAllAsync` with params, `$name` named parameters, Drizzle tagged `sql`, the ORM query builder); identifiers come from a fixed list; backend functions use `format('%I', ...)` and `%L` or `USING` parameters; or the only source is the device's own user.
**Severity when confirmed:** MEDIUM for local SQLite reached from another party's data (the impact stays on one device). CRITICAL when backend SQL in the repo is reachable through an RPC or route callable with the anon key; HIGH when sign-in is needed.
**CWE:** CWE-89

### ssrf: App requests steered to attacker hosts with credentials attached

**Look for:** The device is not a server, so classic SSRF applies only to backend code in the repo (Expo API routes `app/**/+api.ts`, Edge Functions under `supabase/functions`) that fetches a URL from request input. In the app itself, look for the client form: requests to a URL taken from a deep link, a push payload or server data that carry the user's credentials (``fetch(params.url, { headers: { Authorization: `Bearer ${token}` } })``), axios instances or fetch wrappers whose interceptor adds the token to every request regardless of host, `baseURL` overridden by an absolute URL from input, and WebViews loading a link-supplied URL with the session cookie or token injected.
**Confirm by:** For backend code, show input setting the host of an outbound request with no allowlist and what it reaches. For the app, show the untrusted URL source, the request it controls, and that the user's token or cookie is attached to a host the attacker chooses.
**Disprove by:** The token interceptor checks the request host against the API origin before attaching credentials; URLs from links are matched against an allowlist of the app's own domains; the WebView `originWhitelist` and `onShouldStartLoadWithRequest` restrict it to the app's domains and no token is injected; backend fetches use a fixed origin or an allowlist with address checks.
**Severity when confirmed:** HIGH. A crafted link or payload sends the user's session token to an attacker. MEDIUM when the leaked credential is short-lived and scoped, or the backend request reaches no internal target.
**CWE:** CWE-918, CWE-201, CWE-522

### secrets-handling: Secrets shipped inside the app bundle

**Look for:** Everything in the JavaScript bundle and app manifest is readable by anyone who downloads the app. Find secrets referenced from runtime code: `EXPO_PUBLIC_*` variables (inlined into the bundle at build time) whose names say secret, service role, admin, private or a paid API (OpenAI, Anthropic, Stripe secret, Twilio, SendGrid, Google service account); `expo.extra` in `app.json` or `app.config.*` read through `expo-constants`; constants files with keys; a Supabase client created with the service-role key; Firebase Admin credentials imported in app code; and logs of tokens (`console.log(session)`) that reach device logs in release builds. Committed literal credentials are L1's secrets scan; this class is about secrets the shipped app exposes.
**Confirm by:** Name the variable or key (never its value), show it is referenced from code that ships in the app (not only from `app.config.*` build-time plugins or EAS build scripts), and show what it grants: admin database access, a paid API billed to the owner, sending messages as the owner.
**Disprove by:** The value is designed to be public: a Supabase anon or publishable key with row-level security on, Firebase client config, a Sentry DSN, a RevenueCat public SDK key, a Maps key restricted to the app's bundle id or package (say so as an assumption when the restriction is not visible in code); or calls that need the secret go through a backend or an Edge Function and the app holds no secret. A secret used only at build time (EAS secrets read by config plugins) that never reaches the bundle is not a finding.
**Severity when confirmed:** CRITICAL. A service-role, admin or payment secret key is in the bundle. HIGH for a paid third-party API key anyone can bill; LOW for a key limited to public data or restricted by bundle id.
**CWE:** CWE-798, CWE-540, CWE-532

### deserialization: Untrusted data turned into code or object structure in the app

**Look for:** Data from deep links, push payloads, WebView `onMessage` events or server content written by other users reaching `eval`, `new Function`, or a dynamic code path (a JSON "action" field mapped to a native module call without an allowlist); prototype pollution through deep merge of such data into configuration or state (`lodash.merge(config, payload)`); and WebView bridges that `JSON.parse` page messages and run the named method (`window.ReactNativeWebView.postMessage` handled by a switch with a default that calls `NativeModules[name]`). Over-the-air update loading is in misconfig. Plain `JSON.parse` into typed, validated use is not a finding.
**Confirm by:** Show the untrusted source, the sink, and the effect: code runs in the app's JavaScript context, a native capability (file system, contacts, payments) is invoked with attacker arguments, or a polluted property changes a security decision.
**Disprove by:** Messages are validated against a schema and dispatched through an allowlist of handlers; the WebView only loads the app's own pages (`originWhitelist`) and checks `event.nativeEvent.url` before acting; merge helpers skip `__proto__`, `constructor` and `prototype`; code sinks receive only constants.
**Severity when confirmed:** HIGH. A link, notification or web page runs code or native actions in the app as the user. CRITICAL when no user interaction beyond opening a link leads to account takeover or payment; MEDIUM when the effect is limited to the app's own UI state.
**CWE:** CWE-502, CWE-94, CWE-1321, CWE-749

### misconfig: App and build configuration that opens a concrete path

**Look for:** Settings in `app.json`, `app.config.*`, `eas.json` and config plugins: `expo-updates` with a custom `updates.url` over `http://` or a self-hosted update server without `codeSigningCertificate` (anyone on the path, or who controls the server, ships JavaScript to every install); `ios.infoPlist.NSAppTransportSecurity.NSAllowsArbitraryLoads: true` or Android `usesCleartextTraffic: true` together with `http://` API base URLs used in production; development builds or `expo-dev-client` shipped in a production profile; debug screens or environment switchers reachable in release builds (not gated by `__DEV__`); Android components exported through config plugins (`android:exported="true"` activities, receivers or content providers) that act without permission checks.
**Confirm by:** Name the setting and show the concrete path in this app: the production URL that goes over cleartext and what it carries (tokens, personal data), the update URL and the missing signing, the exported component and the action another app can trigger, or the debug screen and what it does in a release build.
**Disprove by:** All production endpoints are `https://`; updates come from EAS Update (served over HTTPS) or are code-signed; the debug screen and dev client are gated by `__DEV__` or the build profile; the exported component requires a signature permission or does nothing sensitive. `android.allowBackup`, missing certificate pinning, missing jailbreak or root detection and screenshot protection are hardening graded by L1, not findings here.
**Severity when confirmed:** MEDIUM. A configuration choice exposes users on hostile networks or to other apps. HIGH when an attacker on the network or a controlled update server can push code to installs, or tokens travel in cleartext; LOW when only non-sensitive content is affected.
**CWE:** CWE-319, CWE-494, CWE-926, CWE-489

### deep-link-hijack: Deep links and URL handlers that act without validation

**Look for:** Entry points reached by URL: the `scheme` in `app.json`, Expo Router routes (every file under `app/` is linkable), `+native-intent.tsx` `redirectSystemPath`, `Linking.addEventListener('url', ...)`, `Linking.getInitialURL()`, `useURL()`, notification response handlers that navigate by a payload URL. Find routes that perform an action from link parameters without user confirmation (``myapp://transfer?to=...&amount=...``, ``myapp://settings/email?new=...``, invite or join links that accept on open), links whose parameters reach `Linking.openURL(param)` or a router redirect (open redirect into a phishing page), WebViews that load a link-supplied URL with `javaScriptEnabled` and a native bridge (`onMessage`, `injectedJavaScript`), and auth callbacks on a custom scheme (custom schemes are not exclusive on Android; any app can register the same one).
**Confirm by:** Name the link (scheme or domain plus path), the parameter, and the sink it reaches without validation or a confirmation step: a state-changing API call, an open redirect, a WebView with a bridge or credentials, or a token or code handed to whatever app answers the scheme. Show that one tap on a link from a web page, message or another app is enough.
**Disprove by:** The action shows an in-app confirmation screen with the parameters and requires a tap; parameters are validated against an allowlist or a pattern; redirects and `openURL` accept only the app's own paths or domains; sensitive callbacks use verified Universal Links (`ios.associatedDomains`) and App Links (`android.intentFilters` with `autoVerify: true`), or PKCE makes an intercepted code useless; the WebView restricts `originWhitelist` and has no bridge.
**Severity when confirmed:** HIGH. A single tapped link performs an action as the user or leaks a token. MEDIUM for open redirects or WebView phishing inside the app; LOW when the link only navigates to a screen that then asks for confirmation of nothing sensitive.
**CWE:** CWE-939, CWE-601, CWE-749

### insecure-local-storage: Credentials and sensitive data stored unencrypted on the device

**Look for:** Sensitive values written to unencrypted storage: `AsyncStorage.setItem` with tokens, refresh tokens, passwords, PINs, personal or health data; `react-native-mmkv` without an `encryptionKey`; `expo-file-system` or `expo-sqlite` files with such data; Redux Persist, Zustand `persist` or React Query persisters that include the auth slice; a Supabase client configured with `auth: { storage: AsyncStorage }` (the token lands in plain storage unless wrapped); SecureStore used with a weak accessibility class for long-lived secrets; and sensitive values logged with `console.log` in release builds.
**Confirm by:** Show the stored value is a credential or sensitive personal data (trace it from the sign-in response or form field), that the storage API is unencrypted, and that the write happens in release builds. Name the key or file, never the value.
**Disprove by:** Tokens live in `expo-secure-store` (Keychain on iOS, Keystore-backed encryption on Android); the larger value is encrypted with a key held in SecureStore (the LargeSecureStore pattern in Supabase's Expo guide); MMKV is created with an `encryptionKey` kept in SecureStore; only non-sensitive preferences are stored; logging is stripped from release builds (`babel-plugin-transform-remove-console`) or gated by `__DEV__`.
**Severity when confirmed:** MEDIUM. Reading the value needs device access, a backup or a rooted or jailbroken device, but it grants the user's session or sensitive data. HIGH when the stored item is a reusable plaintext password or a long-lived credential for other systems; LOW for short-lived access tokens alone.
**CWE:** CWE-312, CWE-922, CWE-532

## Baseline

A healthy Expo app treats itself as untrusted: every authorization, price and entitlement is decided on the server (row-level security with owner or membership policies, Firebase rules that compare the owner, or server functions that check the caller). The bundle holds only publishable keys; anything secret lives behind a backend or Edge Function. Tokens are stored in `expo-secure-store` or encrypted with a key held there, and persisted caches are cleared on sign-out. OAuth uses the code flow with PKCE, and sensitive callbacks use verified Universal Links and App Links. Deep links validate parameters and ask for confirmation before any action. All endpoints are HTTPS, and over-the-air updates come from EAS Update or are code-signed. Local SQLite uses bound parameters. Certificate pinning, root detection and backup flags are graded as hardening.

## Sources

- https://owasp.org/Top10/2025/ (2026-10-23)
- https://github.com/OWASP/ASVS/tree/v5.0.0 (2026-10-23)
- https://mas.owasp.org/MASVS/ (2026-10-23)
- https://docs.expo.dev/versions/latest/sdk/securestore/ (2026-10-23)
- https://docs.expo.dev/guides/environment-variables/ (2026-10-23)
- https://docs.expo.dev/linking/overview/ (2026-10-23)
- https://docs.expo.dev/versions/latest/sdk/auth-session/ (2026-10-23)
- https://docs.expo.dev/eas-update/code-signing/ (2026-10-23)
- https://reactnative.dev/docs/security (2026-10-23)
