import chalk from "chalk";
import makeRequest from "../../utility/makeReq.js";
import { getJsUrls, pushToJsUrls } from "../globals.js";
import resolvePath from "../../utility/resolvePath.js";
import { FoundJsFiles } from "../../utility/interfaces.js";
import { runWithConcurrency } from "../../utility/concurrency.js";
import { decodeInlineSourceMapDataUri, writeInlineSourceMap } from "../sourcemap.js";

// for parsing
import parser from "@babel/parser";
import _traverse from "@babel/traverse";
const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;

const analyzedFiles = [];
let filesFound = [];
let mapFilesFound = [];

// Vite's dev server serves the unbundled module graph directly — imports reference not only
// ".js" but ".mjs", raw ".ts"/".vue" source (transpiled on the fly), each with a cache-busting
// query string appended (e.g. "./composables/state.js?v=7f19ff7d").
const JS_LIKE_EXTENSION_RE = /\.(m?js|tsx?|vue)$/i;

// A real file path is never this long. Webpack's `eval`/`eval-source-map` devtool (the default
// under Nuxt 2's webpack dev server) embeds a module's entire transpiled source as one giant
// StringLiteral argument to eval(), terminated by a `//# sourceURL=.../foo.js`-style comment —
// so the whole multi-KB blob ends up matching JS_LIKE_EXTENSION_RE and getting treated as a
// candidate path. Bounding length here keeps it out of foundJsFiles before it can reach
// resolvePath (which throws on it) or a log line.
const MAX_PLAUSIBLE_PATH_LENGTH = 500;

/**
 * Parses the content of a JavaScript file and returns an object containing
 * all the strings that reference a JS-like file (".js", ".mjs", ".ts(x)", ".vue").
 *
 * @param {string} content - The content of the JavaScript file to parse.
 * @returns {Promise<FoundJsFiles>} - A promise that resolves to an object containing
 * all the strings that reference a JS-like file.
 */
export const parseJSFileContent = async (content) => {
    try {
        const ast = parser.parse(content, {
            sourceType: "module",
            plugins: ["jsx", "typescript"],
            errorRecovery: true,
        });

        const foundJsFiles = {};

        traverse(ast, {
            StringLiteral(path) {
                const value = path.node.value;
                if (value.length > MAX_PLAUSIBLE_PATH_LENGTH) return;
                // Strip any query string/fragment before testing the extension, or a
                // cache-busted import specifier is silently missed.
                if (JS_LIKE_EXTENSION_RE.test(value.split(/[?#]/)[0])) {
                    foundJsFiles[value] = value;
                }
            },
        });

        return foundJsFiles;
    } catch (error) {
        return {};
    }
};

/**
 * Analyzes strings in the files found and returns an array of absolute URLs pointing to JavaScript files found in the page.
 * @param {string} url - The URL of the webpage to fetch and parse.
 * @returns {Promise<{jsFiles: string[], mapFiles: string[]}>} - JS files found via string analysis,
 * and any real (non-inline) sourcemap URLs found alongside them.
 */
const nuxt_stringAnalysisJSFiles = async (url, threads: number = 1, output: string = "") => {
    console.log(chalk.cyan("[i] Analyzing strings in the files found"));

    while (true) {
        // get all the JS URLs
        const js_urls = getJsUrls();

        if (js_urls.length === 0) {
            console.error(chalk.red("[!] No JS files found for string analysis"));
            break;
        }

        // if js_urls have everything that is in analyzedFiles, break
        let everythingAnalyzed = true;
        for (const url of js_urls) {
            //   if the url is not in analyzedFiles, set everythingAnalyzed to false
            if (!analyzedFiles.includes(url)) {
                everythingAnalyzed = false;
            }
        }

        // break if everything is analyzed
        if (everythingAnalyzed) {
            break;
        }

        // iterate through the JS URLs not yet analyzed, concurrently
        const toAnalyze = js_urls.filter((js_url) => !analyzedFiles.includes(js_url));

        await runWithConcurrency(toAnalyze, threads, async (js_url) => {
            const response = await makeRequest(js_url, {});
            const respText = await response.text();
            const foundJsFiles: FoundJsFiles = await parseJSFileContent(respText);

            // check for sourcemap reference
            const sourcemapMatch = respText.match(/\/\/# sourceMappingURL=(.+)$/m);
            if (sourcemapMatch) {
                const rawRef = sourcemapMatch[1].trim();
                if (rawRef.startsWith("data:")) {
                    const decoded = decodeInlineSourceMapDataUri(rawRef);
                    if (decoded) {
                        writeInlineSourceMap(output, js_url, decoded);
                    }
                } else {
                    const mapUrl = new URL(rawRef, js_url).href;
                    if (!mapFilesFound.includes(mapUrl)) {
                        mapFilesFound.push(mapUrl);
                    }
                }
            }

            // Iterate through the foundJsFiles and resolve the paths. A single malformed
            // candidate must not abort the loop — analyzedFiles.push(js_url) below has to run
            // regardless, or this same file is treated as "not yet analyzed" forever and the
            // outer while(true) fixpoint loop re-fetches and re-parses it indefinitely.
            for (const [key, value] of Object.entries(foundJsFiles)) {
                let resolvedPath: string;
                try {
                    resolvedPath = resolvePath(js_url, value);
                } catch {
                    continue;
                }
                if (analyzedFiles.includes(resolvedPath)) {
                    continue;
                }
                pushToJsUrls(resolvedPath);
                filesFound.push(resolvedPath);
            }

            analyzedFiles.push(js_url);
        });
    }

    // dedupe the files
    filesFound = [...new Set(filesFound)];
    mapFilesFound = [...new Set(mapFilesFound)];

    console.log(chalk.green(`[✓] Found ${filesFound.length} JS files from string analysis`));
    if (mapFilesFound.length > 0) {
        console.log(chalk.green(`[✓] Found ${mapFilesFound.length} sourcemap(s) from JS files`));
    }

    return { jsFiles: filesFound, mapFiles: mapFilesFound };
};

export default nuxt_stringAnalysisJSFiles;
