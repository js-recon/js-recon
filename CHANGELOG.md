# Change Log

## 2.0.1 - (unreleased)

### Added

- `--research`/`--research-output <file>` (`lazyload`, `run`) is now supported for every framework the tool detects, not just Next.js. Vue, Nuxt, Svelte, Angular, and React crawls now record a technique-name → discovered-URL-list mapping and write it to the research output file, mirroring the existing Next.js `NextJsCrawler.techniqueEfficiencyMapping` behavior. (`lazyload`)
- New `generic` fallback tech in `lazyload` for sites running no supported framework: previously an undetected framework triggered a separate Puppeteer pass just to watch loaded requests and retry framework detection, and if that still found nothing the target was otherwise left with only whatever the browser happened to load. `generic` now recursively crawls the site's own `<a href>`/`<iframe src>` links, plus absolute URLs embedded in any other attribute value such as an `onclick`-driven `window.open(...)` popup (breadth-first, capped by `--max-pages`, downloading JS incrementally per page) rather than stopping at the landing page, since the JS a site's homepage references is rarely all the JS the site has. Unless `-s`/`--strict-scope` is set, the crawl's default scope is now the host reached after following redirects from `-u` (new `--max-redirects` flag, default 20) instead of the unrestricted `*` default used elsewhere. On every page, `generic` extracts `<script src>`/inline scripts/`<link rel="modulepreload">` the same way the framework crawlers do (decoding `data:` URI script sources; skipping `<script type="...">` values that indicate non-JS content, e.g. `application/ld+json`/`speculationrules`), and additionally walks every HTML attribute value, resolving each with the `URL` constructor and — for any URL with a path segment ending in `.js` (catching cachebuster-suffixed paths like `.../beacon.min.js/v124/token` that don't end in `.js` themselves) — confirms it's actually JavaScript via its response `Content-Type` (accepting `text/javascript` per RFC 9239, plus RFC 4329's now-obsoleted `application/javascript`/`application/ecmascript` and other legacy variants) rather than trusting the extension alone. `generic` is also now seeded with every request tech detection's own Puppeteer session intercepted while live-rendering the page — this catches JS requested only because a runtime-injected script asked for it (e.g. a bot-mitigation script self-injecting its own next stage via `element.innerHTML`), which no static-fetch crawl could ever see. A new `--strings` flag chains the `strings` module into the crawl to catch JS referenced only as a string literal inside an already-downloaded file (e.g. a plugin config's `"pdfWorker": "https://.../pdf.worker.js"`), resolving each extracted string against the URL the file it was found in was itself downloaded from, and recursing (`--strings-max-iterations`, default 5) until a pass finds nothing new. `run` continues to only download JS for this tech, same as any other tech outside its supported list. (`lazyload`)
- `generic` tech now detects content stagnation on effectively unbounded sites (blogs, news feeds) that keep serving byte-identical JS under a different, cache-busted URL on every page — a pattern the existing URL-level dedup doesn't catch, which previously burned the full `--max-pages`/`--lazyload-timeout` budget on a site whose real JS surface was already fully mapped. New flags `--stagnation-timein <mins>` (default 30, `0` disables the feature), `--stagnation-percentage <percent>` (default 80), and `--stagnation-monitor <mins>` (default 1) control a debounced check: once one content hash accounts for `--stagnation-percentage`% of everything discovered so far, the crawl arms a pending state rather than stopping immediately — if a genuinely new content hash appears within the next `--stagnation-monitor` interval, monitoring resets; only if the same dominant hash persists with no new content does the crawl stop early. New exit code 27 if `--stagnation-timein` exceeds `--lazyload-timeout`, since stagnation monitoring could then never trigger before the whole crawl times out. (`lazyload`)
- New `--verbose` flag (`lazyload`, `run`) gates the file-write error message previously always printed when a downloaded JS chunk fails to write to disk (`[!] Failed to write file: <path>`). It is now silent by default and only shown with `--verbose`; no other error messages are affected. (`lazyload`)
- New `--determine-compatible-version`/`--apply-compatible-versions` flags (`analyze`) report or auto-correct the `js_recon_version`/`js_recon_max_version` a rule file actually requires, computed from a hand-maintained map (`src/utility/ruleVersionMap.ts`) of which tool version introduced each schema/engine feature (tech values, rule types, step sub-fields). Previously rule authors had to guess the compatibility string by hand, which could under- or over-restrict a rule relative to what it actually uses. Rules also now support an optional `js_recon_max_version` field for features that have since been retired; version-compatibility mismatches reported by `--determine-compatible-version` reuse exit code 20 ("invalid rules found"), same as schema errors. (`analyze`)
- `api-gateway` is renamed to `proxy` and now supports three additional outbound-proxy methods alongside AWS API Gateway IP rotation: a generic SOCKS5 proxy, a generic HTTP proxy, and Oxylabs datacenter proxies. All four methods write to a single shared `.proxy_config.json` (auto-migrated from the legacy `.api_gateway_config.json` shape). `lazyload`/`run`'s `--api-gateway`/`--api-gateway-config` flags are renamed to `--proxy-config <file>` (with a new `--ignore-proxy-env` flag and `JS_RECON_PROXY_*`/`JS_RECON_OXYLABS_*` environment variable support, resolved with CLI > env > config-file precedence); the resolved proxy is wired into both the fetch layer (via an `undici` `Socks5ProxyAgent`/`ProxyAgent` dispatcher) and Puppeteer (`--proxy-server` launch arg + `page.authenticate()`). The command itself is further segregated into one subcommand per provider — `proxy aws`, `proxy oxylabs`, `proxy socks`, `proxy http` — each with only the flags relevant to that provider (e.g. `--aws-access-key`/`--aws-secret-key` → `-a/--access-key`/`-s/--secret-key` under `proxy aws`, `--oxylabs-username` → `--username` under `proxy oxylabs`, `--proxy <url>` → `--url <url>` under `proxy socks`/`proxy http`) instead of one flat command with 17 method-tagged flags and an interactive `--proxy-method` prompt. (`proxy`)

### Fixed

- `downloadFilesUtil.ts`/`DownloadQueue` (used by every framework crawler except `generic`) determined a downloaded file's on-disk name by checking only the URL's final `/`-separated path segment for a recognized extension, with a fallback loop that scanned every segment but was unreachable in practice — it lived in a `catch` block after a regex `.match()` call that returns `undefined` on no match rather than throwing. URLs where a token or cachebuster segment follows the actual filename (e.g. `.../beacon.min.js/v124/token`) were logged as `Could not determine filename for URL: ... Skipping.` and never downloaded, even though `generic`'s own downloader already handled this exact shape. Filename resolution is now a single shared helper, `getFilenameFromUrl` (`src/utility/urlUtils.ts`), that always scans every path segment for the first one ending in a recognized extension. (`lazyload`)
- `run`'s Ctrl-C interrupt menu could show a stray leftover message from the step that was in flight when the interrupt fired: `Promise.race` doesn't cancel the loser, so the interrupted step's own promise kept running in the background and could still call `console.log`/`console.error` while the menu/prompt was on screen, interleaving its output with the prompt. All ad-hoc `console.log`/`console.error` calls across the CLI have been replaced with a new `printMsg(MSG.Level, message)` helper (`src/utility/printMsg.ts`) that funnels every message through one call site; `run/interruptHandler.ts` now calls `lockPrintMsg()` before showing the menu and `unlockPrintMsg()` after the choice is read, so any message from an orphaned in-flight step is silently discarded instead of printing over the prompt. (`run`)
- `checkAssignmentExist`/`findMemberExpressionAssignment` (used by rules like `detect_postMessage_innerHtml_sink` and `detect_postMessage_function_href`) crashed `analyze`/`run` entirely with `SES_UNHANDLED_REJECTION: Couldn't find a Program` when the resolved `postMessage` handler's sensitive assignment was nested inside an `if` block. The helper called `@babel/traverse`'s scope-aware form with a raw `File`/`Program` AST node passed in place of a real `Scope` instance, which broke Babel's internal scope-chain construction for some node shapes. Fixed by traversing with `noScope: true` instead, since the helper never reads `path.scope`. (`analyze`)
- The response cache (`makeReq.ts`) stored a live `Headers` object directly into data later passed to `JSON.stringify()`. `Headers` has no own enumerable properties, so this silently serialized to `{}` on every cache write, discarding all response headers (not just `Content-Type`) for any URL cached earlier in a run. Any header-dependent check that hit a cached URL a second time (e.g. `generic`'s Content-Type-based JS confirmation) could silently fail depending on whether something upstream had already cached that URL. Fixed by converting to a plain object (`Object.fromEntries(headers.entries())`) before serialization. (`utility`)
- `checkVueJS.ts`'s last-resort tech-detection fallback scanned every externally-referenced `<script src>`, including cross-origin third-party scripts, for the substring `__vue`. A third-party widget that internally bundles Vue for its own UI could cause a site with no Vue anywhere in its own code to be misclassified as Vue.js. The fallback now only scans same-origin scripts. (`lazyload`)
- `strings`: a single file that fails to parse as JS (e.g. non-JS content saved with a `.js` extension) no longer aborts extraction for every other file in the scan — the parse error is now caught, logged, and skipped per-file. (`strings`)
- `lazyload --strings` (generic tech): each recursive strings-discovery pass rescans the same (ever-growing) output directory, since the `strings` module has no incremental-scan mode. Every already-confirmed URL from a prior pass was being re-confirmed via a fresh live `GET` request on every subsequent pass, compounding badly on large multi-hundred-page crawls. Already-known URLs are now filtered out before the Content-Type confirmation step, not after. (`lazyload`)
- `DownloadQueue`'s write-error log interpolated the raw error object (`${writeErr}`). For a `prettier.format()` parse failure the thrown `SyntaxError`'s message has Babel's codeframe appended after the first line, and on minified JS (a single giant line) that codeframe is the entire file — dumping the whole source to the terminal instead of just the error. The logged message is now truncated to the first line (`String(writeErr).split("\n")[0]`), e.g. `SyntaxError: Missing semicolon. (2:4)`. (`lazyload`)
- `npm audit` reported 12 advisories (3 moderate, 9 high) on this branch: a path-traversal advisory in the `@hono/node-server` transitive dependency pulled in by `@modelcontextprotocol/sdk`, and a DoS advisory in `brace-expansion` pulled in transitively via `puppeteer-extra-plugin-stealth`'s `rimraf`/`glob`/`minimatch` chain. Resolved via an `overrides` entry pinning `@hono/node-server` to `^2.0.11` and `rimraf` to `^6.0.1`; a subsequent `npm audit fix` lockfile refresh also cleared the remaining `fast-uri`/`postcss` advisories. (`deps`)
- The `rimraf@6` override above broke `puppeteer-extra-plugin-user-data-dir` (a transitive dependency of `puppeteer-extra-plugin-stealth`), which still calls the old `rimraf(path, opts, callback)` API; `rimraf@6` no longer exports a default callable function, causing `TypeError: rimraf is not a function` whenever a Puppeteer session disconnected during `run`. Patched via `patch-package` to use `fs.rm` instead of `rimraf` in that plugin. (`run`, `deps`)
- `npm ci`/`npm install` produced an `EBADENGINE` warning on Node <22.12, puppeteer 25.x's minimum supported version. Added a `.nvmrc` pinning Node 22 (matching the `cs-mast` sibling repo's convention) so `nvm use` picks a compatible version automatically. (`deps`)
- `map`'s per-file size guard (`MAX_MAP_FILE_SIZE_BYTES`, present identically across `getReactConnections.ts`/`getViteConnections.ts`/`getAngularConnections.ts` and the shared fetch/XHR/HTTP-client resolvers) skipped any file over 1.5 MB with no fallback chunk, so a single large un-split app bundle vanished from `mapped.json` entirely — `refactor` then ran against whatever small chunks were left instead of the app, reporting near-zero recovery. Raised the cap to 8 MB; the guard's purpose is capping the many-large-files case (ad-heavy sites), not a single reasonably-large main bundle. Also hardens `run`'s CS-MAST-S bundler detection (react-webpack vs react-vite): adds a cheap literal bundler-runtime-marker pre-check that short-circuits the structural comparison when unambiguous, and raises the random sample size to cover the current signature bucket, since undersampling could previously flip which tech "won" between identical runs against the same bundle. (`map`, `run`)
- `map`'s Next.js webpack chunk-code extraction (`getWebpackConnections.ts`) stripped a chunk's numeric-ID object-literal prefix (e.g. `0:function(e,t,n){...}` → `function webpack_0(e,t,n){...}`) via two regexes that both assumed the minifier inserts whitespace between the colon/`function` keyword and the following token. Real-world minified output commonly omits that whitespace, so the prefix was left in place — invalid syntax that failed to parse downstream in `refactor -t next-webpack`, silently dropping the module instead of processing it. Also affected `refactor`'s CS-MAST library classification, since a chunk that never parses can never be checked against the signature set either. Fixed by relaxing both regexes' whitespace assumption (`\s+` → `\s*`, plus a missing `\s` escape in the arrow-form regex). Verified against a real-world target: eliminated all parse failures on a previously 96%-failing chunk set and raised its library-classification rate from ~3% to 94%. Follow-up: the arrow-form regex still required a literal `(` immediately after the numeric-ID colon, missing JS's single-parameter arrow shorthand with no parens (`3562:e=>{...}`, common in lodash-style utility functions). Fixed by matching either `(` or a bare identifier followed by `=>` via lookahead, stripping only the `id:` prefix and leaving the arrow's own param syntax untouched. (`map`)

## 1.4.1-beta.1 - 2026-07-16

### Fixed

- Homebrew: documented the fix for `Formulae found in multiple taps` / `Refusing to load formula ... from untrusted tap ...` errors hit by users who still have the old `shriyanss/tap` tapped from before the `js-recon` org migration. `js-recon/homebrew-tap` was created by renaming `shriyanss/homebrew-tap`, so GitHub still transparently resolves the old tap name to the same repo content — leaving two tap names serving an identically-named `js-recon` formula. Run `brew untap shriyanss/tap` before installing from `js-recon/tap` (see README.md and the Homebrew installation docs). (`docs`, `homebrew`)

## 1.4.1-alpha.10 - 2026-07-15

### Changed

- The project has moved to the `js-recon` GitHub organization. The npm package is now published as **`@js-recon/js-recon`** (previously `@shriyanss/js-recon`) — update your install commands accordingly. Container images are now published only to `ghcr.io/js-recon/js-recon` (Docker Hub publishing has been discontinued). The Homebrew tap is now `js-recon/tap` (`brew tap js-recon/tap`), and the Terraform modules are published under the `js-recon/js-recon/<cloud>` registry namespace. (`all`, `ci`, `docker`, `homebrew`)

## 1.4.1-alpha.9 - 2026-07-15

### Fixed

- Homebrew: `brew install js-recon` now always installs the latest **stable** release instead of whichever version (including alphas/betas) was most recently promoted. `promote-js-recon.yml`'s Homebrew tap job is now channel-aware — it updates `Formula/js-recon-alpha.rb` / `Formula/js-recon-beta.rb` for prerelease promotions and leaves the main `Formula/js-recon.rb` (stable) formula untouched. Alpha/beta channels are now available via `brew install js-recon/tap/js-recon-alpha` / `js-recon-beta`, mirroring the existing `:alpha`/`:beta` Docker/GHCR tags. (`ci`, `homebrew`)
- `run` (batch mode, `-u <file>`): the generated OpenAPI spec and Postman collection (`mapped-openapi.json`, `mapped-openapi.postman_collection.json`) are no longer contaminated with endpoints from previously-processed targets in the same batch run. `openapiOutput` in `utility/globals.ts` is an accumulator that every map resolver pushes into, and it was never cleared between targets — so target N's output silently inherited every endpoint discovered for targets `1..N-1`. A new `clearOpenapiOutput()` is now called alongside the existing `clearJsUrls()`/`clearJsonUrls()` reset at the start of each target's pipeline. (`run`, `utility`)
- `refactor`: when the remote CS-MAST-S signature lookup for the active tech/scat/branch combination comes back empty (e.g. a non-default `--scat` value not yet covered by the dataset), the run's final summary now prints an explicit, high-visibility recap block (`LIBRARY STRIPPING WAS SKIPPED FOR THIS RUN`, naming the tech/scat/branch) in addition to the existing inline warning. Previously this was a single line that could scroll by unnoticed mid-run, so batch/automated invocations could silently lose library stripping with no easy signal that the output still contains library code. (`refactor`)
- `refactor -t next-webpack`: chunks whose module wrapper is a named `function` declaration (`function webpack_<id>(...)`, synthesized whenever the original bundle module was itself a `function` expression — the dominant form on real-world bundles) are now correctly recovered. Previously the traversal only visited `ArrowFunctionExpression` nodes, so these chunks were reported as `No module function found`, and in the rare cases where a nested arrow function's immediate parent happened to be an assignment, that unrelated inner fragment was captured as a false-positive "recovered" module. Both wrapper forms are now supported and the top-level check requires the wrapper to be a direct child of `Program`. Also fixes `next/validator.ts`'s `_generator` import, which was missing the `?? _generator` ESM interop fallback present in the react validator and broke under Vitest, blocking unit test coverage of this module. (`refactor`)
- `refactor`: the per-file signature cache's 7-day age-based TTL had no way to detect that the upstream HuggingFace dataset content changed within that window, so a stale-but-not-expired (or emptied/corrupted) cache entry was silently trusted, producing non-deterministic `chunks_library_skip`/`files_recovered` results across otherwise identical runs. Each bucket file's content hash is now fetched from the HF tree API once per branch per run and compared against the hash recorded when the entry was cached (`remote_hash.txt`); a mismatch invalidates the cache immediately regardless of age, and an unavailable remote hash falls back to the pre-existing age-based check. The hash-fetch call is wrapped in try/catch so a transient failure (e.g. HF API rate-limiting under concurrent invocations) degrades gracefully to the age-based check instead of throwing an unhandled rejection that silently aborted the whole run (`chunks_total: 0`, no visible error). (`refactor`)

## 1.4.1-alpha.8 - 2026-07-14

### Changed

- CI: `promote-js-recon.yml`'s Homebrew tap job now reads its push token (`HOMEBREW_TAP_GH_PAT`) from a scoped `homebrew-publish` GitHub Environment, restoring push access after the previous repo-wide `HOMEBREW_TAP_TOKEN` was retired. (`ci`)

## 1.4.1-alpha.7 - 2026-07-14

### Changed

- CI: bot commits (`chore: prettify code`, `chore: merge changes after release vX.Y.Z`) are now cryptographically signed via SSH (using [`shriyanss/verified-commit-action`](https://github.com/shriyanss/verified-commit-action)) and show as "Verified" on GitHub, under a dedicated `js-recon-bot` identity. The signing key is scoped to a `commit-signing` GitHub Environment so it's only readable by the jobs that need it, not the whole repo. `promote-js-recon.yml`'s Docker/GHCR publish job now reads `DOCKER_SECRET` from a similarly scoped `docker-publish` environment, and the Homebrew tap job no longer references a token secret. (`ci`)

## 1.4.1-alpha.6 - 2026-07-13

### Changed

- CI: npm publishing now uses OIDC trusted publishing with staged releases (`npm stage publish`) instead of a classic auth token, since NPM is restricting tokens that bypass MFA. Promoting a staged release to live still requires a manual, 2FA-gated `npm stage approve` — this cannot be automated. The Homebrew tap update and Docker/GHCR image publishing have moved out of `publish-js-recon.yml` into a new manually-triggered workflow, `promote-js-recon.yml`, run after the staged release is approved. That workflow installs js-recon from the published npm registry artifact (`npm pack`/`npm install <pkg>@<version>`) rather than building from git source, as an additional supply-chain safeguard — what ships in the Docker/GHCR images and what Homebrew hashes is provably the same bits that were reviewed and approved on npm. (`ci`)

## 1.4.1-alpha.5 - 2026-07-13

### Fixed

- Homebrew install: `puppeteer-extra` now receives the ESM `puppeteer` instance directly via `addExtra()` instead of relying on its internal `require('puppeteer')` call. On newer Node.js versions (22+, as shipped by Homebrew), a synchronous `require()` of an ESM module triggers `ExperimentalWarning` on every run. Using `addExtra()` bypasses the `require()` entirely and silences the warning. (`all`)
- `lazyload` (tech detect, react): React framework detection now works for Vite dev-mode servers. Vite's `@vitejs/plugin-react` and `@vitejs/plugin-react-swc` inject an inline `<script>` block containing `import { injectIntoGlobalHook } from "/@react-refresh"` into every dev-served page. Previously, none of the `REACT_MARKERS` matched this content, so dev-mode targets returned `unknown`. Two fixes: (1) `@react-refresh` and `injectIntoGlobalHook` are now included in `REACT_MARKERS` so the inline-script branch of `checkReact` fires immediately; (2) `/@react-refresh` is now a fast-path match in `fetchAndCheck` so any script src pointing at the HMR endpoint is also caught; (3) the intercepted-URL fallback in `frameworkDetect` now recognises `/@react-refresh` as a React signal alongside the existing Next.js / Nuxt / Svelte URL patterns. (`lazyload`, `fingerprint`, `run`)
- `lazyload` (tech detect, angular): Angular framework detection is now more robust. Three HTML-level signals are checked before fetching `main.js` — `data-beasties-container` (Angular's Beasties SSR/prerendering marker), `ng-version` (set by the Angular runtime on the root component element after bootstrapping, visible in Puppeteer-rendered DOM), and `_nghost-*` view-encapsulation attributes. These checks require no extra HTTP request and work even for zoneless Angular apps (Angular 16+) that omit Zone.js and therefore lack the previous `isAngularZone`/`this.ngZone` patterns. The `main.js` src pattern was also broadened from `main-` (hashed production builds only) to also match `main.js` (unhashed development builds). (`lazyload`, `fingerprint`, `run`)
- `lazyload`, `map`, `strings`: `.mjs` (ES module) files are now fully supported across all framework pipelines. Previously, extension filters in `downloadQueue.ts`, `downloadFilesUtil.ts`, `downloadLoadedJsUtil.ts`, `react_followImports.ts`, `getReactConnections.ts`, `getViteConnections.ts`, `getAngularConnections.ts`, `vue_resolveHttpClient.ts`, `vue_resolveFetch.ts`, `vue_resolveXhr.ts`, `crossFileResolver.ts`, and `strings/index.ts` only matched `.js` files. Sites that bundle all application code as `.mjs` (e.g. Framer/Rolldown) were silently ignored — all chunks were downloaded but zero files were scanned for connections, strings, or secrets. All affected paths now match both `.js` and `.mjs`. (`run`, `lazyload`, `map`, `strings`)
- `run` (react): The map step now receives the full `outputDir` (all downloaded hosts) rather than only the target host's subdirectory. Previously, when a React site served all its JS from a CDN host, the map step was pointed at an empty target-host directory and reported zero chunks. Now mirrors the Vue pipeline's directory-passing behaviour so CDN-hosted chunks are analysed correctly. (`run`, `map`)
- `lazyload` (react): `react_followImports` now discovers dynamic imports written as template literals (``import(`./chunk.mjs`)``) in addition to single/double-quoted strings. Bundlers that use Rolldown (e.g. Framer) emit all dynamic import paths as template literals; the previous regex only matched quoted strings, silently missing all lazily-loaded page and collection chunks. (`lazyload`, `run`)
- `lazyload`: `.mjs.map` sourcemap files are now handled correctly. The filename extraction regex now prefers the `.mjs.map` suffix over the shorter `.mjs` match, preventing sourcemap JSON content from being written with a `.mjs` extension (which caused Prettier's Babel parser to throw a `SyntaxError` and discard the file). The sourcemap write path now uses the JSON parser for both `.js.map` and `.mjs.map` files. (`lazyload`, `run`)
- `lazyload` (Puppeteer): `downloadLoadedJsUtil` now uses `waitUntil: "networkidle0"` with a 10 s timeout on `page.goto()`. Previously the call had no timeout and no error handling, so pages whose `load` event never fires (deferred JS, service workers, some SPA patterns) caused the lazyload step to hang indefinitely. Navigation errors and timeouts are now caught and the URLs collected up to that point are returned normally. (`lazyload`, `run`)
- `lazyload` (Puppeteer): `browser.close()` in `downloadLoadedJsUtil` is now wrapped in a try/catch; if it hangs, the Chrome process is force-killed via `SIGKILL`. Previously a stuck `browser.close()` caused the process to hang after download was otherwise complete. (`lazyload`, `run`)
- `lazyload` (Puppeteer): All three Puppeteer-using modules (`downloadLoadedJsUtil`, `next_GetLazyResourcesWebpackJs`, `techDetect/index`) now abort non-http/s requests (e.g. `mailto:`, `data:`, `blob:`, `chrome-extension:`, `tel:`) in the request interceptor instead of calling `request.continue()`. Calling `continue()` on these schemes throws an unhandled error and can trigger OS protocol handlers. (`lazyload`, `run`)
- `lazyload` (Puppeteer): `downloadLoadedJsUtil` and `next_GetLazyResourcesWebpackJs` now pass `--disable-external-protocol-dialog` to Chrome at launch and install an `evaluateOnNewDocument` guard that overrides `window.open` and suppresses clicks on non-http/s anchors. This provides a three-layer defence (Chrome flag + JS intercept + request interceptor abort) ensuring that non-http protocol links on target pages never invoke OS handlers (mail client, phone, etc.). (`lazyload`, `run`)
- `lazyload` (Puppeteer): All three Puppeteer-using modules now issue a `Page.setDownloadBehavior({ behavior: "deny" })` CDP command immediately after page creation. This prevents accidental file downloads triggered by download-link clicks or JavaScript during crawl, which could block the browser and fill the output directory with unexpected files. (`lazyload`, `run`)
- `lazyload` (tech detect): After `waitUntil: "load"` resolves, if no framework URL has been captured in `interceptedUrls` yet, a conditional `page.waitForNavigation({ timeout: 5000 })` is now issued to wait for a second navigation event. This catches sites that serve a JS proof-of-work bot challenge (e.g. Vercel's `challenge.v2.min.js`) that fires its own `load` event before calling `window.location` to redirect to the real app. Previously, Puppeteer exited on the challenge page's `load` event and tech detection returned null (exit 10). On sites with no redirect the navigation wait times out after 5 s and detection continues normally. (`lazyload`, `run`)
- `lazyload`: When `frameworkDetect` returns null and `downloadLoadedJs` is used as a fallback, the downloaded file URL paths are now scanned for `/_next/`, `/_nuxt/`, and `/_app/immutable/` signatures as a second-chance tech detection pass. Previously, sites that serve their framework app at a non-root `basePath` (e.g. Next.js at `/app` instead of `/`) caused the initial Puppeteer-based detection to miss the framework because the intercepted JS paths didn't match any framework pattern, resulting in exit 10. (`lazyload`, `run`)
- `lazyload` (next_js): `next_parseLayoutJs` now applies a 1.5 MB per-file size guard — checked from both the `Content-Length` response header and the fetched content body — before passing layout files to the AST parser. Files exceeding the limit are skipped with a yellow warning. Previously, Next.js App Router sites with 50+ nested pages each loading a large `layout.js` caused cumulative AST memory of ~2 GB, exhausting the V8 heap and crashing with SIGSEGV (exit 139). (`lazyload`, `run`)
- `cs-mast`: `--scat`, `--sinc`, `--all-scat-permutations`, `--perm-output`, and `--perm-concurrency` flags were declared in the CLI but not wired to the underlying function, causing a TypeScript compile error (`TS2554: Expected 5 arguments, but got 10`). The function now accepts all five additional parameters: `--scat`/`--sinc` override the active CS-MAST config, and `--all-scat-permutations` runs all 511 non-empty scat subsets in parallel batches and writes one collision file per subset to `--perm-output`. (`cs-mast`)

- `refactor -t react-vite`: vendor chunks (`vendor-react-*.js`, `rolldown-runtime-*.js`) that are absent from `mapped.json` are now automatically located in the downloaded assets directory and injected before the refactor pass. Previously, `mapped.json` typically contained only app chunks — vendor chunks are excluded from mapping because they hold only third-party code. This left `vendorExportMaps` empty, so the `rewriteVendorImports` pass had nothing to match against and vendor import statements like `import { d as t } from './vendor-react-CLFLfR9F.js'` survived into the output, causing the Vite build check to fail with "Could not resolve". The fix uses the existing `findAssetsDir`/`findVendorChunkFiles` helpers (already used by the webpack branch) to discover the assets directory from `// File Source:` headers in chunk code.
- `lazyload` (nuxt): `nuxt_getFromPageSource` now prints the number of new JS files discovered (delta from the global URL set) instead of the running total. Previously the count included every URL already known from earlier in the session.
- `lazyload` (vue): Each discovery method in `vue_discoverJsFiles` now prints only the count of URL that are genuinely new — URLs already known from earlier methods are excluded. Previously `fromImports.length`, `fromStringRefs.length`, etc. could include URLs already in the accumulator and over-count.
- Error messages emitted by `makeReq` (fetch failures, cache errors, timeout notices, firewall detection) now use `progressError`/`progressLog` instead of `console.error`/`console.log`, so they are routed through the active progress bar's logger and no longer clutter the bar line when errors occur during a scan.
- `refactor` (`react-webpack`, `react-vite`): new `--detect-version` flag. When set, the tool fetches per-version `reliable_signatures.json` files from the `shriyanss/cs-mast-s-dataset` HuggingFace bucket (path: `version/react/<bundler>/<version>/<scat>/reliable_signatures.json`) and matches them against CS-MAST signatures generated from the target bundle's chunks. The best-matching React version is used to set `react` and `react-dom` version pins in the refactored output's `package.json` instead of the default `^18.3.1`. Signatures are cached under `~/.js-recon/refactor/version_sigs_cache/` with a 7-day TTL. Supports all webpack versions (react-0.12 through react-19) and all Vite versions (react-16 through react-19) available in the dataset. (`refactor`)

### Added

- `fingerprint`: output files are now written incrementally — each result is flushed to disk immediately after detection rather than buffered and written at the end. For text, csv, and jsonl formats the result is appended; for json the full array is rewritten. Output files are also created (and csv headers written) before the worker pool starts, so a partial file always exists if the scan is interrupted. (`fingerprint`)
- CLI: help output is now colorized. Section titles (`Usage:`, `Options:`, `Commands:`) are bold cyan; flag names are yellow; `<required>` argument placeholders are magenta; `[optional]` argument placeholders are cyan; descriptions are dimmed; and `(default: …)` suffixes are dim italic. Applies to every subcommand.
- `run`: the pipeline now runs an optional `refactor` pass after the report step for React, Vue, Nuxt, and Next.js targets. The bundler (webpack vs vite) is detected automatically using CS-MAST-S signatures sampled from the `shriyanss/cs-mast-s-dataset` HuggingFace bucket — the same bucket and caching layer used by `refactor --remote-collisions`. If the detected match count meets `--cs-mast-tech-detect-threshold` (default `50`), `refactor` is called with the full tech identifier (e.g. `react-webpack`); otherwise the step is silently skipped. Refactored output is written to `refactored/` (single-URL mode) or `<workingDir>/refactored/` (batch mode). Currently only React bundles have bucket entries; Vue, Nuxt, and Next.js gracefully skip until their signatures are added to the bucket. (`run`, `refactor`)
- `run`: new `--cs-mast-tech-detect-threshold <n>` flag (default `50`). Sets the minimum number of CS-MAST-S signature matches required to consider a bundler detected for the refactor step. Pass `0` to disable refactor entirely. (`run`)
- `refactor` (`react-vite`, `react-webpack`): new `--remote-collisions <path>` flag. Accepts a HuggingFace bucket path (e.g. `react/vite/large-0.1.8`) and uses it as the signature source instead of the automatic `TECH_TO_BRANCH` mapping. When the path does not exist in the `shriyanss/cs-mast-s-dataset` bucket the tool exits with code 25. The existing caching layer is fully reused — signatures are cached under `~/.js-recon/refactor/signature_cache/` and the file list is cached in `~/.js-recon/refactor/cs-mast-s-list-cache.json`. Feature directories that contain no collision records in the dataset are skipped during intersection rather than collapsing the result to zero.
- `refactor` (`react-webpack`, `react-vite`): `--detect-version` now uses multiple scat configurations for improved accuracy. Three new flags control the behaviour: `--detect-version-config` (default `dynamic`), `--detect-version-dynamic-threshold` (default `3`), and `--detect-version-dynamic-conf-purge`. In `dynamic` mode the tool automatically selects up to `--detect-version-dynamic-threshold` scat configs that have non-empty reliable signatures across all known React versions, caches the selection in `~/.js-recon/refactor/config.json`, and aggregates match counts across all configs per version for a stronger detection signal. Alternatively, passing comma-separated scat categories (e.g. `lit,decl,loop,cond`) to `--detect-version-config` fixes the config; the tool validates signatures are non-empty for every version and exits with code 26 if not. Use `--detect-version-dynamic-conf-purge` to force recomputation of the cached config.

### Changed

- Set `react/webpack/large-0.1.8` as default cs-mast-s dataset for react + webpack refactoring

## 1.4.1-alpha.4 - 2026-06-29

### Added

- `sourcemaps`: new subcommand to extract original source files from `.map` sourcemaps without running the full pipeline. Accepts a single `.map` file or a directory of `.map` files via `-i`/`--input`; writes recovered sources to `-o`/`--output` (default: `extracted`).
- Homebrew tap distribution: `brew tap js-recon/tap && brew install js-recon` installs js-recon via the `js-recon/homebrew-tap` Homebrew tap. The formula (`Formula/js-recon.rb`) auto-updates on every npm publish via the `update-homebrew-tap` CI job in `publish-js-recon.yml`.

### Changed

- `lazyload`: sourcemap extraction logic moved to the new `sourcemaps` module (`src/sourcemaps/`). Behaviour is identical; `lazyload` now delegates to `extractSourceMaps` from that module rather than containing a private copy.

## 1.4.1-alpha.3 - 2026-06-25

### Added

- `run`: `--include-methods`, `--exclude-methods`, and `--list-methods` flags are now available on the `run` command, mirroring the same flags on `lazyload`. All three lazyload passes inside the `run` pipeline (initial, subsequent-requests, and re-pass) honour the method filter. `--list-methods [framework]` prints available method names and exits before any network work, so it can be used without a `-u` target URL.

- `run` (angular): Full 4-step pipeline support for Angular apps — lazyload → map → analyze → report. Previously the pipeline halted after lazyload with a warning; Angular targets now get the same depth of analysis as React and Vue. The map step resolves Angular `HttpClient` calls (`n.get(url)`, `n.post(url, body)`, etc.) via the shared HTTP-client resolver and native `fetch()` calls via the shared fetch resolver; the analyze step runs all rules whose `tech` array includes `"angular"` (or `"all"`); the report step generates the HTML/SQLite report as for other frameworks.

- `map`: Angular support via new `angular_js/` module. `getAngularConnections` reads Angular CLI (esbuild) chunks from the download directory and emits one chunk per JS file. Polyfill bundles (`polyfills-*.js`) are excluded (vendor code only). Registered as a new tech option (`-t angular`) alongside `next`, `vue`, `react`, and `svelte`.

- `analyze`: Angular added as a valid `tech` value in rule YAML and the Zod schema. Rules whose `tech` array lists `angular` (or `all`) now run when `--tech angular` is set (or when `run` detects Angular automatically).

- `rules` (angular): New rule `detect_angular_bypass_security_trust` detects calls to `bypassSecurityTrustHtml`, `bypassSecurityTrustScript`, `bypassSecurityTrustStyle`, `bypassSecurityTrustUrl`, and `bypassSecurityTrustResourceUrl` — Angular's DomSanitizer bypass methods that disable built-in XSS protection. Severity: high. Added `angular` to the `tech` array of all 17 existing AST rules that previously covered only `next`, `vue`, `react`, and `svelte`.

- `refactor -t react-vite`: new Vite (rolldown) React refactor mode. Takes a `mapped.json` whose chunks are Vite-produced ESM files and outputs one `.jsx` file per app chunk with library boilerplate removed and readable source recovered:
    - Analyzes all vendor chunks (`vendor-react-*.js`) to classify every export as `react`, `react/jsx-runtime`, `react-dom/client`, or `react-router-dom`
    - Detects CJS interop vars — both `__toESM(getter(), 1)` and bare `getter()` forms — and rewrites `(0, x.prop)(args)` calls to bare canonical names (`useState(args)`, `jsx(...)`, etc.)
    - Rewrites the vendor import statement to direct canonical library imports (`import { useState, useEffect } from 'react'`, etc.)
    - Reuses shared cleanup passes from the webpack refactor: `slicedToArray` collapse, JSX recovery (handles rolldown's template literal tag names `` `div` ``), Babel helper removal, unused-import pruning
    - Runs a Vite build check after writing output: scaffolds a minimal Vite project in the output directory, renames `.js` → `.jsx`, rewrites relative dynamic imports, installs dependencies, and runs `vite build` to confirm the refactored code compiles

- `refactor -t react-webpack`: new `--scat <categories>` flag overrides the CS-MAST scat category set used for both the remote signature download and the module classifier. Accepts a comma-separated list of categories from `lit,id,op,decl,loop,cond,name,val,op_name` (e.g. `--scat lit,decl,cond`). The flag correctly maps to bucket directory names following the canonical `ALL_SCAT_CATEGORIES` ordering (the same ordering used by `jsr-cs-mast-s-gen`), so `--scat lit,cond,decl` and `--scat decl,lit,cond` both resolve to the `lit-decl-cond` bucket directory.

- `lazyload` (svelte): `svelte_getVersionJson` — probes `/<appDir>/version.json` when SvelteKit is detected. SvelteKit generates this file at build time and serves it for the `updated` store; because it has no `<script src>`, `<link href>`, or `import()` reference anywhere it is invisible to all other discovery steps and must be fetched directly. The `appDir` is derived from the entry-point URLs already discovered (default: `_app`). The method is registered in `methodFilter.ts` and can be skipped via `--exclude-methods svelte_getVersionJson`.

- `run` (nuxt): Full 4-step pipeline support for Nuxt.js apps — lazyload → map → analyze → report. Previously the pipeline halted after lazyload because `nuxt` was not in the supported-techs allowlist; Nuxt targets now run the same pipeline as Vue.

- `lazyload` (nuxt): `nuxt_getBuildsManifest` — probes `/_nuxt/builds/latest.json` and derives `/_nuxt/builds/meta/<id>.json` from it. Both files are fetched at runtime by the Nuxt client for incremental-deployment support but are never referenced from HTML or JS string literals, making them invisible to all other discovery steps. The method is registered in `methodFilter.ts` and can be skipped via `--exclude-methods nuxt_getBuildsManifest`.

### Changed

- `refactor -t react-webpack`: remote signatures now load from the HuggingFace bucket `shriyanss/cs-mast-s-dataset` (bucket prefix `react/webpack/large`) instead of the old dataset branch `react-small`. The bucket uses a structured prefix layout (`main/`, `react/webpack/small/`, `react/webpack/large/`). The local cache key changes from `react-small/` to `react/webpack/large/`, automatically invalidating any stale cache.

### Fixed

- `refactor -t react-webpack`: lazy-loaded components are now converted to true dynamic `import()` calls (Pass 4.5). Previously, webpack's async chunk-loading expression `__webpack_require__.e(N).then(__webpack_require__.bind(__webpack_require__, N))` was emitted as-is with `__webpack_require__` undefined in the output, causing a runtime `ReferenceError`. Pass 4.5 detects this pattern by matching the `.e(N)` / `.bind(requireParam, N)` shape and replaces it with `import('./N.js')`, producing a valid dynamic import that works in any ES module environment.
- `refactor -t react-webpack`: minified route-component variable names are now renamed to descriptive names derived from their `<Route path="…">` attributes. `renameRouteComponents` traverses the JSX `<Routes>` tree, accumulates path segments, generates a PascalCase component name per route (e.g. `/admin/users` → `AdminUsers`, `/admin/index` → `AdminDashboard`), and renames the corresponding `lazy(() => import('./N.js'))` declarations via `scope.rename`. The Suspense fallback component is renamed `Loading`. The App component function is renamed `App`.

- `lazyload` (svelte): `svelte_getFromPageSource` now extracts JS entry-point paths from inline `<script>` bodies by matching `import("...")` call arguments. SvelteKit `adapter-node` boots the client via `Promise.all([import("./_app/immutable/entry/start.js"), ...])` with no `src` attribute, which the previous HTML-attribute-only parser missed entirely, causing 0 JS files to be downloaded. The fix seeds the entry-point URLs so the downstream ESM import-following loop (`react_followImports`) can traverse the full chunk graph.
- `lazyload` (react): `react_followImports` `__vite_mapDeps` handler now correctly resolves SvelteKit's file-relative chunk paths (`"../nodes/0.js"`) in addition to Vue/React's root-relative paths (`"/assets/chunk.js"`). Previously all non-absolute paths had `/` prepended before URL resolution, causing `"../nodes/0.js"` to become `"/../nodes/0.js"` which the URL constructor normalized to `"/nodes/0.js"` — a wrong origin-root path that produced 404 responses. The fix resolves paths starting with `/` against `baseUrl` (origin root) and all other paths against `fileUrl` (the chunk containing the mapDeps table). This eliminates 32 spurious "Failed to write file" errors per SvelteKit run; the correct 34 chunk files were still downloaded via `svelte_stringAnalysisJSFiles`, so analysis results were unaffected.

## 1.4.1-alpha.2 - 2026-06-20

### Fixed

- `lazyload`: `--include-methods`, `--exclude-methods`, and `--list-methods` flags were listed as Added in v1.4.1-alpha.1 but the CLI wiring was absent from that release; they are now fully implemented and functional
- `lazyload`: `--list-methods` works without `-u`; the URL option is now validated manually so `--list-methods` can run standalone
- `refactor`: `-l`/`--list` no longer errors with "Mapped JSON file does not exist" when listing technologies — the list early-return now runs before the file-existence check

## 1.4.1-alpha.1 - 2026-06-20

### Added

- `lazyload`: `--include-methods <methods>` and `--exclude-methods <methods>` flags for selective method execution. Comma-separated method names are matched against the file-based method registry in `src/lazyLoad/methodFilter.ts`; invalid names exit with code 22. Methods are named after their source files (e.g. `next_bruteForceJsFiles`).
- `lazyload`: `--list-methods [framework]` flag prints all available method names grouped by framework (`next_js`, `vue`, `nuxt_js`, `svelte`, `angular`, `react`) and exits. Optionally pass a framework name to filter the output.
- `lazyload`: `--research` now tracks and writes technique efficiency output for all frameworks (Vue, Nuxt, Angular, React, Svelte), not just Next.js.

- `cs-mast`: new subcommand that computes CS-MAST-S (Context-Stratified Merkelized Abstract Syntax Tree) signatures for every downloaded `.js` file and finds structural hash collisions across targets (`cs-mast`)
    - `--ct / --collision-table`: print a collision table sorted by frequency (files sharing the same CS-MAST-S root signature)
    - `--min-collisions <n>`: minimum number of files that must share a signature to appear in the table (default: 2)
    - `--co / --collision-output <file>`: write collision results to a file; independent of `--ct` (file is written without printing the table if `--ct` is omitted)
    - `--cf / --collision-format json|csv`: output format (default: csv); if `--co` is a directory or has no extension, the file is written as `collisions.<fmt>` in the current working directory
    - Uses `@shriyanss/cs-mast` with `scat: [lit, decl, loop, cond]`, SHA-256, `sourceType: unambiguous`; parse errors are skipped with a warning

- `refactor -t react-webpack`: new React webpack refactor mode that splits a webpack 5 bundle into individual ES module files (`refactor`)
    - Numeric module map (`var e = { 540: fn, … }`) is extracted and each module written to `<id>.js` with full ES import/export conversion (require→import hoisting, exports→named/default export rewriting, outer wrapper stripped)
    - Non-module IIFE content (bootstrap helpers, root component, `ReactDOM.render` call) is captured into `index.js`
    - Webpack require helper is detected by its `return (moduleMap[id](…), mod.exports)` return shape and stripped from `index.js`
    - Top-level `requireFn(N)` calls in `index.js` are hoisted to `import * as x from "./N.js"`; remaining inline calls are replaced recursively throughout the file
- `refactor --collisions` now accepts a per-feature results directory (a directory whose immediate subdirs each contain `<scat>/collisions.json`, e.g. a 18-feature corpus with `01-usestate-hook-webpack/lit-decl-loop-cond/collisions.json` etc.) — reads only the scat-relevant file per feature subdir, intersects the max-count signature sets across all features, and uses the intersection as the library baseline; works even when the full dataset is hundreds of GB (`refactor`)
- `refactor -t react-webpack`: Pass G now strips three additional Babel inline helpers emitted to the IIFE body — `_typeof` (lazy self-reassignment typeof polyfill, detected by single-return body reassigning its own binding), `_defineProperty`/`_toPropertyKey`/`_toPrimitive` (property-setter helpers, detected by `Object.defineProperty` call with `{value, enumerable, configurable, writable}` descriptor), and `_objectSpreadPropsHelper` (detected by `Object.keys` first-statement + `getOwnPropertySymbols` reference) — cleaning up noise left by JSX spread and object spread (`refactor`)

### Fixed

- Puppeteer browser launch now resolves a usable Chrome/Chromium via a new `getChromiumPath` utility (`PUPPETEER_EXECUTABLE_PATH` env var → well-known system paths → `which`) and passes it as `executablePath`; also adds `--disable-dev-shm-usage` to the sandbox-disabled arg list — fixes crashes on systems where Puppeteer's bundled Chrome is absent or has missing shared libraries (`lazyload`, `makeReq`)
- `refactor --collisions`: `scanExportMap` now records a self-reference when a module export's RHS is a complex expression (e.g. a function declaration) so it participates in canonical library classification checks instead of being silently dropped (`refactor`)
- `refactor --collisions`: added `Profiler` to `REACT_CANONICAL` export set (`refactor`)

### Changed

- `refactor -t react` renamed to `refactor -t react-webpack` to make the bundler explicit
- Improved tool description in `globalConfig.ts`

## 1.3.2 - 2026-07-15

### Fixed

- Rules auto-download now works under the `js-recon` GitHub organization. Backported stable hotfix (functionally identical to 1.3.1), released so `@js-recon/js-recon` has a working stable `latest` after the org migration: `initRules` fetches from `js-recon/js-recon-rules` and matches the `js-recon-js-recon-rules-` release-archive prefix (previously `shriyanss`), which otherwise broke `js-recon run`'s rule download. Shipped from the `hotfix/1.3.2` branch and is intentionally not part of the `1.4.1-alpha` line on `dev`/`main`. (`analyze`)

## 1.3.1-beta.1 - 2026-06-08

### Added

### Changed

### Fixed

- `--max-heap` on `map` and `run` is now opt-in: without the flag, no process re-exec occurs and the existing `--max-old-space-size` from the npm start script is preserved. Previously, the default `0` caused every invocation to re-exec with `os.totalmem()` as the heap ceiling, which could trigger OOM kills on memory-constrained hosts and changed the default runtime for all users who never specified the flag. (`map`, `run`)
- XHR and HTTP-client taint resolvers (`vue_resolveXhr`, `vue_resolveHttpClient`) now sort the JS file list alphabetically before applying the 50 MB caller-lookup cap. Previously the cap was applied in `readdirSync` order, which is filesystem-dependent and made the included file set non-deterministic across runs — on large bundles this could silently exclude different API call sites depending on inode ordering. (`map`)

## 1.3.1 - 2026-06-16

### Added

- `--max-heap <mb>` flag on `map` and `run` — caps the V8 heap before any analysis work starts. Default `0` uses 100% of available RAM (`os.totalmem()`); a positive integer sets an explicit MB ceiling. Implemented via process re-exec so the limit is always honoured regardless of the value in `npm run start`. Addresses SIGSEGV (exit 139) on memory-constrained hosts and containers during the map step. (`map`, `run`)
- `--max-pages <pages>` flag on `lazyload` and `run` — caps the number of HTML pages the Next.js crawler visits across all recursive passes. Default `200` (matches the previously hardcoded limit from beta.2); set `0` to disable. Prevents OOM crashes during the lazyload step on event-heavy or listing sites where every visited page surfaces 10–20 more anchor links, causing the crawl queue to fan out to hundreds of pages and exhaust available RAM before the hard timeout fires. (`lazyload`, `run`)

### Fixed

- XHR and HTTP-client taint resolvers (`vue_resolveXhr`, `vue_resolveHttpClient`) now apply the same 1.5 MB per-file size guard when building the caller-lookup file set passed to `makeGetCallers`, plus a cumulative 50 MB total-size cap. Previously, on sites that downloaded hundreds of third-party library source files (e.g. a Vue app without `--strict-scope` that linked to compiler or polyfill source trees), `buildAliasMap` parsed all of them at once, exhausting the V8 heap before any XHR entry was resolved. The fix caps the caller set while leaving the per-file XHR/HTTP scanning loop unchanged. (`map`)

## 1.3.1-beta.2 - 2026-06-12

### Fixed

- All error and warning messages (chalk.red, chalk.bgRed, chalk.yellow `[!]`, chalk.magenta `[!]`, chalk.dim `[!]`) now write to `stderr` instead of `stdout` — affects 62 source files across every subcommand; fixes machine-readable pipelines and shell redirects that expected clean stdout
- Framework detection now falls back to checking Puppeteer-intercepted network request URLs when all HTML-attribute checks fail — catches Nuxt.js and Next.js sites that load their framework chunks dynamically (e.g. behind a Cloudflare challenge or SSO redirect) rather than referencing them in static HTML (`lazyload`)
- Map step no longer crashes with SIGSEGV (JavaScript heap out of memory) on ad-heavy or large-bundle targets — all file-parsing loops in the Vue/React/Svelte resolvers now skip files larger than 1.5 MB before calling Babel, preventing unbounded AST memory accumulation on sites that download 100+ third-party JS files (`map`)
- `run` now calls `process.exit(0)` after all pipeline steps complete — previously, abandoned Puppeteer navigations left by the lazyload hard timeout kept Node.js's event loop open indefinitely, causing the container to be SIGKILL'd (exit 137) even when analysis finished successfully (`run`)
- Next.js lazyload recursive page-crawl now stops visiting pages after 200 unique page visits per crawl instance — prevents runaway crawl explosion on sites that expose many locale or language variants in their navigation, where each locale page links to every other locale causing the crawl frontier to grow exponentially and exhaust the lazyload timeout (`lazyload`)
- Next.js fetch resolver now skips CSS stylesheet lazy-loader chunks (`markAssetError`, `fetchStyleSheet`) and Next.js internal data-fetcher chunks (`x-nextjs-data`) to avoid emitting false-positive API endpoints from framework internals (`map`)
- Next.js fetch resolver resolves `[param:X]` URL placeholders by tracing callers of the enclosing wrapper function — tries same-module callers first, then falls back to cross-chunk exported callers; reduces unresolved placeholder markers in output (`map`)
- Next.js fetch resolver guards `callHeaders` assignment against non-object values so a `null` or primitive returned by header resolution no longer causes a downstream crash (`map`)
- `resolveWebpackChunkImport` in `utils.ts` now calls `resolveVariableInChunk` on identifier nodes inside template-literal expressions and function-call arguments, cutting `[var X]` placeholder noise in resolved chunk URLs (`map`)

### Performance

- Next.js subsequent-requests passes (steps 3/8 and 4.5/8) no longer re-run webpack chunk URL builder analysis — `next_GetLazyResourcesWebpackJs` (a full Puppeteer session) is now skipped when `subsequentRequestsFlag` is true, saving 3-6 minutes per call since the chunk URL builders are static and were already resolved in the initial lazyload (`lazyload`)
- HTML inline-chunk scraping in `subsequentRequests` is now parallelised using the same thread-count semaphore as the RSC pass — previously sequential over all extracted paths, cutting the HTML phase from ~17 min to ~2 min for sites with 1000+ extracted paths (`lazyload`)

## 1.3.1-beta.1 - 2026-06-08

### Added

### Changed

### Fixed

- Bumped versions for dependencies
- Fixed container

## 1.3.1-alpha.4 - 2026-06-08

### Performance

- `makeGetCallers` now caches per-file content + Babel AST tuples for the lifetime of the resolver instance, so repeated caller searches at high recursion depth no longer re-read and re-parse every JS file on each call — depth-8 runs that previously took 200+ minutes on a large real-world target now complete in under a minute (`map`)
- `map -t svelte/vue/react`: `getViteConnections` now parses each JS file exactly once instead of twice (single-pass replaces the two-pass approach), cutting parse-time memory in half for large applications (`map`)
- `map -t svelte/vue/react`: replaced `JSON.stringify(chunks)` (which allocated a string equal in size to the entire output file) with a streaming `createWriteStream` write that serialises one chunk at a time, eliminating the peak in-memory JSON string (`map`)
- `map -t svelte/vue/react`: `vue_resolveFetch` no longer caches all parsed ASTs and file contents for "fetch"-containing files simultaneously; ASTs are now parsed on-demand and discarded after each file, with a bounded LRU cache of at most 20 ASTs kept alive for cross-file caller lookup (`map`)
- `map -t svelte/vue/react`: `FetchEntry.enclosingFn.node` (an AST node reference that pinned each file's full Babel AST through the entries array until the end of the second pass) is now nulled out — the field is not read in the second pass; `FetchEntry.fileContent` is similarly cleared to avoid retaining all processed file contents in memory (`map`)

### Added

- GraphQL operation extraction during `--openapi` generation — `map` now scans every downloaded JS file's string and template literals, feeds candidates through the official `graphql` library's `parse()`, and emits each parsed query/mutation/subscription as a POST request. Output is placed under a flat top-level `GraphQL` folder in the Postman collection and tagged `GraphQL` in the OpenAPI spec, with method `POST`, path `/{{graphqlEndpoint}}`, and a JSON body of shape `{"operationName": "...", "query": "...", "variables": {...}}`. The printed query inlines transitively-referenced fragment definitions so each emitted request is self-contained. Disabled with `--no-graphql` (alias `--ngql`) on both `map` and `run` (`map`, `run`)
- `collectionFolder` optional field on `OpenapiOutputItem` — when set, the OpenAPI generator uses it as the operation's `tags` value and the Postman generator places the item under a flat top-level folder with that name, bypassing the path-segment-derived hierarchy. Used by the new GraphQL resolver to group all operations under a single `GraphQL` folder regardless of transport URL (`map`)
- `--lazyload-timeout <minutes>` flag on both `lazyload` and `run` commands (default 30, 0 = disabled) — sets a hard ceiling on how long each lazyLoad step runs. When the timer fires the module logs a warning and the pipeline continues to the next step; in-flight Puppeteer pages and downloads may still complete in the background but their results are discarded (`lazyload`, `run`)
- Next.js lazyload now scans ALL downloaded JS files for webpack chunk URL builder functions (`__webpack_require__.u` pattern), not just `webpack-*.js` files — covers module federation entry points and other non-standard filenames. Scanning runs iteratively after the initial crawl until no new chunk URLs are discovered, with a CLI progress bar (`lazyload`)
- `--max-recursion-depth <n>` flag on `map` (default 3) — controls how far the HTTP-client URL fan-out and cross-file resolver recurse through caller chains. Higher values resolve more `[param:X]` markers at the cost of runtime; the per-entry deadline scales with depth so deeper recursion still terminates (`map`)
- `deepSubstituteBodyValue` body resolver — when a request body contains a `[param:X]` leaf whose call-site value is a structured object (e.g. a credentials/config object passed by an outer caller), the leaf is now replaced with the full nested object rather than left as a placeholder string. Used by both the HTTP-client and fetch resolvers (`map`)
- `makeGetCallersSameFile` fallback for body-param resolution — when the param-owning function has a short minifier-local binding name (≤ 2 chars), `resolveParamToAnyValue` now does a targeted same-file AST search to catch direct in-file callers that `makeGetCallers` skips to avoid cross-file false positives. Same-file short-name calls are unambiguous because the binding is in scope (`map`)
- Object-preference in `resolveParamToAnyValue` — prefers a caller whose argument resolves to a structured object/array over one that resolves to a bare string, since body params are typically objects and string-arg overloads are usually unrelated dispatch calls. Also skips resolved values where every leaf is still an unresolved placeholder marker (`map`)
- `OptionalMemberExpression` AST node handling in `deepResolveValue`, `resolveReturnInline`, and `resolveNodeValue` — optional chaining (`a?.b`) in URL/body expressions is now resolved the same way as regular member expressions instead of returning the opaque "unsupported node type" marker (`map`)
- HTTP-client method-call resolver for Vue/React/Svelte bundles — captures `<obj>.<verb>(<url>, [body], [config])` callsites (where `<verb>` ∈ {get,post,put,delete,patch,head,options}), runs same-function assignment recovery for late-bound locals, fans the URL out across every caller chain, and emits one OpenAPI entry per resolved caller. Designed for bundles whose transport layer overrides `XMLHttpRequest.prototype.{open,send,setRequestHeader}` (axios xhrAdapter and similar wrappers), where the literal URL is composed at the client-instance method call site rather than inside the adapter (`map`)
- `EnclosingFn.paramNames` + `parent` chain in the shared taint primitives — taint substitution can now resolve `[param:X]` for any parameter at any index in any enclosing function, including across anonymous Promise-chain callbacks where the immediate enclosing function doesn't declare X (`map`)
- Per-file alias map in `makeGetCallers` — recognizes `{ name: Binding }` re-exports and `{ name: () => Binding }` webpack getter exports so callsites that hit the binding through its public name (e.g. `ae.request(...)`, `r.default.postUnchecked(...)`) are correctly matched as callers of the local minified symbol. Aliases are scoped per file because minifier locals collide across modules (`map`)
- Member-expression callsite matching in `makeGetCallers` — `<anything>.<exportedName>(...)` is now recognised as a caller of the bound function, in addition to bare-identifier calls (`map`)
- XMLHttpRequest detection and resolution for Vue.JS, React, and Svelte/Astro bundles — resolves `.open()` method/URL, `.setRequestHeader()` header pairs, and `.send()` body from each XHR binding's call chain; results are registered in the OpenAPI output (`map`)
- Detect Next.js Server Actions registered via `createServerReference` and emit them as POST endpoints in the OpenAPI spec and Postman collection — includes `next-action` / `Accept` / `Content-Type` headers, route derived from App Router file path, and argument hints traced from the first call site (`map`)
- Argument hints in Server Action request bodies carry the inferred type alongside the variable name (e.g. `<string:userId>`) instead of an opaque placeholder (`map`)
- Location metadata for Server Actions: definition chunk + absolute file path + line and call-site chunk + absolute file path + line, surfaced as the `description` field in both the OpenAPI spec and Postman collection (`map`)
- `list server_actions` interactive command — prints all discovered Server Actions with route, body args, and source locations (`map -i`)
- Svelte/Astro framework support — `lazyload` now discovers island JS files via recursive HTML page crawl and ESM import following; `map` decodes Vite production chunks using the same logic as Vue; `analyze` and `run` pipeline added for Svelte/Astro apps (`lazyload`, `map`, `analyze`, `run`)
- `fingerprint` subcommand — batch framework detection against one or more target URLs; outputs detected framework and version to stdout in `text` (default), `json`, `jsonl`, or `csv` format; useful for triaging large target lists before running the full pipeline (`fingerprint`)
- React (Vite/Rolldown) framework detection via `<link rel="modulepreload">` elements and fast-path filename matching, in addition to inline `<script>` tags (`lazyload`)
- Recursive ESM import following for React bundles — static imports, dynamic `import()`, and Vite `__vite_mapDeps` arrays are parsed from each downloaded file so all referenced chunks are fetched transitively (`lazyload`)
- `map` and `analyze` pipeline support for React (Vite/Rolldown) applications, using the same fetch-resolver and analyze engine as Vue with vendor-chunk filtering (`map`, `analyze`, `run`)
- Content-entropy deduplication in `lazyload` — query-param variants of the same path are probed and only skipped when their extracted script sets are identical, so genuinely distinct parameterised routes are still crawled (`lazyload`)
- Ctrl-C interrupt menu in `run` — pressing Ctrl-C during a pipeline step shows an interactive prompt (skip current step / skip current target / exit) instead of immediately killing the process; in batch mode an extra "skip target" option is offered (`run`)
- `regexMatch` step type in the AST rule engine — matches string and template literals against a regex pattern, enabling rules that detect hardcoded credentials and other value-pattern findings (`analyze`)
- React tech added to all tech-gated type definitions and rule schemas (`analyze`)
- Model Context Protocol stdio server (`mcp --server`) — speaks the MCP protocol so js-recon can be wired into Claude Code, Cursor, and other MCP-aware hosts as a tool provider. Registers `lazyload`, `strings`, `map`, `endpoints`, `analyze`, `report`, `run`, `list_skills`, and `run_skill` as MCP tools. Subcommand stdout is captured and redirected to stderr so the chatty `console.log` output never corrupts the JSON-RPC frame; captured text is returned as the tool result (`mcp`)
- One-shot chat flag `-c/--chat <prompt>` on `mcp` (repeatable) — sends a single prompt to the AI agent non-interactively, prints the reply, and exits. Intent-detected `lazyload`/`run` jobs are awaited before the reply so the LLM sees the captured output (`mcp`)
- Claude Code OAuth credential reuse — when no API key is configured, `mcp --cli` and `mcp -c` fall back to the OAuth bearer token stored by the official Claude Code CLI (macOS keychain service `Claude Code-credentials`, or `~/.claude/.credentials.json` on Linux). The Anthropic SDK is constructed with `authToken` + `anthropic-beta: oauth-2025-04-20`. Tokens are auto-refreshed when expired (with a warning); refresh tokens are written back to the source credential store. OAuth tokens are never persisted to `~/.js-recon/mcp.yaml`. Disable refresh with `--no-refresh-claude-creds` (`mcp`)
- Background-job runner for `mcp --cli` — `lazyload` and `run` actions now spawn child processes (`node build/index.js <subcmd> ...`) and return immediately so the REPL stays responsive. The user can chat with the LLM while a job runs; tails of running jobs are auto-injected into the LLM context on every turn so the model can answer "how's it going?" naturally. New slash commands: `/jobs`, `/log <id>`, `/tail <id> [n]`, `/cancel <id>`. Ctrl-C cancels the most recent running job (SIGTERM → SIGKILL after 3s) before falling through to the exit warning (`mcp --cli`)
- Skills system — workflow prompts shipped under `~/.js-recon/skills/*.md` (delivered via a new `skills/` directory in the `js-recon-rules` release zipball, staged by `initRules`). Each skill carries YAML frontmatter (`name`, `description`, `params`, optional `pre_actions`). Invoke from the REPL with `/skill <name> [--param value …]`, via natural-language intent (e.g. `pentest <url>` routes to `web_app_pentest`), or from external MCP hosts via the `run_skill` MCP tool. `pre_actions` declare tool jobs (e.g. `run`) that are spawned before the rendered skill prompt is handed to the LLM. Ships with `graphql_pentest` and `web_app_pentest` (`mcp`, `analyze`)
- `--claude-client-id <id>` flag on `mcp` — OAuth client ID used when auto-refreshing Claude Code credentials; required in environments where the default Anthropic client ID is not registered (`mcp --cli`, `mcp -c`)

### Changed

- Fetch resolution log lines now include the resolved URL, method, headers, and body immediately after the `[+] Found fetch call in "file":line` line instead of being grouped at the end (`map`)
- Fetch resolution logs correctly label the framework ("React" or "Vue.JS") in the start and summary messages (`map`)
- `mcp --cli` launches in the user's current working directory and prints a `Working directory: <abs>` + `Artifacts are preserved across runs.` banner. Spawned job child processes inherit that cwd explicitly so artifacts always land next to the user's other working files (`mcp --cli`)
- Intent detector now requires word-boundary matches on `scan|run|check|test` so the substring `pentest` no longer accidentally routes to `run`; "pentest" + URL now routes to the `web_app_pentest` skill (or any `*_pentest` skill) when one is loaded (`mcp --cli`)
- Updated `@anthropic-ai/sdk` dependency to **0.102.0**

### Fixed

- `refactor -t react`: chunks whose AST already contains `export { X as default }` or `export default X` no longer receive a second trailing `export default` statement — the refactor pass now checks for an existing default export in the generated code before appending one (`refactor`)
- Fetch resolver second pass now handles `[param:X]` markers in request bodies — previously `MARKER_RE` matched only `[member:]` / `[urlsearchparams:]` and the resolver explicitly excluded `[param:]` markers, so a fetch wrapper whose body was an outer function parameter (`fetch(url, { body: JSON.stringify({ ..., body: E }) })`) was emitted with the literal placeholder string instead of the structured object the caller actually passed. The body JSON is now parsed and walked with `deepSubstituteBodyValue` so nested object/array call-site values replace the marker leaves (`map`)
- `[MemberExpression -> X]`, `[var X]`, and other unresolved placeholders in URLs are now substituted with their OpenAPI equivalents (`{X}`) before URL parsing in the OpenAPI spec generator, preventing spurious `Invalid URL` errors for placeholder-containing paths (`map`)
- Silenced the `Invalid URL` catch in the OpenAPI query-parameter extractor — URLs that remain unparseable after placeholder substitution (e.g. absolute URLs with placeholder hostnames) are skipped silently, since this is expected behaviour (`map`)
- Add error handling if webpack JS file is not valid
- `getRuleFilesRecursive` now skips hidden directories (e.g. `.github`) so GitHub Actions workflow YAML files are not loaded as rules (`analyze`)
- `run` now deletes stale map artifacts (`mapped.json`, `mapped-openapi.json`, `mapped-openapi.postman_collection.json`) before invoking `map`, preventing a leftover file from a previous run being reused when the output directory has been cleared without a full `cleanup` — which caused `resolveFetch` to look up file paths from the wrong target (`run`)
- `regexMatch` engine step now collects all matching string/template-literal nodes instead of stopping at the first hit; each matched node emits its own finding, so all hardcoded secrets in a single chunk are reported individually rather than only the first one (`analyze`)
- Taint propagation now follows callback parameters: when a tainted value is passed alongside an inline function argument in a call (e.g. Vue `watch(source, cb)`), the parameters of the inline function are marked tainted, fixing false-negatives where the callback param received a tainted value at runtime but was not tracked (`analyze`)
- CSPT rule no longer treats `route.params.*` and `useParams()` as taint sources — route segment params are validated against the router's path pattern and cannot carry arbitrary `../` traversal strings; only query params (`route.query`, `URLSearchParams`, `location.search/hash`) are high-confidence CSPT sources (`analyze`)
- Vue and React pipelines now also delete stale map artifacts before invoking `map`, applying the same fix as the Next.js pipeline; previously a stale `mapped.json` from a prior run would cause the analyze step to report findings against the wrong target's chunk IDs (`run`)
- `mcp --cli` "Thinking..." spinner no longer ticks forever after a provider error — the `setInterval` is now declared outside the `try` and cleared in `finally`, so 4xx/network failures render cleanly and the next prompt is not mangled (`mcp --cli`)
- Job/skill announcements (e.g. `[Job 1] run started ...`, `[Invoking skill: web_app_pentest]`) are now echoed to the REPL the moment `handleToolExecution` returns, in addition to being baked into the LLM context. Previously, if the subsequent LLM call failed (quota / auth), the user had no visible signal that a background scan had actually been spawned (`mcp --cli`)
- Ctrl-C in `mcp --cli` no longer crashes the readline with `SES_UNCAUGHT_EXCEPTION: readline was closed`. The SIGINT handler is wrapped in a try/catch and `prompt()` is guarded by a `promptingActive` flag so a re-entrant call against an already-pending `rl.question` is dropped instead of tearing the interface down (`mcp --cli`)
- `extractSourceMaps` no longer crashes with `EISDIR` when a source map entry has a degenerate path (e.g. a bare `webpack://` prefix with no trailing path) that `normalizePath` reduces to `"."` — such entries are now silently skipped (`lazyload`, `run`)
- Source map files extracted during `run` are now written to `output/<domain>/extracted/` (or the equivalent per-target subdirectory) instead of a bare `extracted/` directory in the current working directory (`lazyload`, `run`)

## 1.3.1-alpha.3 - 2026-05-20

### Added

- Add version for rule templates
- Add Vue js support for analyze module
- `esquery` interactive command + headless `-c/--command` runner for `map` and `run`, with `&&` chaining (`map`)
- Line-editor behavior in interactive mode: cursor movement (left/right/home/end/ctrl-a/ctrl-e), word-wise motion/delete (ctrl-w, ctrl-left/right), kill-to-start/end (ctrl-u/ctrl-k), delete-at-cursor, mid-string insertion so paste lands at the cursor, and horizontal scroll for long inputs (`map -i`)

### Changed

- Removed `mouse: true` from the interactive output pane so terminal-native text selection/copy works in the output area (`map -i`)
- Vue.js fetch resolver now walks back to the enclosing wrapper function's caller(s) so `URLSearchParams(param.subprop)` expands to real `?k1={k1}&k2={k2}` query strings and spread-header / member-value placeholders get substituted from the caller's object literal — including transitive resolution when the caller passes its own param through (`map`)
- Vue.js fetch resolver recognises destructured fetch wrappers (e.g. `const { wrapperKey: x } = factory({ ... })`) and resolves their callsites as fetch calls, with positional-first-arg filtering to avoid mis-identifying object-shaped wrappers that construct the URL from a property of their input (`map`)
- Distinct callsites for the same `(path, method)` are preserved in both the OpenAPI spec (path key gets a `#N` suffix) and the Postman collection (request name gets a `#N` suffix) instead of being collapsed to a single entry (`map`)

### Fixed

- Spread elements in request bodies and option objects are no longer silently dropped when the spread argument is unresolvable — the output surfaces a sentinel key (e.g. `"...arg": "<spread>"`, `"...call()": "<spread>"`) so downstream readers know more fields exist at runtime (`map`)

## 1.3.1-alpha.2 - 2026-05-18

### Added

- Added taint analysis in the `analyze` engine for Next.js
- Download JS files as soon as they are discovered (`lazyload`)
- Recursively resolve HTTP requests in Next.js (`map`)
- Stream JS file downloads during Vue.js discovery — downloads start as soon as each discovery step finds files instead of waiting for the full pipeline (`lazyload`)
- Resolve `UnaryExpression` nodes (`!x`, `void 0`, `-x`, `typeof x`) so request bodies surface real boolean/null values instead of `[unsupported node type: UnaryExpression]` (`map`)
- Resolve `ArrayExpression` nodes recursively so array body fields render their element shape instead of `[unsupported node type: ArrayExpression]` (`map`)
- Resolve `JSON.stringify(variable)` calls by tracing the argument, replacing the opaque `[call:JSON.stringify()]` placeholder (`map`)
- Resolve `new URLSearchParams({...})` to a real query string, using `{key}` placeholders for values that can't be statically resolved (`map`)
- Partial-concatenation fallback for binary `+` expressions so resolvable fragments are preserved when one side is unresolved (`map`)

### Changed

- Nested `JSON.stringify(expr)` inside a body object now resolves `expr` instead of emitting `[call to object...]` (`map`)

### Fixed

- Invalidate request cache if the memory is full
- Progress bars no longer hide the terminal cursor permanently when they exit without a clean `stop()` — all bars now use `hideCursor: false` (`lazyload`)
- Removed the concurrent download progress bar in the Vue.js section that was causing display corruption — discovery `console.log` calls no longer collide with the bar's render line (`lazyload`)
- API spec / Postman collection URLs no longer get `{{baseUrl}}` prepended to already-absolute URLs — full URLs are now reduced to their pathname (`map`)
- Spread elements that can't be resolved are now skipped instead of being emitted as fake `"...spread": "[spread:e]"` body fields (`map`)
- Request bodies that reduce to an empty `{}` after resolution are now omitted from the Postman collection (`map`)

## 1.3.1-alpha.1 - 2026.05.13

### Added

- Added MCP CLI support with model and provider configuration
- Vue.js support to get JS files from the page source
- Vue.js suppor to get JS files from runtime.js file
- Pass a URL list to `run -u`
- Turbopack support for Next.js `map`
- Added an `inScopeOf` option to AST `esquery` steps so a rule can scope a query to the subtree of a previous match — useful for requiring source and sink to live inside the same function rather than just the same chunk.
- Added a re-pass of the subsequent-requests crawl after the second strings extraction in `run` so dynamic-route paths (e.g. `/post/1`, `/profile/2`) that are only discovered after the first crawl + strings extraction get their chunks downloaded.
- Added interactive mode support `-i` for vue
- Use `puppeteer-extra` rather than `puppeteer`
- Added React Support
- Added Cloudfront firewall bypass

### Changed

- AST rules now fire when every declared step matches at least once in the chunk (counted as distinct completed steps), instead of requiring an exact total count of matches — multiple matches in a single step no longer prevent the rule from firing.

### Fixed

- Added try-catch for .map file bruteforce requests
- Subsequent-request chunk discovery regexes now accept the `~` character so Turbopack content-hashed filenames such as `static/chunks/18865ghy~7gi9.js` are picked up.

## 1.2.2 - 2026.04.04

### Added

- Implemented recursive crawling in Next.js modules to discover more JS files
- Added `--max-iterations` flag to limit recursive crawl iterations in `lazyload` module

### Changed

### Fixed

## 1.2.2-alpha.11 - 2026.03.01

### Added

- Added support for finding JS files through the single JS file on homepage for Vue.js
- Added support to get JS files from `../` paths in import statements for Vue.js

### Changed

### Fixed

- Add the single JS file to the list of files to download in Vue.js

## 1.2.2-alpha.10 - 2026.02.07

### Added

### Changed

### Fixed

- CI pipline failed to release package on NPM - fixed

## 1.2.2-alpha.9 - 2026.02.07

### Added

- Added `--research` and `--research-output` flag to lazyload module

### Changed

### Fixed

## 1.2.2-alpha.8 - 2026.01.27

### Added

- Add sourcemap reconstruction for Next.js

### Changed

### Fixed

- Add error handling for AST parsing in next_parseLayoutJs.ts
- Fixed scope issue in parseLayoutJs.ts

## 1.2.2-alpha.7 - 2026.01.24

### Added

- Added support for extracting JS files from client-side paths (HTML) in Next.js

### Changed

- Fixed recursive script tag parsing

### Fixed

## 1.2.2-alpha.6 - 2026.01.18

### Added

- Added support for parsing layout.js files in Next.js

### Changed

### Fixed

## 1.2.2-alpha.5 - 2025.01.18

### Added

- Add support to bruteforce request `.js.map` files
- Add support for Promise.all-based lazy loading in Next.js Turbopack builds

### Changed

- Add referer header to requests for improved stability

### Fixed

## 1.2.2-alpha.4 - 2025.12.05

### Added

- Added support for direct axios calls like `axios.Z.get()` for Next.js
- Added support for axios with URLs exported to chunks
- Added new method for Vue.js detection using `app.js` `Vue.component()` calls
- Added new method to find JS files through the single JS file on homepage for Vue.js
- Added new method to find JS files through import statements for Vue.js
- Added support for sourcemap reconstruction for Vue.js

### Changed

- Improved node value resolver with research about Axios library
- Improved node value resolver with research about fetch() usage

### Fixed

- Fixed CDN handling for Next.js applications with custom ports

## 1.2.2-alpha.3 - 2025.11.23

### Added

- Added support for `.Z.create()` axios pattern detection in Next.js

### Changed

### Fixed

- Fixed build ID extraction for Next.js applications when the subsequent requests directory is missing or inaccessible
- Fixed handling of exit when tech in one target can't be detected
- Fixed syntax error issue in Next.js build manifest parsing
- Fixed SECURITY issues by upgrading the packages

## 1.2.2-alpha.2 - 2025.10.28

### Added

- Added Angular support to lazyload module

### Changed

- Added root path (`/`) to endpoints list for Next.js subsequent requests

### Fixed

## 1.2.2-alpha.1 - 2025.10.09

### Added

- Added `--timeout` flag to run and lazyload modules
- Added `--no-sandbox` flag to disable browser sandbox
- Added `--build-id` flag to lazyload module to get the buildId from the Next.js app

### Changed

### Fixed

## 1.2.1 - 2025.09.23

### Added

### Changed

### Fixed

- Add try-catch block when checking version from GH for rules

## 1.2.1-beta.2 - 2025.08.10

### Added

- Added tabular view to the report

### Changed

- The run module will skip the target if it is invalid, rather than exiting the program

### Fixed

- Fix "Attempted to use detached Frame" error by adding try-catch block
- Fix "Cannot read properties of undefined (reading 'split')" error in openapi generator by adding try catch

## 1.2.1-beta.1 - 2025.08.07

### Added

### Changed

- Added `-k` as shorthand flag to the `run` module
- Added standard exit codes to the application

### Fixed

- Fix errors when the target is using a CDN
- Fix "possible EventEmitter memory leak detected" error
- Fix "Maximum call stack size exceeded" error in resolveNodeValue
- Fix "UND_ERR_HEADERS_OVERFLOW" error

## 1.2.1-alpha.2 - 2025.08.06

### Added

- Added support for parsing URL list in the run module

### Changed

### Fixed

## 1.2.1-alpha.1 - 2025.08.04

### Added

- Added `-k/--insecure` flag to disable SSL certificate verification
- Added `json` output feature to analyze module
- Added `analyze` module auto-run to `run` module
- Added `report` module

### Changed

- Updated the `postMessageFunctionResolve` step to resolve function expressions
- Updated the `postMessageFunctionResolve` step to resolve arrow function expressions
- Remove `--map-openapi` flag from run module (enabled by default)
- Remove `--map-openapi-output` flag from run module

### Fixed

## 1.1.4 - 2025.08.01

### Added

### Changed

- Replace `:` with `_` when creating host directories in `output/`
- Rename `esquery` engine to `ast` engine
- Allow any string type for `CheckAssignmentExistStep`

### Fixed

- Fix the issue in ast engine to handle direct assignments in `checkAssignmentExist`

## 1.1.4-alpha.4 - 2025.07.31

### Added

- Added HTTP method condition support in request analysis engine
- Added esquery engine for static code analysis with AST queries
- Added support for multiple technologies in esquery engine

### Changed

### Fixed

- Fix the issue when tech wasn't checked before running a rule
- Fix the issue with next.js lazy loading (support URLs starting with http, or CDN URLs)
- Fixed broken logic in next_GetLazyResourcesWebpackJs.ts when re-building JS URLs

## 1.1.4-alpha.3 - 2025.07.30

### Added

- Added `analyze` module
- Added analysis of OpenAPI spec file (requestEngine)
- Use the repo https://github.com/js-recon/js-recon-rules to remotely store and download rules

### Changed

### Fixed

## 1.1.4-alpha.2 - 2025.07.29

### Added

- Add description to chunks in mapped.json by default when using `map` module (an axios lib is detected) or when using the `endpoints` module (when a client-side path is detected)
- Add `list desc` command to show functions with non-empty descriptions in interactive mode
- Add `refactor` module
- Iterate through all the chunks, and write it to a separate file, and add export statements

### Changed

### Fixed

## 1.1.4-alpha.1 - 2025.07.28

### Added

- Get the exports of the chunks in next.js
- Added command to get the exports of a chunk in next.js - `list exportnames`
- Added `--mapped-json` flag to endpoints module

### Changed

- Type for `exports` is now `string[]` rather than `string` in `mapped.json`
- Remove `md` output format for endpoints module
- Removed `--subsequent-requests-dir` option from endpoints module (now use `-d` only)

### Fixed

## 1.1.3 - 2025.07.28

### Added

### Changed

### Fixed

## 1.1.3-beta.3 - 2025.07.26

### Added

- Added path and query parameter extraction to OpenAPI spec generation

### Changed

### Fixed

## 1.1.3-beta.2 - 2025.07.25

### Added

- Added flags for generating OpenAPI config

### Changed

- Prepend the baseUrl when printing the URL of axios.create() calls in next.js

### Fixed

## 1.1.3-beta.1 - 2025.07.24

### Added

- Added support for axios.create() detection in Next.js resolver

### Changed

### Fixed

- Fixed [issue 30](https://github.com/js-recon/js-recon/issues/30): `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`

## 1.1.3-alpha.2 - 2025.07.23

### Added

- Added request body extraction and display for axios calls
- Resolve `.concat()` operations when traversing code

### Changed

- Display full file path in fetch call log message
- Improve output in the openapi file

### Fixed

## 1.1.3-alpha.1 - 2025.07.22

### Added

- Added axios URL resolution in next.js (those using `.concat()`)
- Added openapi spec generation for map module

### Changed

### Fixed

## 1.1.2 - 2025.07.21

### Added

### Changed

### Fixed

## 1.1.2-alpha.4 - 2025.07.21

### Added

### Changed

### Fixed

- Fix CI pipeline for GitHub Container Registry publishing

## 1.1.2-alpha.3 - 2025.07.21

### Added

### Changed

- Remove `--no-sandbox` arg when launching browser (security)

### Fixed

- Disable chrome sandbox when running in docker to fix errors

## 1.1.2-alpha.2 - 2025.07.20

### Added

- Created docker image for js-recon

### Changed

### Fixed

## 1.1.2-alpha.1 - 2025.07.19

### Added

- Added axios client detection in next.js
- Added `list axios` command in interactive mode for next.js

### Changed

### Fixed

- Provide proper directory for JS files to the `map` module when the `run` module is used
- Added output directory conflict check when using `run` module

## 1.1.1 - 2025.07.18

### Added

### Changed

### Fixed

- Fixed the version number mismatch in `CHANGELOG.md` (stated 1.1.0) and `package.json` (stated 1.1.0-beta.5)

## 1.1.0/1.1.0-beta.5 - 2025.07.18

### Added

- Detect next in servers in which src includes '/\_next/' rather than just startsWith
- Detect webpack chunks in \_buildManifest.js

### Changed

### Fixed

## 1.1.0-beta.4 - 2025.07.09

### Added

- Added `set funcdesc <functionId> <description>` command to interactive mode

### Changed

- Pressing C-c in input box (interactive mode) will now also print the command like OS terminal
- Set the default value of `set writeimports` as `false`
- Do not store dupe and non-existent entries in `state.functionNavHistory` (interactive mode)

### Fixed

- Fix error of body has been read when running the tool for first time
- Print an error when the user passes a URL list (file) to the run command
- Add error recovery in Nuxt ast parse

## 1.1.0-beta.3 - 2025.07.08

### Added

- Added command `set writeimports` in interactive mode for next.js
- Detect ArrowFunctionExpression when getting webpack connections (Next.JS)

### Changed

### Fixed

- Implement proper error handling in `list nav` in interactive mode
- Implement error handling when going to non-existent function by `back` and `ahead` in interactive mode
- Add errorRecovery in all parser.parse to enable parsing the file even if invalid due to any reason
- Implement coderabbit suggestion: 'Truthiness check can skip fd 0'

## 1.1.0-beta.2 - 2025.07.07

### Added

### Changed

### Fixed

- Fix build errors (type errors)

## 1.1.0-beta.1 - 2025.07.07

### Added

- Svelte framework detection, and JS extraction
- JSON-based file cache
- Auto-approve executing JS code (`-y`/`--yes`)
- Added max threads for downloading JS files `-t`/`--threads`
- Add timeout handling and network idle check for page load in tech detection
- Parse script tags to extract additional JavaScript URLs from page
- Add secret scanning
- Add feasibility check to API gateway function
- Add endpoints module to support client-side path extraction
- Add subsequent-requests feature (`RSC: 1`) in Next.JS
- Add map module
    - Webpack chunk parsing
    - Interactive mode
    - `fetch()` detection
- Permutation in `strings` module
- OpenAI and Ollama integration for AI descriptions

### Changed

### Fixed

- Standardize UTF-8 encoding and improve URL path handling in lazy load module

## 1.0.0 - 2025.06.18

### Added

- Lazy Load Support for Next.js and Nuxt.js
- JavaScript String Extraction from downloaded JS files
- API Gateway Proxying to rotate IP addresses

### Changed

### Fixed
