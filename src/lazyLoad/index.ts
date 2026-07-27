import fs from "fs";
import frameworkDetect, { getLastInterceptedUrls } from "./techDetect/index.js";
import _traverse from "@babel/traverse";
const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;
import { URL } from "url";
import * as cheerio from "cheerio";

// Next.js
import NextJsCrawler from "./next_js/NextJsCrawler.js";
import { next_buildId_RSC } from "./next_js/next_buildId.js";

// Nuxt.js
import nuxt_getFromPageSource from "./nuxt_js/nuxt_getFromPageSource.js";
import nuxt_stringAnalysisJSFiles from "./nuxt_js/nuxt_stringAnalysisJSFiles.js";
import nuxt_astParse from "./nuxt_js/nuxt_astParse.js";
import nuxt_getBuildsManifest from "./nuxt_js/nuxt_getBuildsManifest.js";

// Svelte
import svelte_getFromPageSource from "./svelte/svelte_getFromPageSource.js";
import svelte_stringAnalysisJSFiles from "./svelte/svelte_stringAnalysisJSFiles.js";
import svelte_recursivePageCrawl from "./svelte/svelte_recursivePageCrawl.js";
import svelte_discoverPagesFromJs from "./svelte/svelte_discoverPagesFromJs.js";
import svelte_getVersionJson from "./svelte/svelte_getVersionJson.js";

// Angular
import angular_getFromPageSource from "./angular/angular_getFromPageSource.js";
import angular_getFromMainJs from "./angular/angular_getFromMainJs.js";

// Vue
import vue_discoverJsFiles from "./vue/vue_discoverJsFiles.js";
import vue_recursiveClientSidePathDownload from "./vue/vue_recursiveClientSidePathDownload.js";

// React
import react_getScriptTags from "./react/react_getScriptTags.js";
import react_webpackChunkPaths from "./react/react_webpackChunkPaths.js";
import react_sourcemapUrls from "./react/react_sourcemapUrls.js";
import react_followImports from "./react/react_followImports.js";

// generic
import downloadFiles from "./downloadFilesUtil.js";
import { DownloadQueue } from "./downloadQueue.js";
import generic_crawlPages from "./generic/generic_crawlPages.js";
import resolveGenericScope from "./generic/generic_resolveScope.js";

import path from "path";
import { join } from "path";
import { extractSourceMaps } from "../sourcemaps/index.js";

// import global vars
import * as lazyLoadGlobals from "./globals.js";
import * as globals from "../utility/globals.js";
import { shouldRunMethod } from "./methodFilter.js";
import { accumulateTechnique, createTechniqueRecorder } from "./researchUtils.js";
import { printMsg, MSG } from "../utility/printMsg.js";

/**
 * Downloads the required JavaScript files for a given URL
 * @param {string} url The URL to download the JS files from
 * @param {string} output The output directory to store the downloaded JS files
 * @param {boolean} strictScope If true, then only download the JS files from the input URL domain
 * @param {string[]} inputScope The list of domains to download the JS files from
 * @param {number} threads The number of threads to use for downloading the JS files
 * @param {boolean} subsequentRequestsFlag If true, then also download the JS files from subsequent requests
 * @param {string} urlsFile The file containing the list of URLs to download the JS files from
 * @param {boolean} insecure If true, then disable SSL certificate verification
 * @returns {Promise<void>} A Promise that resolves when the download is complete
 */
const lazyLoad = async (
    url: string,
    output: string,
    strictScope: boolean,
    inputScope: string[],
    threads: number,
    subsequentRequestsFlag: boolean,
    urlsFile: string,
    insecure: boolean,
    buildId: boolean,
    sourcemapDir: string,
    research: boolean,
    researchOutput: string,
    maxIterations: number,
    maxJsSizeMb: number = 2,
    hardTimeoutMs: number = 30 * 60 * 1000,
    maxPageVisits: number = 200,
    includeMethods: string[] = [],
    excludeMethods: string[] = [],
    maxRedirects: number = 20,
    stringsEnabled: boolean = false,
    stringsMaxIterations: number = 5,
    stagnationTimeinMs: number = 0,
    stagnationPercentage: number = 80,
    stagnationMonitorMs: number = 60 * 1000
) => {
    // Hoisted so the timeout handler can stop discovery and drain downloads.
    let activeCrawler: NextJsCrawler | null = null;
    let activeQueue: DownloadQueue | null = null;

    const work = async () => {
        printMsg(MSG.Header, "[i] Loading 'Lazy Load' module");

        if (globals.getDisableSandbox()) {
            printMsg(MSG.Warn, "[!] Browser sandbox disabled");
        }

        if (insecure) {
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
            printMsg(MSG.Warn, "[!] Running in insecure mode. SSL certificate verification disabled");
        }

        // if cache enabled, check if the cache file exists or not. If no, then create a new one
        if (!globals.getDisableCache()) {
            if (!fs.existsSync(globals.getRespCacheFile())) {
                fs.writeFileSync(globals.getRespCacheFile(), "{}");
            }
        }

        let urls;

        // check if the url is file or a URL
        if (fs.existsSync(url)) {
            urls = fs.readFileSync(url, "utf8").split("\n");
            // remove the empty lines
            urls = urls.filter((url) => url.trim() !== "");
        } else if (url.match(/https?:\/\/[a-zA-Z0-9\-_\.:]+/)) {
            urls = [url];
        } else {
            printMsg(MSG.Err, "[!] Invalid URL or file path");
            process.exit(3);
        }

        for (const url of urls) {
            printMsg(MSG.Header, `[i] Processing ${url}`);

            if (strictScope) {
                lazyLoadGlobals.pushToScope(new URL(url).host);
            } else {
                lazyLoadGlobals.setScope(inputScope);
            }

            lazyLoadGlobals.setMaxReqQueue(threads);

            const tech = await frameworkDetect(url);
            globals.setTech(tech ? tech.name : "");

            if (tech) {
                if (tech.name === "next") {
                    printMsg(MSG.Run, "[✓] Next.js detected");
                    printMsg(MSG.Warn, `Evidence: ${tech.evidence}`);

                    activeQueue = new DownloadQueue(output, threads);
                    const crawler = new NextJsCrawler({
                        url,
                        output,
                        subsequentRequestsFlag,
                        urlsFile,
                        threads,
                        research,
                        maxIterations,
                        maxPageVisits,
                        onUrlsDiscovered: (urls) => activeQueue!.push(urls),
                        includeMethods,
                        excludeMethods,
                    });
                    activeCrawler = crawler;

                    await crawler.crawl();
                    activeCrawler = null; // done — prevent timeout handler from calling stop()
                    await activeQueue.drain();
                    activeQueue.printSummary();
                    activeQueue = null;

                    if (buildId) {
                        // get the buildId
                        // the directory is the output <output>/<host.replace(":", "_")>/___subsequent_requests
                        const buildId = await next_buildId_RSC(
                            output + "/" + new URL(url).host.replace(":", "_") + "/___subsequent_requests"
                        );

                        if (buildId) {
                            printMsg(MSG.Header, "[+] Found buildId: " + buildId);
                            // now, write it to a file
                            fs.writeFileSync(
                                path.join(output, new URL(url).host.replace(":", "_") + "/BUILD_ID"),
                                buildId
                            );
                        }
                    }

                    // if the research mode is enabled, then write the technique efficiency to a file
                    if (research) {
                        // prettify the JSON and write
                        fs.writeFileSync(researchOutput, JSON.stringify(crawler.techniqueEfficiencyMapping, null, 4));
                        printMsg(
                            MSG.Run,
                            "[✓] Research mode enabled. Technique efficiency written to " + researchOutput
                        );
                    }

                    // extract the source maps
                    await extractSourceMaps(output, join(output, sourcemapDir));
                } else if (tech.name === "vue") {
                    printMsg(MSG.Run, "[✓] Vue.js detected");
                    printMsg(MSG.Warn, `Evidence: ${tech.evidence}`);

                    activeQueue = new DownloadQueue(output, threads);
                    const queue = activeQueue;
                    const onFilesDiscovered = (files: string[]) => queue.push(files);

                    const vueResearchMap: Record<string, string[]> = {};
                    const vueOnTechnique = research ? createTechniqueRecorder(vueResearchMap) : undefined;

                    // run the full discovery pipeline against the entry URL
                    const { clientSidePaths } = await vue_discoverJsFiles(
                        url,
                        maxJsSizeMb,
                        onFilesDiscovered,
                        includeMethods,
                        excludeMethods,
                        vueOnTechnique
                    );

                    // recurse the same pipeline through every client-side path we found
                    await vue_recursiveClientSidePathDownload(
                        clientSidePaths,
                        threads,
                        maxJsSizeMb,
                        onFilesDiscovered,
                        includeMethods,
                        excludeMethods,
                        vueOnTechnique
                    );

                    await queue.drain();
                    queue.printSummary();

                    if (research) {
                        fs.writeFileSync(researchOutput, JSON.stringify(vueResearchMap, null, 4));
                        printMsg(
                            MSG.Run,
                            "[✓] Research mode enabled. Technique efficiency written to " + researchOutput
                        );
                    }

                    // extract the source maps
                    await extractSourceMaps(output, join(output, sourcemapDir));
                } else if (tech.name === "nuxt") {
                    printMsg(MSG.Run, "[✓] Nuxt.js detected");
                    printMsg(MSG.Warn, `Evidence: ${tech.evidence}`);

                    const queue = new DownloadQueue(output, threads);
                    activeQueue = queue;

                    const nuxtResearchMap: Record<string, string[]> = {};

                    // find the files from the page source
                    const jsFilesFromPageSource = shouldRunMethod(
                        "nuxt_getFromPageSource",
                        includeMethods,
                        excludeMethods
                    )
                        ? await nuxt_getFromPageSource(url)
                        : [];
                    queue.push(jsFilesFromPageSource);
                    if (research) accumulateTechnique(nuxtResearchMap, "nuxt_getFromPageSource", jsFilesFromPageSource);

                    const jsFilesFromStringAnalysis = shouldRunMethod(
                        "nuxt_stringAnalysisJSFiles",
                        includeMethods,
                        excludeMethods
                    )
                        ? await nuxt_stringAnalysisJSFiles(url)
                        : [];
                    queue.push(jsFilesFromStringAnalysis);
                    if (research)
                        accumulateTechnique(nuxtResearchMap, "nuxt_stringAnalysisJSFiles", jsFilesFromStringAnalysis);

                    const firstBatch = [...new Set([...jsFilesFromPageSource, ...jsFilesFromStringAnalysis])];

                    let jsFilesFromAST = [];
                    if (shouldRunMethod("nuxt_astParse", includeMethods, excludeMethods)) {
                        printMsg(MSG.Header, "[i] Analyzing functions in the files found");
                        for (const jsFile of firstBatch) {
                            jsFilesFromAST.push(...(await nuxt_astParse(jsFile)));
                        }
                    }
                    queue.push(jsFilesFromAST);
                    if (research) accumulateTechnique(nuxtResearchMap, "nuxt_astParse", jsFilesFromAST);
                    queue.push(lazyLoadGlobals.getJsUrls());

                    const buildsManifestFiles = shouldRunMethod(
                        "nuxt_getBuildsManifest",
                        includeMethods,
                        excludeMethods
                    )
                        ? await nuxt_getBuildsManifest(url)
                        : [];
                    queue.push(buildsManifestFiles);
                    if (research) accumulateTechnique(nuxtResearchMap, "nuxt_getBuildsManifest", buildsManifestFiles);

                    await queue.drain();
                    queue.printSummary();

                    if (research) {
                        fs.writeFileSync(researchOutput, JSON.stringify(nuxtResearchMap, null, 4));
                        printMsg(
                            MSG.Run,
                            "[✓] Research mode enabled. Technique efficiency written to " + researchOutput
                        );
                    }
                } else if (tech.name === "svelte") {
                    printMsg(MSG.Run, "[✓] Svelte detected");
                    printMsg(MSG.Warn, `Evidence: ${tech.evidence}`);

                    const queue = new DownloadQueue(output, threads);
                    activeQueue = queue;

                    const svelteResearchMap: Record<string, string[]> = {};

                    // find the files from the page source
                    const jsFilesFromPageSource = shouldRunMethod(
                        "svelte_getFromPageSource",
                        includeMethods,
                        excludeMethods
                    )
                        ? await svelte_getFromPageSource(url)
                        : [];
                    queue.push(jsFilesFromPageSource);
                    if (research)
                        accumulateTechnique(svelteResearchMap, "svelte_getFromPageSource", jsFilesFromPageSource);

                    // probe /<appDir>/version.json — SvelteKit serves this for the `updated` store
                    // but never references it from HTML or JS, so it is invisible to all other steps
                    const appDir = (() => {
                        for (const f of jsFilesFromPageSource) {
                            try {
                                const m = new URL(f).pathname.match(/^\/([^/]+)\/immutable\//);
                                if (m) return m[1];
                            } catch {}
                        }
                        return "_app";
                    })();
                    const versionJsonFiles = shouldRunMethod("svelte_getVersionJson", includeMethods, excludeMethods)
                        ? await svelte_getVersionJson(url, appDir)
                        : [];
                    if (versionJsonFiles.length > 0) {
                        queue.push(versionJsonFiles);
                    }
                    if (research) accumulateTechnique(svelteResearchMap, "svelte_getVersionJson", versionJsonFiles);

                    // analyze the strings now
                    let jsFilesFromStringAnalysis: string[] = [];
                    let mapFilesFromStringAnalysis: string[] = [];
                    if (shouldRunMethod("svelte_stringAnalysisJSFiles", includeMethods, excludeMethods)) {
                        const result = await svelte_stringAnalysisJSFiles(url);
                        jsFilesFromStringAnalysis = result.jsFiles;
                        mapFilesFromStringAnalysis = result.mapFiles;
                        queue.push(jsFilesFromStringAnalysis);
                        if (mapFilesFromStringAnalysis.length > 0) {
                            queue.push(mapFilesFromStringAnalysis);
                        }
                        if (research) {
                            accumulateTechnique(
                                svelteResearchMap,
                                "svelte_stringAnalysisJSFiles",
                                jsFilesFromStringAnalysis
                            );
                            accumulateTechnique(
                                svelteResearchMap,
                                "svelte_stringAnalysisJSFiles",
                                mapFilesFromStringAnalysis
                            );
                        }
                    }

                    // recursively follow ESM static imports (import ... from "./chunk.js")
                    // svelte_followImports reuses react_followImports — tracked under react_followImports key
                    const visited = new Set<string>();
                    let toFollow = [...new Set([...jsFilesFromPageSource, ...jsFilesFromStringAnalysis])];
                    while (toFollow.length > 0) {
                        const newFiles = await react_followImports(toFollow, maxJsSizeMb, url, visited);
                        if (newFiles.length === 0) break;
                        printMsg(MSG.Run, `[✓] Discovered ${newFiles.length} more JS file(s) via imports`);
                        queue.push(newFiles);
                        if (research) accumulateTechnique(svelteResearchMap, "react_followImports", newFiles);
                        toFollow = newFiles;
                    }

                    // crawl same-origin HTML pages found via <a href> and <link href>,
                    // running the full JS-discovery pipeline on each
                    const jsFilesFromPageCrawl = shouldRunMethod(
                        "svelte_recursivePageCrawl",
                        includeMethods,
                        excludeMethods
                    )
                        ? await svelte_recursivePageCrawl(url, maxJsSizeMb, (files) => queue.push(files))
                        : [];
                    if (research)
                        accumulateTechnique(svelteResearchMap, "svelte_recursivePageCrawl", jsFilesFromPageCrawl);

                    // Svelte/Astro apps use client-side routing — the home page rarely has
                    // <a href> links in its server-rendered HTML. Scan downloaded JS for
                    // embedded page path strings (e.g. "/admin", "/debug") and visit each
                    // page to discover the Astro island component-url values for those routes.
                    // Iterates until no new paths or JS files are discovered.
                    const jsFilesFromPathScan = shouldRunMethod(
                        "svelte_discoverPagesFromJs",
                        includeMethods,
                        excludeMethods
                    )
                        ? await svelte_discoverPagesFromJs(url)
                        : [];
                    if (jsFilesFromPathScan.length > 0) {
                        queue.push(jsFilesFromPathScan);
                    }
                    if (research)
                        accumulateTechnique(svelteResearchMap, "svelte_discoverPagesFromJs", jsFilesFromPathScan);

                    // run string analysis once more to catch JS files discovered during page crawl
                    if (
                        (jsFilesFromPageCrawl.length > 0 || jsFilesFromPathScan.length > 0) &&
                        shouldRunMethod("svelte_stringAnalysisJSFiles", includeMethods, excludeMethods)
                    ) {
                        const { jsFiles: jsFilesFromStringAnalysis2, mapFiles: mapFilesFromStringAnalysis2 } =
                            await svelte_stringAnalysisJSFiles(url);
                        queue.push(jsFilesFromStringAnalysis2);
                        if (mapFilesFromStringAnalysis2.length > 0) {
                            queue.push(mapFilesFromStringAnalysis2);
                        }
                        if (research) {
                            accumulateTechnique(
                                svelteResearchMap,
                                "svelte_stringAnalysisJSFiles",
                                jsFilesFromStringAnalysis2
                            );
                            accumulateTechnique(
                                svelteResearchMap,
                                "svelte_stringAnalysisJSFiles",
                                mapFilesFromStringAnalysis2
                            );
                        }
                    }

                    await queue.drain();
                    queue.printSummary();

                    if (research) {
                        fs.writeFileSync(researchOutput, JSON.stringify(svelteResearchMap, null, 4));
                        printMsg(
                            MSG.Run,
                            "[✓] Research mode enabled. Technique efficiency written to " + researchOutput
                        );
                    }

                    await extractSourceMaps(output, join(output, sourcemapDir));
                } else if (tech.name === "angular") {
                    printMsg(MSG.Run, "[✓] Angular detected");
                    printMsg(MSG.Warn, `Evidence: ${tech.evidence}`);

                    const queue = new DownloadQueue(output, threads);
                    activeQueue = queue;

                    const angularResearchMap: Record<string, string[]> = {};

                    // find the files from the page source
                    const jsFilesFromPageSource = shouldRunMethod(
                        "angular_getFromPageSource",
                        includeMethods,
                        excludeMethods
                    )
                        ? await angular_getFromPageSource(url)
                        : [];
                    queue.push(jsFilesFromPageSource);
                    if (research)
                        accumulateTechnique(angularResearchMap, "angular_getFromPageSource", jsFilesFromPageSource);

                    // files using the main.js
                    if (shouldRunMethod("angular_getFromMainJs", includeMethods, excludeMethods)) {
                        let mainJsUrl: string | undefined;
                        for (const jsFile of jsFilesFromPageSource) {
                            if (jsFile.match(/main[a-zA-Z0-9\-]*\.js/)) {
                                mainJsUrl = jsFile;
                                break;
                            }
                        }

                        if (mainJsUrl) {
                            const jsFilesFromMainJs = await angular_getFromMainJs(mainJsUrl);
                            queue.push(jsFilesFromMainJs);
                            if (research)
                                accumulateTechnique(angularResearchMap, "angular_getFromMainJs", jsFilesFromMainJs);
                        }
                    }

                    await queue.drain();
                    queue.printSummary();

                    if (research) {
                        fs.writeFileSync(researchOutput, JSON.stringify(angularResearchMap, null, 4));
                        printMsg(
                            MSG.Run,
                            "[✓] Research mode enabled. Technique efficiency written to " + researchOutput
                        );
                    }
                } else if (tech.name === "react") {
                    printMsg(MSG.Run, "[✓] React detected");
                    printMsg(MSG.Warn, `Evidence: ${tech.evidence}`);

                    const queue = new DownloadQueue(output, threads);
                    activeQueue = queue;

                    const reactResearchMap: Record<string, string[]> = {};

                    // Seed: <script src> tags + <link rel="modulepreload"> (Vite vendor chunks)
                    const jsFilesFromPageSource = shouldRunMethod("react_getScriptTags", includeMethods, excludeMethods)
                        ? await react_getScriptTags(url, maxJsSizeMb, output)
                        : [];
                    queue.push(jsFilesFromPageSource);
                    if (research) accumulateTechnique(reactResearchMap, "react_getScriptTags", jsFilesFromPageSource);

                    // webpack-style chunk path builders (CRA / custom webpack configs)
                    const webpackChunkPaths = shouldRunMethod("react_webpackChunkPaths", includeMethods, excludeMethods)
                        ? await react_webpackChunkPaths(url, maxJsSizeMb, jsFilesFromPageSource)
                        : [];
                    queue.push(webpackChunkPaths);
                    if (research) accumulateTechnique(reactResearchMap, "react_webpackChunkPaths", webpackChunkPaths);

                    // Recursively follow ESM imports and Vite __vite_mapDeps references.
                    // visited starts empty so the seed files are fetched and parsed in the first round.
                    const visited = new Set<string>();
                    if (shouldRunMethod("react_followImports", includeMethods, excludeMethods)) {
                        let toFollow = [...new Set([...jsFilesFromPageSource, ...webpackChunkPaths])];
                        while (toFollow.length > 0) {
                            const newFiles = await react_followImports(toFollow, maxJsSizeMb, url, visited);
                            if (newFiles.length === 0) break;
                            printMsg(MSG.Run, `[✓] Discovered ${newFiles.length} more JS file(s) via imports`);
                            queue.push(newFiles);
                            if (research) accumulateTechnique(reactResearchMap, "react_followImports", newFiles);
                            toFollow = newFiles;
                        }
                    }

                    // Sourcemaps for everything discovered
                    if (shouldRunMethod("react_sourcemapUrls", includeMethods, excludeMethods)) {
                        const sourcemapUrls = await react_sourcemapUrls([...visited]);
                        queue.push(sourcemapUrls);
                        if (research) accumulateTechnique(reactResearchMap, "react_sourcemapUrls", sourcemapUrls);
                    }

                    await queue.drain();
                    queue.printSummary();

                    if (research) {
                        fs.writeFileSync(researchOutput, JSON.stringify(reactResearchMap, null, 4));
                        printMsg(
                            MSG.Run,
                            "[✓] Research mode enabled. Technique efficiency written to " + researchOutput
                        );
                    }

                    extractSourceMaps(output, join(output, sourcemapDir));
                }
            } else {
                printMsg(MSG.Warn, "[i] Framework not detected — falling back to generic JS extraction");
                globals.setTech("generic");

                // If the caller didn't customize scope (still the "*" default) and isn't
                // using --strict-scope, default the generic crawl's scope to the origin
                // reached after following redirects, rather than crawling the whole web.
                if (!strictScope && inputScope.length === 1 && inputScope[0] === "*") {
                    const resolvedScope = await resolveGenericScope(url, maxRedirects);
                    lazyLoadGlobals.setScope(resolvedScope);
                }

                // Downloads JS incrementally as pages are crawled (see generic_crawlPages.ts) —
                // the returned list is only used for the final summary count.
                const genericResearchMap: Record<string, string[]> = {};
                const allUrls = await generic_crawlPages(
                    url,
                    maxJsSizeMb,
                    output,
                    maxPageVisits,
                    threads,
                    research ? genericResearchMap : undefined,
                    stringsEnabled,
                    stringsMaxIterations,
                    getLastInterceptedUrls(),
                    stagnationTimeinMs,
                    stagnationPercentage,
                    stagnationMonitorMs
                );

                if (allUrls.length > 0) {
                    printMsg(MSG.Run, `[✓] Found ${allUrls.length} JS file(s)`);
                } else {
                    printMsg(MSG.Warn, "[i] No JS files discovered");
                }

                if (research) {
                    fs.writeFileSync(researchOutput, JSON.stringify(genericResearchMap, null, 4));
                    printMsg(MSG.Run, "[✓] Research mode enabled. Technique efficiency written to " + researchOutput);
                }
            }
        }
    };

    if (hardTimeoutMs === 0) {
        await work();
        return;
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    await Promise.race([
        work().finally(() => {
            // work() finished before the timeout — cancel the timer so it never
            // fires orphaned and doesn't hold the event loop open.
            if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        }),
        new Promise<void>((resolve) => {
            timeoutHandle = setTimeout(() => {
                printMsg(
                    MSG.Warn,
                    `[!] Lazyload hard timeout reached (${hardTimeoutMs / 60000} min). Draining discovered files before moving on...`
                );
                // Signal the crawler to stop at its next iteration boundary.
                activeCrawler?.stop();
                const q = activeQueue;
                if (q) {
                    // Wait for already-queued downloads to finish, then move on.
                    q.drain()
                        .then(() => {
                            q.printSummary();
                            resolve();
                        })
                        .catch(() => resolve());
                } else {
                    resolve();
                }
            }, hardTimeoutMs);
        }),
    ]);
};

export default lazyLoad;
