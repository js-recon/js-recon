# js-recon

Static analysis tool that maps API endpoints and detects client-side security issues by analyzing Next.js (webpack/turbopack) and Vue.js bundles. Written in TypeScript, compiled to `build/` before running.

## STRICT: Repository hygiene

**Research artifacts must never be committed to this repo.** This is a public tool repository. Its git history must contain only tool source code, tests, docs, and configuration. Never commit:

- Experiment scripts, research notes, or analysis results
- Files from `js-recon-research/` or any private workspace directory
- Prompt logs, observation markdown files, or scratch files

Research outputs belong in the private sibling workspace outside this repo. If an experiment script or results file is needed as reference, keep it in the private workspace only.

## Sub-agents (delegation & policy enforcement)

Many of the policies in this file (testing discipline, confidentiality, naming, DRY, directory
structure, docs sync) get skipped when a single session tries to hold them all in its head. To make
them stick, the project ships a roster of specialized **Codex sub-agents** in `.Codex/agents/`.
Delegate to them instead of doing the work inline — that is what makes the policy actually run.

**How delegation works:** Codex auto-delegates to a sub-agent when a task matches its
`description`. You can also invoke one explicitly ("use the `confidential-info-guard` agent"). Each
agent has a scoped tool set and a right-sized model/effort. Full reference (roster, models, triggers):
`js-recon-internal-docs/docs/dev-workflow/sub-agents.md`.

**MANDATORY enforcement — these are not optional:**

- **Before *any* `git commit`** in every repo *except* `js-recon-internal-docs`, run
  **`confidential-info-guard`** on the staged diff. Do not commit if it reports issues.
- **After any substantial code change**, run **`test-runner-advisor`** (it runs `npm test` and routes
  failures — code fixes come back to you; stale tests go to `test-writer`). This is in addition to the
  mandatory `run`-subcommand end-to-end test.
- **Before adding new functionality**, consult **`dry-advisor`** (reuse existing logic) and
  **`directory-structure-advisor`** (correct placement). When naming files/identifiers/flags, consult
  **`naming-scheme-advisor`**.
- **For QA before shipping**, use **`qa-e2e`** for the whole `run` pipeline, and the per-module QA
  agents (`qa-lazyload`, `qa-map`, `qa-analyze`, …) for the module you changed.
- **When a change affects user-visible behavior or docs**, use **`docs-writer`** to route and write the
  documentation (public vs internal vs AGENTS.md vs none).
- **For standards/behavior questions**, use **`rfc-research`** (IETF RFCs) and **`docs-research`**
  (framework/library docs, prefers the context7 MCP) rather than guessing.
- **For internal-docs issues**, use **`internal-docs-issue-author`** (detailed, with confidentiality
  note + image + plan) or **`internal-docs-issue-quick`** (a few bullet points → templated issue).
- **When a repetitive task recurs**, use **`agent-author`** to package it into a new sub-agent.

The QA and advisor agents are read-only (they report; they don't edit source). Enforcement is by
convention + these directives — there is no hard runtime gate, so honor them deliberately.

## Build & run

```bash
npm run cleanup   # rm -rf build/ + tsc (full rebuild)
npm run start -- <subcommand> [options]
```

`cleanup` must be run before testing any TypeScript change when using the `run` command.

## Subcommands

| Command       | Purpose                                                                            |
| ------------- | ---------------------------------------------------------------------------------- |
| `lazyload`    | Download JS chunks from a target URL                                               |
| `strings`     | Extract strings/paths/secrets from JS files                                        |
| `map`         | Parse webpack/turbopack bundles into a structured `mapped.json`                    |
| `endpoints`   | Extract client-side routes                                                         |
| `analyze`     | Run YAML rules against `mapped.json` / OpenAPI spec                                |
| `report`      | Generate HTML/SQLite report                                                        |
| `run`         | Run all of the above in sequence (primary interface)                               |
| `proxy`       | Configure/manage outbound proxying (AWS API Gateway IP rotation, SOCKS/HTTP, Oxylabs) |
| `mcp`         | AI-powered CLI / one-shot chat (`-c`) / Model Context Protocol server (`--server`) |
| `cs-mast`     | Compute CS-MAST structural hashes for downloaded JS files; find hash collisions    |
| `sourcemaps`  | Extract source files from `.map` sourcemap file(s)                                 |

## Key source files

- `src/index.ts` — CLI entry point; all subcommand definitions and option declarations live here
- `src/run/index.ts` — orchestrates the full pipeline (`run` subcommand); two tech-specific flows (Next.js 8-step, Vue 4-step)
- `src/analyze/index.ts` — loads/validates rules, runs AST and request engines
- `src/analyze/helpers/initRules.ts` — downloads/caches rules from GitHub to `~/.js-recon/rules`
- `src/analyze/helpers/validate.ts` — validates rules and checks `js_recon_version` compatibility
- `src/analyze/helpers/schemas.ts` — Zod schema for rule YAML files
- `src/map/graphql/resolveGraphql.ts` — framework-agnostic GraphQL operation scanner. Visits every `StringLiteral` and `TemplateLiteral` in every JS file, validates with the `graphql` library's `parse()`, and emits each operation as a POST request under a flat `GraphQL` collection folder. Inlines transitively-referenced fragment definitions into each printed query so emitted requests are self-contained. Runs in every framework branch of `map/index.ts` when `--openapi` is on and `--no-graphql`/`--ngql` is not set.
- `src/map/next_js/resolveFetch.ts` — resolves `fetch()` calls, detects Next.js framework chunks
- `src/map/next_js/resolveServerActions.ts` — detects `createServerReference(actionId, ...)` calls, derives App Router routes from chunk file paths, traces argument call sites (same-chunk and cross-chunk), and emits POST endpoints with `next-action` headers and typed arg hints (e.g. `<string:userId>`) into the global OpenAPI output
- `src/map/next_js/utils.ts` — `resolveNodeValue`, `resolveVariableInChunk`, `substituteVariablesInString`
- `src/map/vue_js/vue_resolveXhr.ts` — directory-scan resolver for `new XMLHttpRequest()` + `.open()/.setRequestHeader()/.send()` patterns. Shared by Vue/React/Svelte pipelines; the `frameworkName` arg only changes log labels. Reaches ground-truth XHR sites but in axios/Got/Ky-style bundles the URL/method come from a dispatcher config (`re.url`, `re.method`) and resolve only to opaque `[member:re.url]` placeholders that taint analysis cannot unwind across the library's internal dispatch chain — those entries fail the `looksLikeUrl` check at emit time. Catch the wrapper-level call instead via `vue_resolveHttpClient`.
- `src/map/vue_js/vue_resolveHttpClient.ts` — directory-scan resolver for `<obj>.<verb>(<url>, [body], [config])` calls where `<verb>` ∈ {get,post,put,delete,patch,head,options}. Designed for bundles whose transport layer overrides `XMLHttpRequest.prototype.{open,send,setRequestHeader}` (axios xhrAdapter and similar wrappers): the override layer is irrelevant to URL extraction because the literal URL is composed at the client-instance method call site, not inside the adapter. The `looksLikeUrl` heuristic (post-placeholder-strip, must contain `/` or scheme) filters out `Map.get` / `Headers.delete` / `EventBus.post` false positives while keeping partially-resolved URLs like `[call:base()]<literal>/[var X]`. Three resolution stages run on every captured callsite — each addresses a separate gap exposed when an RPC wrapper is hidden behind multiple layers of webpack-exported helpers:
    1. `resolveFromAssignments` — walks `binding.constantViolations` for `[unresolved: NAME]` markers, so identifiers declared as `let X;` and assigned later in the function body (e.g. `(X = a + "/" + b)` inside a sequence expression) resolve to their RHS. `resolveNodeValue`'s Identifier handler only looks at `binding.init`, which is empty for late-assigned locals.
    2. `expandParamPlaceholders` — fans out one captured callsite into one URL per caller chain. Walks the `enclosingFn.parent` chain to find which named function declares each `[param:X]`, then substitutes **every** placeholder owned by that same function from a single caller's args (keeps `[param:e]`/`[param:t]` consistent across one caller — never mixing args from different callsites). Recurses on the caller's `enclosingFn` so a forwarding wrapper (`Se(e,t,n) → ae.request(e,t,n,...)`) walks up to the wrapper's own callers.
    3. Taint substitution falls back to `substituteCallerPlaceholders` / `substituteCallerHeaders` for body/header placeholders that don't have multi-caller fan-out semantics.

    Wired into Vue / React / Svelte pipelines in `map/index.ts`.

- `src/map/vue_js/taint_utils.ts` — shared taint analysis primitives. Several pieces are non-obvious and exist to make `vue_resolveHttpClient` (and `vue_resolveXhr`) work on webpack output:
    - `EnclosingFn.paramNames` + `parent` chain: `resolveNodeValue` emits `[param:X]` for any param at any index in any enclosing function. The chain lets the helpers resolve such a marker against whichever enclosing scope actually declared X — bundled code routinely nests the resolution callsite inside an anonymous `.then(function ($) {…})` whose own params don't include X, while X is a param of an outer named function.
    - `buildAliasMap`: collects `{ exportedName: localBinding }` and `{ exportedName: () => localBinding }` patterns from object literals on a **per-file** basis. Webpack's `a.d(b, { name: () => Binding })` getter exports and re-export registries (`const ae = { request: Me }`) hide the local minifier name behind a meaningful key; without this map, `getCallers("Me")` would miss every `ae.request(...)` / `r.default.request(...)` callsite. **The map must be file-scoped** — minifier locals (`Se`, `Me`) collide across modules, and a global alias map blends unrelated functions into the same name set.
    - `makeGetCallers` accepts an optional `sourceFile` argument so callers can scope alias lookup to the file where the binding was declared. Direct minifier-local matches (`bindingName.length ≤ 2`) are dropped from the candidate list because they generate too many false positives across files; meaningful aliases (length > 2) are kept and used for both bare-identifier (`X(...)`) and member-expression (`<anything>.X(...)`) callsite matching. Overflow returns the partial caller list rather than nothing — the file-scoped alias map already suppresses noise, so partial coverage beats none.
- `src/map/next_js/getWebpackConnections.ts` — extracts chunk code from webpack bundles
- `src/map/next_js/interactive_helpers/esqueryGen.ts` — `esquery` interactive command: minifies a pasted snippet, matches it against each chunk's minified AST nodes, prints loose/strict selectors. Vue's command handler imports the same module — keep it framework-agnostic.
- `src/map/next_js/interactive.ts` / `src/map/vue_js/interactive.ts` — export both the blessed-backed `interactive()` entry and a headless `runCommands(chunks, mapFile, commands)` that pipes `outputBox.log` to stdout for `-c/--command` execution.
- `src/map/next_js/interactive_helpers/inputPatch.ts` — `enableCursorInput(inputBox)` patches a blessed textbox instance to support cursor movement, mid-string insertion, and paste-at-cursor. It overrides `_listener`/`setValue`/`_updateCursor`/`clearValue` on the instance. **Don't try to remove blessed's listener after the fact** — blessed re-binds `this._listener` on every focus, so overriding `_listener` on the instance is the only race-free approach. Shared by Next.js and Vue interactive entries.
- `src/globalConfig.ts` — current version string and tool-wide constants
- `src/utility/globals.ts` — mutable global state (tech detection result, AI config, OpenAPI flag, etc.)

## `run` pipeline in detail

`run` is the primary subcommand. It calls `processUrl` for each target, which dispatches to one of two pipelines based on the detected front-end framework (`globalsUtil.getTech()`).

### Next.js pipeline (8 steps)

1. **Lazyload** — downloads initial JS chunks via Puppeteer; detects framework; sets `globalsUtil.getTech()` to `"next"`
2. **Strings** — scans downloaded JS for strings, extracts URL paths → `extracted_urls.json`
3. **Lazyload (subsequent requests)** — re-crawls using the extracted paths to fetch dynamically loaded chunks; also fetches `buildId`
4. **Strings (pass 2)** — re-runs strings on the expanded chunk set; generates `extracted_urls.txt` (permuted) and `extracted_urls-openapi.json`; optionally scans secrets (`--secrets`); optionally runs TruffleHog (`--trufflehog`)
5. **Lazyload re-pass (step 4.5)** — a second subsequent-requests crawl to pick up chunks for dynamic routes discovered in pass 2
6. **Strings re-pass (step 4.6)** — strings pass over the re-pass chunks; also runs `--secrets` / `--trufflehog` if those flags are set
7. **Map** — parses webpack/turbopack bundles; resolves `fetch()` calls and axios usage; generates `mapped.json` and `mapped-openapi.json`; CDN-aware: if JS was served from a different host, `getCdnDir` finds the CDN output dir and passes that to map instead of `outputDir/host`
8. **Endpoints** — extracts client-side route paths; uses `___subsequent_requests` directory presence to decide whether to pass a JS directory
9. **Analyze** — loads YAML rules (from `-r/--rules` if provided, otherwise default rules cache); runs AST engine and request engine; writes `analyze.json`
10. **Report** — populates SQLite DB (`js-recon.db`) and generates HTML report

### Vue.js pipeline (4 steps)

1. **Lazyload** — same as Next.js step 1; sets `globalsUtil.getTech()` to `"vue"`
2. **Map** — scans the entire `outputDir` (Vue chunks spread across asset hosts)
3. **Analyze** — same rule loading as Next.js; `-r/--rules` is forwarded here too
4. **Report** — same as Next.js; if `endpoints.json` doesn't exist it is written as `[]` since Vue endpoints extraction isn't implemented yet

### Angular pipeline (4 steps)

1. **Lazyload** — downloads Angular CLI (esbuild) bundles: `main-HASH.js`, lazy route chunks (`chunk-HASH.js`); sets `globalsUtil.getTech()` to `"angular"`
2. **Map** — scans `output/<host>/` for all Angular JS chunks; resolves `HttpClient` calls (`n.get(url)`, `n.post(url, body)`) via the shared HTTP-client resolver and `fetch()` calls via the shared fetch resolver; generates `mapped.json` and `mapped-openapi.json`
3. **Analyze** — runs all rules whose `tech` array includes `"angular"` (or `"all"`); includes the Angular-specific `detect_angular_bypass_security_trust` rule that fires on `bypassSecurityTrust*` calls
4. **Report** — same as Vue; `endpoints.json` is written as `[]` if missing since Angular endpoints extraction is not yet implemented

### Tech detection flow

`lazyLoad` sets the global tech string. If it remains `""` after lazyload, `run` exits (single URL) or skips (batch). Techs other than `"next"`, `"vue"`, `"nuxt"`, `"react"`, `"svelte"`, and `"angular"` only get lazyload; the rest of the pipeline is skipped with a warning.

**SvelteKit `adapter-node` boot pattern**: SvelteKit's Node adapter does not emit `<link rel="modulepreload">` or `<script src="...">` for its entry chunks. Instead it uses an inline `<script>` block: `Promise.all([import("./_app/immutable/entry/start.js"), ...])`. `svelte_getFromPageSource` handles this by scanning inline script bodies for `import("...")` arguments (added in v1.4.1-alpha.3). Without those seed URLs the entire downstream pipeline (string analysis, ESM import following, page crawl) produces nothing.

**SvelteKit `adapter-static` (SSG/SPA) boot pattern**: The static builds produce a shell HTML file (`404.html` for SSG, `index.html` for SPA) that contains both `<link rel="modulepreload">` tags for all initial chunks AND the same inline `import()` boot script as adapter-node. `svelte_getFromPageSource` picks up 17+ JS URLs from the modulepreload links plus 2 from the inline script, giving a much larger seed set than the adapter-node case.

**`__vite_mapDeps` path formats**: SvelteKit emits `m.f = ["../nodes/0.js", "../chunks/x.js", ...]` (explicit file-relative paths) inside entry chunks at `_app/immutable/entry/`. Vue and React can emit either `m.f = ["/assets/chunk.js", ...]` (absolute root-relative) or `m.f = ["assets/chunk.js", ...]` (bare root-relative, no leading `/`). `react_followImports` differentiates by checking for a `./` or `../` prefix: only explicitly relative paths resolve against the chunk's own URL (`fileUrl`); all others (absolute `/` or bare names) resolve against the origin (`baseUrl`). Bare names like `assets/x.js` must NOT be resolved against `fileUrl` — when the chunk is inside `assets/`, that would produce a double-directory path. See `src/lazyload/react/AGENTS.md` for details.

### Batch mode

When `-u` points to a file of URLs, each line is processed sequentially. For each URL:

- A subdirectory `output/<host>/` is created
- `clearJsUrls()` / `clearJsonUrls()` reset the URL sets so previous targets don't bleed over
- All output paths are prefixed with `workingDir/`

## Adding a new flag to `run`

1. Declare the option in `src/index.ts` on the `run` command (`.option(...)`)
2. If it configures a global, call the setter in the `action` handler before `await run(cmd)`
3. If it needs to reach a downstream module (like `analyze`), thread it through `cmd` — `processUrl` receives the full `cmd` object and passes it to submodule calls

**Example — `-r/--rules` flag (added in this codebase):**

- Declared in `src/index.ts`: `.option("-r, --rules <file/dir>", "Rules file or directory (passed to analyze module)")`
- In `src/run/index.ts` the `analyze` calls use `cmd.rules || ""` — empty string tells `analyze` to use the default rules cache

**Example — `--lazyload-timeout` flag:**

- Declared in `src/index.ts` on both the `lazyload` and `run` commands: `.option("--lazyload-timeout <minutes>", ..., "30")`
- Threaded directly into each `lazyLoad()` call as `Number(cmd.lazyloadTimeout) * 60 * 1000` (converts minutes → ms). Unlike flags that set a global, this one is passed as a parameter — no setter in the action handler.

**Example — `--max-pages` flag:**

- Declared in `src/index.ts` on both the `lazyload` and `run` commands: `.option("--max-pages <pages>", ..., "200")`
- Threaded through `lazyLoad()` as `maxPageVisits` and forwarded to `NextJsCrawler` constructor. Default `200` matches the hardcoded cap previously in the crawler; pass `0` to disable. Prevents OOM on event-heavy Next.js sites where the recursive page queue fans out to hundreds of pages.

**Example — `--include-methods` / `--exclude-methods` / `--list-methods` flags:**

- Declared in `src/index.ts` on **both** the `lazyload` and `run` commands as `.option()` (not `requiredOption` — `--list-methods` must exit before the URL is required).
- `--list-methods` is handled early in **both** action handlers before any network work: prints method names and calls `process.exit(0)`.
- The method lists are parsed and validated in each action handler; stored on `cmd._includeMethods` / `cmd._excludeMethods` for the `run` action, which then threads them into `processUrl()` and from there into all three `lazyLoad()` calls as the last two positional parameters.

## Interactive-mode commands

The `map -i` blessed UI dispatches user input through `interactive_helpers/commandHandler.ts`. The same handler runs headlessly when commands are supplied via `-c/--command`:

- The `-c` option's commander coerce function splits each value on `&&` (with optional whitespace) and concatenates into a single command array. So `-c "list fetch && esquery * fetch"` is two commands; passing `-c` twice has the same effect.
- `map`'s entry point checks `commands.length > 0` first — if non-empty, it calls `nextRunCommands` / `vueRunCommands` and skips the blessed UI even when `-i` is also set.
- New commands should be added to **both** `next_js/interactive_helpers/commandHandler.ts` and `vue_js/interactive_helpers/commandHandler.ts`, plus the corresponding `helpMenu.ts` entry. When the implementation is framework-agnostic (e.g. `esquery`), put it under `next_js/interactive_helpers/` and import it from the Vue handler — don't duplicate.
- `list server_actions` is intentionally Next.js-only (it reads from `getOpenapiOutput()` filtered by `next-action` header) and has no Vue counterpart.

## Reversing RPC-style API calls from manual browser observations

When the user supplies a call-stack screenshot or notes from a real session ("XHR sent here, sink is this prototype override, body comes from this function"), the goal isn't to reproduce that exact target — it's to find the _generic pattern_ that the bundler emitted and add resolver support for it. The reverse-engineering workflow that produced the HTTP-client resolver:

1. **Read the call stack bottom-up.** The deepest frame is almost always the transport (`XMLHttpRequest.send`, `fetch`); ignore it. The next frames going up are the HTTP library (axios's `_request` / `dispatchXhrRequest`); ignore those too unless the URL is literal at that level. Look for the first frame whose source line contains _a recognisable path fragment or template string_ — that's the wrapper callsite worth resolving.
2. **Identify the URL composition site.** Open the file at that frame in the downloaded bundle (`output/<host>/static/js/<chunk>.js`) and find the literal. Typical webpack patterns are `client.post(base + "literal/path/" + paramVar, body, config)` or `client.request({ url: base + "/" + paramVar, method: "POST" })`. Note what's a literal, what's a parameter, what's a local variable.
3. **Walk inward from the wrapper.** For every non-literal in the URL, find where it came from in the same function. If it's a `let X;` followed by `X = a + "/" + b` in a sequence expression, that's `resolveFromAssignments`' territory. If it's a function parameter, that's taint analysis' territory.
4. **Walk outward from the wrapper.** Look at the callers of the enclosing function. In webpack bundles the function is usually exported through one of:
    - A registry object: `const ae = { request: Me, postUnchecked: Se }` — callsites read `ae.request(...)`, NOT `Me(...)`.
    - A webpack getter export: `a.d(b, { request: () => Me })` — same effect, different shape.
    - Both. The same binding often appears in multiple aliases.

    Both shapes are recognised by `buildAliasMap` in `taint_utils.ts` and _must be matched per file_ — minifier locals like `Se`, `Me` collide across modules.

5. **Trace forwarding wrappers all the way out.** A wrapper like `Se(e, t, n) → ae.request(e, t, n, ...)` just forwards its parameters. After substituting at the wrapper level, recurse into Se's own callers; the externally-meaningful arguments (`s.signIn.namespace`) are several layers up.
6. **Confirm the literal source.** The outermost caller passes a `MemberExpression` like `s.signIn.namespace`. Find the `const s = { signIn: { namespace: "...", method: "..." } }` declaration — `resolveNodeValue` handles this naturally as long as the binding is in scope at the caller's location.

If at any layer the new resolver returns `[unresolved: X]` or `[param:X]`, that's a signal which primitive is missing — extend `taint_utils.ts` (chain walk, per-file aliases, member-expression matching, late-assignment recovery) rather than special-casing the wrapper. The goal is a primitive that resolves _similar_ RPC-style libraries in unrelated apps, not the one bundle in front of you.

**Do not encode target-specific paths or service names in code or comments.** When iterating, run `map` against the downloaded chunks and grep the resulting `mapped-openapi.json` for the expected URL fragment — never paste that fragment into source.

### How to test changes here

The HTTP-client resolver runs inside the `map` step of the React/Vue/Svelte pipeline; verify it as part of the full `run` pipeline (see "Testing a change" below). Quick iteration loop while debugging:

```bash
npx tsc
node --max-old-space-size=8192 build/index.js map \
    -d output/<host>/static/js -o /tmp/jsr-mapped -t react -f json \
    2>&1 | grep "URL: " | sort -u
```

This bypasses the slow `lazyload` step by reusing already-downloaded chunks. The final acceptance test is still `npm run cleanup && npm run start -- run -u <target> -y -k`; grep `mapped-openapi.json` for the expected resolved URL fragment.

## Rules

Rules are YAML files (`.yml`/`.yaml`) in two places:

- **Workspace:** `../js-recon-rules/` (relative to this repo)
- **Installed cache:** `~/.js-recon/rules`

`initRules` downloads rules from GitHub when missing or when the cached version doesn't match the latest release. `js_recon_version` (required) must be declared in every rule (e.g. `js_recon_version: ">=X.Y.Z"`); `initRules` uses it to validate compatibility and skips incompatible rules with a warning. The version check strips prerelease suffixes (e.g. `1.3.1-alpha.3` → `[1,3,1]`).

Rule categories:

- `ast/` — AST-based pattern matching against chunk code (uses `@babel/parser` + `esquery`)
- `request/` — OpenAPI/request-level checks against the resolved endpoint list
- `cs-mast-s/` — CS-MAST-S structural signature matching; each step embeds a PHC string and fires if that node-level hash is found anywhere in the chunk AST. Suitable for regression detection after a vulnerability is confirmed via AST rules. See `src/analyze/engine/csMastSEngine.ts` and `src/analyze/AGENTS.md` for details.

When `-r` points to a single file, only that rule is loaded. When it points to a directory, all `.yml`/`.yaml` files are loaded recursively.

## Testing a change

**Testing is mandatory for every change.** Before reporting a task complete:

1. Run `npm test` to execute the unit test suite (Vitest).
2. Run `npm run cleanup` to rebuild TypeScript.
3. Run the `run` subcommand against the target the user provides. Do not use `analyze` or other individual subcommands as a substitute — the `run` subcommand must be used to validate end-to-end behavior.
4. If the user has not provided a target, ask for one before proceeding.

### Rules smoke test (CI)

The `rules-smoke-test` GitHub Actions workflow (`.github/workflows/rules-smoke-test.yaml`) runs on every non-main push. It:

1. Checks out `js-recon/js-recon-labs` and `js-recon/js-recon-rules` alongside js-recon.
2. Builds js-recon and the `next_js/vuln-all-rules` lab app.
3. Starts the lab app on port 3001.
4. Runs `node build/index.js run -u http://localhost:3001 -r ./js-recon-rules --no-sandbox -y -k`.
5. Runs `node scripts/smoke-test.js` which reads `output/localhost:3001/analyze.json` and asserts that all 22 expected rule IDs are present.

**`scripts/smoke-test.js`** maintains the `EXPECTED_RULES` list. When a new rule is added to js-recon-rules:

- The `next_js/vuln-all-rules` app in js-recon-labs must be updated to seed the new vulnerability.
- The new rule ID must be appended to `EXPECTED_RULES` in `scripts/smoke-test.js`.

The lab app seeds:

- 19 AST rules for the `next` tech stack
- 3 request rules (`api_path`, `admin_api`, `missing_authorization_header`)
- The Angular-only rule (`detect_angular_bypass_security_trust`) is intentionally excluded.

### Unit tests

Unit tests live in `src/__tests__/` and cover pure-logic components. Test framework is **Vitest** (ESM-native, TypeScript-native — no compilation step needed).

```bash
npm test          # run all unit tests once
npm run test:watch  # watch mode
npm run test:build  # legacy build smoke test (node build/index.js -h)
```

Test files follow the pattern `src/__tests__/<component>/<name>.test.ts`.

Covered components:

| File                                                                                     | Tests in                                               |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `utility/urlUtils.ts` — `getURLDirectory`                                                | `src/__tests__/utility/urlUtils.test.ts`               |
| `utility/replaceUrlPlaceholders.ts` — `replacePlaceholders`                              | `src/__tests__/utility/replaceUrlPlaceholders.test.ts` |
| `utility/resolvePath.ts` — `resolvePath`                                                 | `src/__tests__/utility/resolvePath.test.ts`            |
| `strings/index.ts` — `extractStrings`                                                    | `src/__tests__/strings/extractStrings.test.ts`         |
| `analyze/helpers/validate.ts` — `parseVersion`, `compareVersions`, `isVersionCompatible` | `src/__tests__/analyze/versionCompat.test.ts`          |
| `map/next_js/utils.ts` — `memberChainToString`                                           | `src/__tests__/map/memberChainToString.test.ts`        |
| `fingerprint/index.ts` — `deriveOutputPath`                                              | `src/__tests__/fingerprint/deriveOutputPath.test.ts`   |

When adding new pure-logic helpers, add a corresponding test file. Components that require Puppeteer, network I/O, or the full pipeline are still validated through the `run` subcommand.

### Writing unit tests

**What to test.** Test pure functions: anything that takes plain inputs and returns a value without I/O. The standard pattern for I/O-bound modules is to extract the parse/transform step into an exported pure function and test that. Leave the orchestrator (Puppeteer, `makeRequest`, file writes) untested at the unit level.

**Extracting testable functions.** When a function mixes I/O with logic, split it:

```typescript
// Exported pure function — testable
export const parseThings = (content: string, baseUrl: string): string[] => { ... };

// Orchestrator — not unit-tested
const myModule = async (url: string): Promise<string[]> => {
    const resp = await makeRequest(url);
    const content = await resp.text();
    return parseThings(content, url);
};
```

**Test file structure.** Use `describe` + `it` blocks. Group by function name. Cover: happy path, edge cases (empty input, malformed input), and threshold boundaries (e.g. "fewer than N entries returns []").

```typescript
import { describe, it, expect } from "vitest";
import { myPureFunction } from "../../path/to/module.js"; // .js extension required

describe("myPureFunction", () => {
    it("extracts X from valid input", () => {
        const result = myPureFunction("...");
        expect(result).toContain("expected");
    });

    it("returns [] for empty input", () => {
        expect(myPureFunction("")).toEqual([]);
    });

    it("returns [] for invalid JS", () => {
        expect(myPureFunction("{{{{ not valid")).toEqual([]);
    });
});
```

**Imports always use `.js` extension** for local files (ESM project with `"module": "node16"`):

```typescript
import { fn } from "../../lazyLoad/next_js/myModule.js";
```

**Constructing Babel AST nodes for tests.** When a function under test requires real Babel AST nodes (with `scope`, `path`, correct `start`/`end` offsets), parse a code snippet in the test and capture the node via a traverse visitor — do not construct AST nodes by hand. Wrap the expression in a `const _x = <expr>;` declaration so `start`/`end` offsets are preserved for any `code.slice()` calls inside the function:

```typescript
import parser from "@babel/parser";
import _traverse from "@babel/traverse";
const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;

function parseExpr(code: string) {
    const src = `const _x = ${code};`;
    const ast = parser.parse(src, { sourceType: "unambiguous", plugins: ["jsx", "typescript"] });
    let node: any;
    traverse(ast, {
        VariableDeclarator(p) {
            node = p.node.init;
            p.stop();
        },
    });
    return { node, src };
}
```

**Avoiding GitHub secret scanning.** Strings that look like real secrets (Slack webhook URLs, Stripe keys, etc.) will be blocked by GitHub push protection even in test files. Construct them at runtime from parts arrays:

```typescript
// BAD — blocked by secret scanner
const url = "https://hooks.slack.com/services/TABCDEF/BABCDEF/xxxxxxxxxxxx";

// GOOD — assembled at runtime
const parts = ["https://hooks.slack.com/services/T", "ABCDEF/B", "ABCDEF/xxxx"];
const url = parts.join("");
```

Typical full test invocation:

```bash
npm run cleanup && npm run start -- run -u <target-url> -y -k
```

## Release process

Releasing a new version touches three repos. Work on `dev` (js-recon, js-recon-rules) and `stage` (js-recon-docs). Do **not** touch `js-recon-research` — it is private and excluded from releases.

**Ordering is critical**: release js-recon first (including the GitHub release so CI publishes it to npm), then snapshot and PR js-recon-docs. This ensures the docs `version_check` CI step passes instead of failing due to a missing npm package.

### Overview: automated stage → human approve → human-triggered promote

npm's OIDC trusted publishing for this package is scoped to **`npm stage publish`**, not direct `npm publish`. That means every js-recon release has three distinct phases, only the first of which Codex can execute unattended:

1. **Automated (Codex does this end-to-end):** bump version, update CHANGELOG, open and merge the `dev`→`main` PR (after CI is green and the user gives merge approval — never merge without it), create the GitHub release. That release triggers `publish-js-recon.yml`, which runs `version_check` → `audit` → `build` → `publish-npm` (stages to npm via OIDC, no token) → `merge_main_and_dev` — all fully automatic, no human input needed.
2. **Human-only (cannot be scripted or delegated):** npm requires interactive 2FA to promote a staged package to actually live on the registry. Codex reports the stage id and waits; the user runs `npm stage approve <stage-id>` (or clicks "Approve" on npmjs.com) themselves, on their own machine or browser.
3. **Human-triggered, then Codex drives it:** once the user confirms the package is live (e.g. "I've published on npm" / "go ahead"), Codex runs `gh workflow run promote-js-recon.yml -f version=<version>` and watches it to completion. This workflow (Homebrew tap, Docker, GHCR) installs from the published npm artifact rather than git source, so it can only run correctly after step 2 — that's why it's a separate manually-triggered workflow instead of chained onto `publish-js-recon.yml`.

The detailed step-by-step is below; the numbering restarts at 10 for the docs phase since it's a separate concern from the npm/GitHub release phase.

### When a user asks to prepare a release

Before writing any files, gather the current state:

1. Check `package.json` and `src/globalConfig.ts` for the current version — both must match. If they don't, fix them first.
2. Find the latest git tag: `git describe --tags --abbrev=0`
3. List unreleased commits: `git log <latest-tag>..HEAD --oneline | grep -E "^[a-f0-9]+ (feat|fix)"`
4. Check if `CHANGELOG.md` already has an `(unreleased)` entry for the current version — if so, only the date needs to be added.
5. Check `js-recon-rules` for unreleased commits since its last tag: `git -C ../js-recon-rules log $(git -C ../js-recon-rules describe --tags --abbrev=0)..HEAD --oneline`
6. Check `js-recon-docs` for commits since the last version snapshot: `git -C ../js-recon-docs log --oneline -20`

### Phase 1 — js-recon (release first)

1. **Bump version** (if not already at the target version) — update `version` in `src/globalConfig.ts` and `package.json`. Both must match.

2. **Update CHANGELOG** — if the version heading already exists as `(unreleased)`, replace it with the real date (`## <version> - <YYYY-MM-DD>`). Otherwise add the full section with `### Fixed`, `### Performance`, `### Added`, `### Changed` sub-sections. If the release fixes a reported vulnerability (a security-triaged GitHub issue, a self-reported CVE/GHSA, etc.), give it its own `### Security` sub-section instead of folding it into `### Fixed` — call out the fix explicitly rather than burying it under generic bug fixes; this is what OpenSSF Best Practices' "release notes call out fixed vulnerabilities" criterion checks for. Verify every `feat`/`fix` commit since the previous tag is covered:

    ```bash
    git log <prev-tag>..HEAD --oneline | grep -E "^[a-f0-9]+ (feat|fix)"
    ```

3. **Update README** — ensure the Commands table in `README.md` lists every subcommand declared in `src/index.ts`. The `refactor` and `load` subcommands are easy to miss — explicitly verify they are present.

4. **Update rules** (`js-recon-rules` repo, `dev` branch) — if there are substantive unreleased commits (not just merge/cleanup commits), update `CHANGELOG.md` and `version.txt`, push to `dev`, and open a PR (`js-recon/js-recon-rules` dev→main, title=rules version, body=rules changelog section).

5. **Push** `js-recon` dev branch: `git push origin dev`

6. **Open PR** using `gh pr create`:

    | Repo                | Source | Target | Title                                       | Body                                 |
    | ------------------- | ------ | ------ | ------------------------------------------- | ------------------------------------ |
    | `js-recon/js-recon` | `dev`  | `main` | bare version string (e.g. `v1.3.1-alpha.4`) | raw `## <version>` changelog section |

7. **Monitor js-recon CI** — use `gh pr checks <pr-number> --repo js-recon/js-recon` and poll until all checks complete. Handle CodeRabbit suggestions (see below). Do NOT merge — wait for user approval.

8. **Create GitHub release** — after the PR is merged to main:

    ```bash
    gh release create v<version> \
      --repo js-recon/js-recon \
      --title "v<version>" \
      --notes "<changelog section>" \
      --prerelease    # set for any version containing "alpha" or "beta"
    ```

    `--latest` flag rules:
    - **Omit** `--latest` if the version contains `alpha` or `beta`
    - **Add** `--latest` only for stable releases (no pre-release suffix in the version string)

    Previous tag is left to GitHub's automatic detection (do not set `--target` or `--tag` beyond the tag name itself).

9. **Wait for npm stage publish** — monitor the release pipeline: `gh run list --repo js-recon/js-recon --workflow "Publish JS Recon"`. `publish-npm` uses OIDC trusted publishing (`npm stage publish`, no token) to _stage_ the release — this is NOT the same as it being live.

10. **Approve the staged release** — npm's staged-publish approval always requires interactive 2FA, so this step can never be automated or scripted:
    - Find the stage id: `npm stage list @js-recon/js-recon` (or the "Staged Packages" tab on npmjs.com)
    - Approve it: `npm stage approve <stage-id>` (prompts for 2FA), or click "Approve" on npmjs.com
    - Confirm it's live: `npm view @js-recon/js-recon@<version>`

11. **Manually trigger the promote workflow** — once the release is live, run `promote-js-recon.yml` to update Homebrew and publish the Docker/GHCR images:

    ```bash
    gh workflow run promote-js-recon.yml --repo js-recon/js-recon -f version=<version>
    ```

    This workflow installs js-recon from the published npm registry artifact (`npm pack`/`npm install <pkg>@<version>`) rather than building from git source — an additional supply-chain check that the shipped images/formula match exactly what was approved on npm. Monitor: `gh run list --repo js-recon/js-recon --workflow "Promote JS Recon Release"`.

### Homebrew tap (manual, part of `promote-js-recon.yml`)

The `update-homebrew-tap` job (now in `promote-js-recon.yml`, triggered per step 11 above) is **channel-aware** — it updates a different formula depending on the promoted version string, so `brew install js-recon` always tracks the real npm `latest` (stable) release instead of whatever was most recently promoted:

1. Picks the target formula from `inputs.version`: `Formula/js-recon-alpha.rb` if the version contains `alpha`, `Formula/js-recon-beta.rb` if it contains `beta`, otherwise `Formula/js-recon.rb` (stable).
2. `npm pack @js-recon/js-recon@<version>` — downloads the exact published tarball from the registry and computes its SHA256 locally (no dependency on a public tarball URL being reachable yet)
3. Checks out `js-recon/homebrew-tap` using `HOMEBREW_TAP_GH_PAT` (a fine-grained PAT stored in the `homebrew-publish` environment secrets, scoped to `homebrew-tap` repo `Contents: Read and write` only — automatically masked in all log output, never echoed)
4. Updates `url` and `sha256` in the target formula via anchored `sed` — the formula has no explicit `version` field; Homebrew derives it from the `url`
5. Commits `chore: update <formula> to <version>` and pushes

The `js-recon-alpha` / `js-recon-beta` formulas are `keg_only` with a custom reason string (they install the same `js-recon` binary name as the stable formula, so they can't auto-link into the shared `bin/` without conflicting). Homebrew's built-in `:versioned_formula` reason only applies to numeric `@X.Y`-style names, which is why these use plain `-alpha`/`-beta` filenames rather than the `@`-suffix convention.

Monitor: `gh run list --repo js-recon/homebrew-tap --workflow ci.yml`

**If the job fails:** manually update: `npm pack @js-recon/js-recon@<version> && sha256sum js-recon-js-recon-<version>.tgz`, edit the correct formula (stable vs `-alpha`/`-beta`, per the version string), commit, and push to `js-recon/homebrew-tap`.

**One-time setup** (must be done before the first release, already completed):

- `js-recon/homebrew-tap` is a public GitHub repo with formulas at `Formula/js-recon.rb` (stable), `Formula/js-recon-alpha.rb`, and `Formula/js-recon-beta.rb`
- `HOMEBREW_TAP_GH_PAT` is a fine-grained PAT stored in `js-recon/js-recon` → Settings → Environments → `homebrew-publish` → Environment secrets, scoped exclusively to the `homebrew-tap` repo

**Known migration gotcha (`shriyanss/tap` → `js-recon/tap`):** `js-recon/homebrew-tap` was created by **renaming** the original `shriyanss/homebrew-tap` repo, not by creating a fresh one. GitHub transparently redirects git operations on the old `shriyanss/homebrew-tap` URL to the same repo, so anyone who still has `shriyanss/tap` tapped locally ends up with two tap names serving an identically-named `js-recon` formula. This trips Homebrew's cross-tap ambiguity/trust guard (`Formulae found in multiple taps` on a bare `brew install js-recon`, or `Refusing to load formula ... from untrusted tap ...`). Since it's the same underlying repo, there's no way to make the old tap name behave differently — the only fix is instructing affected users to run `brew untap shriyanss/tap` before installing from `js-recon/tap` (documented in `README.md` and `js-recon-docs/docs/docs/installation.md`).

### Docker / GHCR images (manual, part of `promote-js-recon.yml`)

`publish-docker` and `publish-ghcr` (now in `promote-js-recon.yml`) build from `Dockerfile.release` instead of the default `Dockerfile`. `Dockerfile.release` runs `npm install -g @js-recon/js-recon@<version>` against the live registry rather than copying local source and building — the published images are provably built from the approved npm artifact. The default `Dockerfile` (source build) is unchanged and still used for local/dev builds.

### Phase 2 — js-recon-docs (after npm is live)

10. **Fix doc gaps** — cross-check `docs/docs/modules/*.md` against `src/index.ts` and the new CHANGELOG entries. Add or update any missing flags, options, or command descriptions.

11. **Snapshot** — run inside `js-recon-docs/`:

    ```bash
    npx docusaurus docs:version <version>
    ```

    This creates `versioned_docs/version-<version>/`, updates `versions.json`, and creates `versioned_sidebars/version-<version>-sidebars.json`.

12. **Keep `lastVersion` stable** — `lastVersion` in `docusaurus.config.ts` stays pointing to the last stable release. Do **not** update it for alpha or beta versions.

13. **Push** `js-recon-docs` stage branch and open PR:

    ```bash
    git -C ../js-recon-docs add .
    git -C ../js-recon-docs commit -m "docs: snapshot v<version>"
    git -C ../js-recon-docs push origin stage
    gh pr create --repo js-recon/js-recon-docs \
      --head stage --base main \
      --title "v<version>" \
      --body "<brief summary of doc changes>"
    ```

14. **Monitor docs CI** — `version_check` should pass now that the npm package is live. CodeRabbit rate-limit comments are non-blocking.

### Post-release branching model

Once a release's GitHub release is created, `main` and `dev` become identical after the `merge_main_and_dev` job in `publish-js-recon.yml` finishes — confirm that job completed successfully (`gh run list --repo js-recon/js-recon --workflow "Publish JS Recon"`) before cutting `post-<stable_version>` off either branch.

- While a version is running through its alpha/beta channels at scale (i.e. before the matching stable release ships), `dev` is reserved for **fixes to that version only** — bugs found while the beta is being validated. Do not land new features on `dev` during this window.
- New feature development for the _next_ version happens on a `post-<stable_version>` branch (e.g. `post-1.4.1`), cut from `dev`/`main` right after the current version's first release. This branch is where unrelated feature work accumulates while `dev` stays focused on stabilizing the in-flight release.
- When the current version is promoted to stable (green flag from the user to go from `<version>-beta.*` to `<version>`), release it the normal way, then merge `post-<stable_version>` into `dev` via a PR — same as any other merge, this requires CI green and explicit user approval before merging (see "Stop before merge" below). The `post-<stable_version>` branch itself is **retained** (not deleted) until the user manually removes it — it is a historical record of what shipped in the next release.
- Bump the tool's version on the new `post-<stable_version>` branch immediately after cutting it, so `dev` commits during the stabilization window keep targeting the version actually being stabilized.

This policy is also documented in `js-recon-internal-docs` under the Maintenance section — see that for the full rationale.

**Docs follow the same split.** `js-recon-docs` has a branch per active js-recon branch, matching by name: `dev` → `stage`, `post-<stable_version>` → `post-<stable_version>` (created off `stage` the first time a `post-<stable_version>` branch is cut). Document a change **only** on the docs branch matching the js-recon branch it actually landed on — do not let a `post-<stable_version>`-only feature (or a `dev`-only fix) bleed into the other docs branch, since the two js-recon branches can diverge with genuinely different, non-overlapping feature sets rather than one being a superset of the other. When merging `post-<stable_version>` into `dev`, merge the matching docs branch into `stage` in the same session. See `docs-writer` for the per-change routing rule.

### Handling CodeRabbit

After any PR is created, poll for review comments:

```bash
gh api repos/js-recon/js-recon/pulls/<pr>/comments
```

For each suggestion: apply a fix commit to `dev` for correctness bugs or convention violations. Skip trivial style preferences. The PR updates automatically.

### Stop before merge

Do NOT merge any PR. Once all CI checks pass and CodeRabbit suggestions are addressed, present a summary to the user: what changed in each repo, PR links, CI status, CodeRabbit disposition. Wait for explicit merge approval.

## Resolving a GitHub issue

When a user asks to fix or implement a GitHub issue, follow these steps:

1. **Read the issue** — `gh issue view <number> --repo js-recon/js-recon`

2. **Implement** — make the code, docs, and exit-code changes required. Follow all existing conventions (subcommand structure, CHANGELOG format, README Commands table, js-recon-docs modules page, exit_codes.md). Document new exit codes in both `AGENTS.md` and `js-recon-docs/docs/docs/exit_codes.md`.

3. **Test** — run `npm run cleanup` and exercise the new/changed functionality manually (see "Testing a change" section). Verify error paths and exit codes.

4. **Commit and push to `dev`** — before committing, run the **`confidential-info-guard`** agent on the staged diff and resolve any issues it reports. Then use a `feat(...)` or `fix(...)` commit message. Push to `origin dev`.

5. **Monitor CI** — `gh run list --repo js-recon/js-recon --branch dev --limit 3`. Watch the `Build & Prettify Code` run. If the `version_check` job fails because `CHANGELOG.md` top version doesn't match `package.json`, bump `package.json` and `src/globalConfig.ts` to match (with a `chore: bump version to <X>` commit) and repush.

6. **Pull prettifier commit** — after CI passes, `git pull origin dev` to pick up the `chore: prettify code` auto-commit.

7. **Close the issue** — once all CI checks pass:

    ```bash
    gh issue close <number> --repo js-recon/js-recon --comment \
      "Implemented in commit <short-sha> on the \`dev\` branch. Will be released in **v<version>**."
    ```

    Use the short commit hash of the feature commit (not the prettifier chore). The target release version comes from the unreleased CHANGELOG entry.

## cs-mast

`cs-mast` computes CS-MAST-S (Context-Stratified Merkelized Abstract Syntax Tree) signatures for every `.js` file found recursively under an output directory, then optionally finds and reports structural collisions — files sharing the same root signature.

**Source:** `src/cs_mast/index.ts`

**Fixed hashing config:**

```typescript
{ hash: 'sha256', lang: 'js', prsr: '@babel/parser',
  scat: ['lit', 'decl', 'loop', 'cond'], sinc: [],
  sourceType: 'unambiguous' }
```

`rootSignature` on the `File` root node is empty (the File type isn't in any scat category), so `buildSignatureFromConfig(CS_MAST_CONFIG, tree.rootHash)` is used to construct the full PHC string from the root hash.

**Options:**

- `-o / --output <dir>` — directory to scan (default: `output`)
- `--ct / --collision-table` — find and print collision table to stdout
- `--min-collisions <n>` — minimum occurrences to report (default: 2)
- `--co / --collision-output <file>` — write collision data to a file (independent of `--ct`)
- `--cf / --collision-format json|csv` — output format (default: csv)
- `--scat <categories>` — comma-separated scat categories to use (default: `lit,decl,loop,cond`). Overrides the fixed config for this run.
- `--sinc <nodes>` — comma-separated exact node types to include via sinc (e.g. `IfStatement`).
- `--all-scat-permutations` — run all 511 non-empty scat subsets and write one collision file per subset to `--perm-output`.
- `--perm-output <dir>` — output directory for per-permutation files (required with `--all-scat-permutations`).
- `--perm-concurrency <n>` — parallel permutation workers (default: half of CPU count).

**`--co` path resolution:** if the given path is a directory or has no extension, the file is written as `collisions.<fmt>` in the current working directory.

**Output fields:** `signature` (full CS-MAST-S PHC string), `count`, `files`.

**Testing:**

```bash
npm run build
node build/index.js cs-mast -o output --ct --min-collisions 2
node build/index.js cs-mast -o output --co output --cf csv   # writes ./collisions.csv
node build/index.js cs-mast -o output --all-scat-permutations --perm-output ./perm-out --cf json
```

## refactor

The `refactor` command supports the following techs:

- **`react-webpack`** — webpack 5 React bundles. Splits a numeric module map into per-module ES files, rewrites require→import, recovers JSX. See `src/refactor/react/AGENTS.md`.
- **`react-vite`** — Vite (rolldown) React bundles. Removes CJS interop wrappers, rewrites vendor imports to canonical library imports (`react`, `react/jsx-runtime`, etc.), recovers JSX. Runs a Vite build check after writing output. See `src/refactor/react-vite/AGENTS.md`.
- **`next`** — Next.js bundles (legacy).
- **`next-turbopack`** — Next.js Turbopack chunks. Handles both turbopack 3-param `func_NNN=(runtime,module,exports)=>{}` and 1-param `func_NNN=(runtime)=>{}` formats plus webpack-style coexisting chunks. See `src/refactor/next/AGENTS.md`.
- **`next-webpack`** — Next.js webpack chunks. Input format from `mapped.json`: `NNN:(module,exports,require)=>{}` (arrow form) or `function webpack_NNN(module,exports,require){}` (named-function form — the dominant form on real-world bundles; see `src/refactor/next/AGENTS.md`). Recovers named exports (ODP, require.d), default exports (module.exports=V), re-exports (module.exports=require(N)→export\*), and require hoisting. Param order: params[0]=module, params[1]=exports, params[2]=require. Recovery-rate benchmark: see `docs/js-recon-core/bug-reports/nextjs-webpack-refactor-function-wrapper-miss.md` in js-recon-internal-docs for the corrected baseline (the previous "277/280 modules recovered" figure only exercised the arrow-form wrapper and was not representative of real-world bundles).
- **`vue-webpack`** — Vue.js webpack 4/5 chunks. Container format: `(window.webpackJsonp||[]).push([[chunkIds],{moduleId:function(t,e,r){...}}])`. Each chunk file may contain multiple module functions; each is extracted and transformed. Reuses the Next.js webpack transform (same module param semantics: params[0]=module, params[1]=exports, params[2]=require). See `src/refactor/vue/index.ts`.
- **`vue-vite`** — Vue 3 + Vite page chunks. The main index chunk (contains `__vccOpts`, all of Vue runtime) is analysed to build an export-alias→canonical-name map. Lazy page chunks then have their index imports rewritten to canonical `import {...} from 'vue'` statements. The `_export_sfc` compiler helper is inlined as a local const. See `src/refactor/vue/vite.ts` and `src/refactor/vue/vendor-analyze-vue.ts`.

### Known react-vite bugs (discovered 2026-07-01, test against js-recon-research/react/20-cve-app)

**Multi-chunk file overwrite** — `map` segments each Vite chunk into multiple sub-chunks (one per top-level function). The refactor write path processes sub-chunks sequentially, each overwriting the previous output file. Only the last sub-chunk survives. For chunks with inlined library code followed by the component function (e.g. `ApiProxy`, `Editor`, `Search`), this means the component is the survivor (last in the map order), which is the correct and useful result — but any app-specific helper functions in the same chunk are also lost.

**Rename race** — When JSX is detected in a sub-chunk, the write path renames the output file `.js` → `.jsx`. When the same file is written by multiple sub-chunks, the rename is attempted on each JSX-containing chunk; all attempts after the first throw `ENOENT` because the `.js` file was already renamed. The `.jsx` file is correct; the unhandled rejection is noise. Fix: track which output files have already been renamed.

**Remote signatures** — The `react/vite/large` HuggingFace bucket is currently empty. The tool falls back gracefully with a warning but remote library stripping is disabled. Symptom: `[!] No remote collisions files found for scat "lit-decl-loop-cond" in branch "react/vite/large"`. Fix: populate the bucket by running CS-MAST-S generation against a corpus of large Vite apps.

### refactor `--collisions <file>` (react-webpack only)

`refactor -t react-webpack` accepts a `--collisions <file>` argument that points at a `collisions.json` produced by `cs-mast --all-scat-permutations` over a cross-app baseline. Modules whose body signature is in the baseline set are classified as library code (React / React-DOM / jsx-runtime / scheduler / …) and dropped from the output, leaving only `index.js`.

Plumbing: `src/index.ts` (CLI) → `src/refactor/index.ts` (resolves the path via `resolveCollisionsPath()` — accepts either a file or a baseline-tree directory like `../js-recon-cs-mast-s/`; builds `Set<string>` of signatures with `count >= max count`) → `src/refactor/react/index.ts` (`moduleIsLibrary()` hashes each module body with `cs_mast_init({ scat: ["lit","decl","loop","cond"] })` and matches against the set). Detailed rationale + build history in `src/refactor/react/AGENTS.md`.

The baseline files live in the sibling `js-recon-cs-mast-s/` repo (`baselines/<tech>/<scat>/collisions.json`). See its `README.md` for layout and provenance.

### refactor `--detect-version` (react-webpack, react-vite)

`refactor -t react-webpack` and `refactor -t react-vite` accept a `--detect-version` flag that uses CS-MAST signatures to detect the React version used in the bundle.

**Related flags:**

- `--detect-version-config <config>` — `"dynamic"` (default) or comma-separated scat categories (e.g. `lit,decl,loop,cond`).
- `--detect-version-dynamic-threshold <n>` — number of scat configs to use in dynamic mode (default: 3).
- `--detect-version-dynamic-conf-purge` — clears the cached dynamic scat config and recomputes.

**How it works:**

1. **Scat config resolution** (`resolveVersionDetectionScatDirs()` in `src/refactor/index.ts`):
    - `dynamic` mode: reads cached scat configs from `~/.js-recon/refactor/config.json`. If absent (or purged), calls `selectDynamicScatConfigs()` which lists scat dirs from the HF bucket for a reference version, then validates that each scat dir has non-empty `reliable_signatures.json` for ALL versions. Saves the result to `config.json`.
    - Static mode: parses the user's comma-separated categories, converts to a bucket dir name via `scatToDir()`, validates against all versions, and exits with code 26 if any version's file is empty.
2. `generateBundleSignatures()` in `src/refactor/remote/version-detect.ts` runs `cs_mast_init` on every chunk + optional extra code snippets for each selected scat config. This produces a separate signature set per scat.
3. For each available React version, `fetchReliableSignatures()` downloads (or loads from cache) the `reliable_signatures.json` per scat config. Match counts are **summed across all scat configs** per version.
4. The version with the highest total match count is returned as the detected version.
5. The detected version's npm semver is used to pin `react` and `react-dom` in the refactored output's `package.json`.

**Caches:**

- Signature cache: `~/.js-recon/refactor/version_sigs_cache/<bundler>/<version>/<scatDir>/reliable_signatures.json` + `.cached_at` (7-day TTL).
- Dynamic config cache: `~/.js-recon/refactor/config.json` (`dynamicVersionDetectionScatConfig` field).

**Dataset coverage:** webpack (react-0.12 through react-19), vite (react-16 through react-19).

**Important:** the version detection data in the HF bucket was generated with `@shriyanss/cs-mast` v0.1.8. The tool requires cs-mast 0.1.8 or later to produce matching signatures. Using an older cs-mast version will result in zero matches.

**Important:** the version detection data in the HF bucket was generated with `@shriyanss/cs-mast` v0.1.8. The tool requires cs-mast 0.1.8 or later to produce matching signatures. Using an older cs-mast version will result in zero matches.

## Security / confidentiality

When a change is informed by behavior observed on a real target (URLs, endpoint names, response shapes, finding details, etc.):

- **Do not include any target information in code comments, commit messages, docstrings, variable names, or any other artifact.**
- This applies to hostnames, paths, parameter names, response content, or any other detail that could identify the target.
- If context from the target is needed to describe a change, describe it in abstract terms only (e.g. "URL parameter passed to fetch" not "https://example.com/api/docs passes `file` param to fetch").

## Codex documentation storage & sync

Every `AGENTS.md` file in `js-recon` (including this one) is a **symlink** into this repo, [`js-recon/js-recon-agentic-files`](https://github.com/js-recon/js-recon-agentic-files) (private), checked out as a sibling at `../js-recon-agentic-files` relative to `js-recon` (or wherever `JSR_AGENTIC_FILES_PATH` points). **The same mechanism now covers `.Codex/skills/` and `.Codex/agents/`** (the sub-agent roster above) — all three (`AGENTS.md`, `.Codex/skills/*`, `.Codex/agents/*`) are stored here, gitignored in `js-recon`, and symlinked in by `.Codex-sync/sync.sh`. This repo has one branch per `js-recon` branch, same name, holding exactly the tree relevant to that branch — this is why the set of files can differ between branches (e.g. a stabilization branch won't have a newer feature's `AGENTS.md` yet). Full design rationale, including bugs found during the real rollout, is documented in `js-recon-internal-docs` under Maintenance → "AGENTS.md externalization + branch-synced sync mechanism" (work item #70), and the agent roster under Dev Workflow → "Sub-agents" (work item internal#80).

**This is transparent for reading and editing.** Open/edit any `AGENTS.md` in `js-recon`'s working tree as a normal file — the symlink resolves automatically, and you're actually editing the file here in `js-recon-agentic-files`. Commit and push changes in **this** repo, not in `js-recon` — `js-recon`'s `.gitignore` refuses to let `AGENTS.md` paths be staged there at all.

**Automatic sync mechanism** (see `js-recon/.Codex-sync/` for implementation):

- `git checkout <branch>` in `js-recon` (including via an editor's Source Control view) triggers `.Codex-sync/hooks/post-checkout`, which re-syncs the symlink set for the new branch — adding files that exist there, removing ones that don't.
- Creating a **new** `AGENTS.md`, `.Codex/skills/*`, or `.Codex/agents/*` file anywhere in `js-recon`'s working tree is picked up within a few seconds by a background watcher (`.Codex-sync/watch.sh`, wired into `.vscode/tasks.json` with `runOn: folderOpen`) or the next branch switch: its content is moved into this repo on the current `js-recon` branch, committed and pushed here, and the original in `js-recon` is replaced with a symlink. The cleaner path for authoring agents/skills is to create the file directly here in `js-recon-agentic-files/.Codex/agents/` (or `.Codex/skills/`) and run `js-recon/.Codex-sync/sync.sh` to symlink it in — no capture round-trip.
- If you don't see a `AGENTS.md` update after switching branches or creating a file in `js-recon`, run `js-recon/.Codex-sync/sync.sh` (or `.Codex-sync/capture-scan.sh` for new files) manually. If `sync.sh` reports this repo isn't found, the sibling clone is missing or misconfigured — see this repo's `README.md` for one-time setup.
- A `js-recon` branch with no counterpart here yet (e.g. a feature branch just cut from `dev`) falls back to this repo's `dev` content with a warning, until the first new-file capture creates a matching branch here.
- The capture scan explicitly excludes `node_modules/` and `build/` in `js-recon`'s working tree — found the hard way when the first real branch switch captured a third-party npm dependency's own `AGENTS.md` into this repo. If a new vendor/build directory ever needs excluding, add it to both `sync.sh` and `capture-scan.sh` in `js-recon`, on every active branch (tooling changes here don't propagate across `js-recon` branches automatically — each one needs the fix applied and pushed individually).

**Do not** try to `git add -f` a `AGENTS.md` file in `js-recon` to force-track it there — it will be silently re-externalized back to this repo by the sync tooling. Do not remove `js-recon`'s `.Codex-sync/` directory or its `.gitignore` entries; they are what keeps `js-recon`'s history free of AGENTS.md content going forward.
