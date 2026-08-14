import makeRequest from "../../utility/makeReq.js";
import chalk from "chalk";
import { runWithConcurrency } from "../../utility/concurrency.js";
import { progressWarn } from "../../utility/progressLog.js";

/**
 * Extracts all JS file references from the content of a JS file:
 *  - Static ESM imports:  import ... from "./chunk.js"  /  import "./chunk.js"
 *  - Dynamic imports:     import("./chunk.js")
 *  - Vite __vite_mapDeps: the flat asset array in the initialiser
 *
 * The extension alternation and optional trailing `?...` query string exist for `react-dev`
 * (js-recon-internal-docs#191): a production build's import specifiers are always bare `.js`/
 * `.mjs` with no query string, but Vite's dev server serves unbundled ESM-over-HTTP where
 * component imports keep their real `.jsx`/`.tsx`/`.ts` source extension (`import App from
 * "/src/App.jsx"`) and vendor deps carry a cache-busting `?v=<hash>` suffix (`"/node_modules/
 * .vite/deps/react.js?v=0f5f446c"`) — both silently unmatched by the original `\.m?js["'`]`
 * pattern, which requires the extension to be immediately followed by the closing quote.
 *
 * `.svelte` was added for `svelte-dev` (js-recon-internal-docs#192): SvelteKit's dev-mode
 * per-route node files re-export the compiled component directly from its source path
 * (`export { default as component } from "/src/routes/+page.svelte"`). Vite serves a
 * requested `.svelte` file as fully-compiled JS, so once this extension is followed the
 * component's own `.vite/deps`/`@sveltejs/kit` runtime sub-imports resolve via the existing
 * alternatives above — without it, the entire `.svelte` source subtree (and everything only
 * reachable through it) is invisible to the crawler.
 */
const extractImports = (content: string, fileUrl: string, baseUrl: string): string[] => {
    const found: string[] = [];
    const EXT_WITH_OPTIONAL_QUERY = /\.(?:mjs|jsx?|tsx?|svelte)(?:\?[^"'`]*)?/.source;

    // Static imports: from "..." / from '...' / from `...`
    for (const m of content.matchAll(new RegExp(`\\bfrom\\s*["'\`]([^"'\`]+${EXT_WITH_OPTIONAL_QUERY})["'\`]`, "g"))) {
        try {
            found.push(new URL(m[1], fileUrl).href);
        } catch {
            /* skip */
        }
    }
    for (const m of content.matchAll(
        new RegExp(`\\bimport\\s*["'\`]([^"'\`]+${EXT_WITH_OPTIONAL_QUERY})["'\`]`, "g")
    )) {
        try {
            found.push(new URL(m[1], fileUrl).href);
        } catch {
            /* skip */
        }
    }

    // Dynamic imports: import("...") / import('...') / import(`...`)
    for (const m of content.matchAll(
        new RegExp(`\\bimport\\s*\\(\\s*["'\`]([^"'\`]+${EXT_WITH_OPTIONAL_QUERY})["'\`]\\s*\\)`, "g")
    )) {
        try {
            found.push(new URL(m[1], fileUrl).href);
        } catch {
            /* skip */
        }
    }

    // Vite __vite_mapDeps initialiser: m.f=["assets/chunk1.js","assets/chunk2.js",...]
    // SvelteKit uses relative paths ("../nodes/0.js") while Vue/React use root-relative
    // ("/assets/chunk.js"). Resolve with fileUrl as base so both work correctly.
    const mapDepsMatch = content.match(/m\.f\s*=\s*(\[[^\]]+\])/);
    if (mapDepsMatch) {
        try {
            const arr: string[] = JSON.parse(mapDepsMatch[1]);
            for (const p of arr) {
                try {
                    // Explicit relative paths (starting with ./ or ../) → resolve against
                    // the file that contains the mapDeps table, so "../nodes/0.js" in
                    // _app/immutable/entry/app.js correctly becomes
                    // _app/immutable/nodes/0.js rather than /nodes/0.js.
                    // Everything else (absolute /assets/x.js or bare assets/x.js) →
                    // resolve against the origin root, because Vite emits mapDeps paths
                    // relative to the site root, not relative to the chunk's own directory.
                    const isFileRelative = p.startsWith("./") || p.startsWith("../");
                    const resolved = isFileRelative ? new URL(p, fileUrl).href : new URL(p, baseUrl).href;
                    found.push(resolved);
                } catch {
                    /* skip */
                }
            }
        } catch {
            /* malformed JSON — ignore */
        }
    }

    return found;
};

/**
 * Fetches each JS file in `jsFiles` (skipping already-visited ones), extracts every
 * import reference, and returns the set of newly-discovered URLs.
 *
 * `visited` is mutated in place: callers should pass the same Set across iterations
 * so the recursion terminates once no new files are found.
 */
const react_followImports = async (
    jsFiles: string[],
    maxJsSizeMb: number,
    baseUrl: string,
    visited: Set<string>,
    threads: number = 1,
    compactOutput: boolean = false
): Promise<string[]> => {
    const discovered: string[] = [];
    const toFetch = jsFiles.filter((jsFile) => !visited.has(jsFile));
    let warningCount = 0;
    const reportWarning = compactOutput
        ? () => {
              warningCount++;
          }
        : (message: string) => console.error(message);
    for (const jsFile of toFetch) visited.add(jsFile);

    await runWithConcurrency(toFetch, threads, async (jsFile) => {
        try {
            const req = await makeRequest(jsFile, compactOutput ? { reportErrors: false } : undefined);
            if (!req || req.status !== 200) return;

            const contentLength = req.headers.get("content-length");
            if (contentLength && parseInt(contentLength) > maxJsSizeMb * 1024 * 1024) {
                reportWarning(chalk.yellow(`[!] Skipping ${jsFile} (too large)`));
                return;
            }

            const content = await req.text();
            if (content.length > maxJsSizeMb * 1024 * 1024) {
                reportWarning(chalk.yellow(`[!] Skipping ${jsFile} (too large)`));
                return;
            }

            discovered.push(...extractImports(content, jsFile, baseUrl));
        } catch (err) {
            reportWarning(chalk.yellow(`[!] Could not follow imports in ${jsFile}: ${err}`));
        }
    });

    if (compactOutput && warningCount > 0) {
        progressWarn(chalk.yellow(`[!] Skipped ${warningCount} JS file(s) while following imports`));
    }

    // Return only URLs not yet in visited (deduplicated)
    return [...new Set(discovered)].filter((u) => !visited.has(u));
};

export default react_followImports;
