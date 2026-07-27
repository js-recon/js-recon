import makeRequest from "../../utility/makeReq.js";
import chalk from "chalk";
import { runWithConcurrency } from "../../utility/concurrency.js";

/**
 * Extracts all JS file references from the content of a JS file:
 *  - Static ESM imports:  import ... from "./chunk.js"  /  import "./chunk.js"
 *  - Dynamic imports:     import("./chunk.js")
 *  - Vite __vite_mapDeps: the flat asset array in the initialiser
 */
const extractImports = (content: string, fileUrl: string, baseUrl: string): string[] => {
    const found: string[] = [];

    // Static imports: from "..." / from '...' / from `...`
    for (const m of content.matchAll(/\bfrom\s*["'`]([^"'`]+\.m?js)["'`]/g)) {
        try {
            found.push(new URL(m[1], fileUrl).href);
        } catch {
            /* skip */
        }
    }
    for (const m of content.matchAll(/\bimport\s*["'`]([^"'`]+\.m?js)["'`]/g)) {
        try {
            found.push(new URL(m[1], fileUrl).href);
        } catch {
            /* skip */
        }
    }

    // Dynamic imports: import("...") / import('...') / import(`...`)
    for (const m of content.matchAll(/\bimport\s*\(\s*["'`]([^"'`]+\.m?js)["'`]\s*\)/g)) {
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
    threads: number = 1
): Promise<string[]> => {
    const discovered: string[] = [];
    const toFetch = jsFiles.filter((jsFile) => !visited.has(jsFile));
    for (const jsFile of toFetch) visited.add(jsFile);

    await runWithConcurrency(toFetch, threads, async (jsFile) => {
        try {
            const req = await makeRequest(jsFile);
            if (!req || req.status !== 200) return;

            const contentLength = req.headers.get("content-length");
            if (contentLength && parseInt(contentLength) > maxJsSizeMb * 1024 * 1024) {
                console.error(chalk.yellow(`[!] Skipping ${jsFile} (too large)`));
                return;
            }

            const content = await req.text();
            if (content.length > maxJsSizeMb * 1024 * 1024) {
                console.error(chalk.yellow(`[!] Skipping ${jsFile} (too large)`));
                return;
            }

            discovered.push(...extractImports(content, jsFile, baseUrl));
        } catch (err) {
            console.error(chalk.yellow(`[!] Could not follow imports in ${jsFile}: ${err}`));
        }
    });

    // Return only URLs not yet in visited (deduplicated)
    return [...new Set(discovered)].filter((u) => !visited.has(u));
};

export default react_followImports;
