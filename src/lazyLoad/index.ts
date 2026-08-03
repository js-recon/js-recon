import chalk from "chalk";
import fs from "fs";
import frameworkDetect from "./techDetect/index.js";
import CONFIG from "../globalConfig.js";
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
import angular_recursiveChunkImports from "./angular/angular_recursiveChunkImports.js";

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
import downloadLoadedJs from "./downloadLoadedJsUtil.js";
import { DownloadQueue } from "./downloadQueue.js";

import path from "path";
import { join } from "path";
import { extractSourceMaps } from "../sourcemaps/index.js";

// import global vars
import * as lazyLoadGlobals from "./globals.js";
import * as globals from "../utility/globals.js";
import { shouldRunMethod } from "./methodFilter.js";
import DownloadProgress from "../utility/downloadProgress.js";
import { progressLog, progressWarn } from "../utility/progressLog.js";
import { resolveHostOutputDirectory } from "./outputPath.js";
import { withRequestSignal } from "../utility/makeReq.js";
import { resolveTargetInputs, type TargetInput } from "../utility/targetInputs.js";

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
    url: TargetInput,
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
    detectionTimeoutMs: number = 30 * 1000,
    cancellationSignal?: AbortSignal,
    isBatch: boolean = false
) => {
    const resolvedTargets = resolveTargetInputs(url);
    // Hoisted so the timeout handler can stop discovery and drain downloads.
    let activeCrawler: NextJsCrawler | null = null;
    let activeQueue: DownloadQueue | null = null;
    let activeDownloadProgress: DownloadProgress | null = null;
    let activeDetectionController: AbortController | null = null;
    let hardTimeoutReached = false;
    const workController = new AbortController();

    const requestCancellation = (): void => {
        hardTimeoutReached = true;
        workController.abort();
        activeDetectionController?.abort();
        activeCrawler?.stop();
        activeDownloadProgress?.stop();
        activeDownloadProgress = null;
    };
    const enqueue = (queue: DownloadQueue, urls: string[]): void => {
        if (!hardTimeoutReached) queue.push(urls);
    };
    const handleExternalCancellation = (): void => requestCancellation();
    const cleanupActiveWork = async (): Promise<void> => {
        activeDownloadProgress?.stop();
        activeDownloadProgress = null;
        if (hardTimeoutReached) await activeQueue?.drain().catch(() => undefined);
    };
    cancellationSignal?.addEventListener("abort", handleExternalCancellation, { once: true });
    if (cancellationSignal?.aborted) requestCancellation();

    const work = async () => {
        console.log(chalk.cyan("[i] Loading 'Lazy Load' module"));

        if (globals.getDisableSandbox()) {
            console.error(chalk.yellow("[!] Browser sandbox disabled"));
        }

        globals.setInsecure(insecure);
        if (insecure) {
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
            console.error(chalk.yellow("[!] Running in insecure mode. SSL certificate verification disabled"));
        }

        // if cache enabled, check if the cache file exists or not. If no, then create a new one
        if (!globals.getDisableCache()) {
            if (!fs.existsSync(globals.getRespCacheFile())) {
                fs.writeFileSync(globals.getRespCacheFile(), "{}");
            }
        }

        for (const url of resolvedTargets.targets) {
            if (hardTimeoutReached) break;
            console.log(chalk.cyan(`[i] Processing ${url}`));

            lazyLoadGlobals.clearJsUrls();
            lazyLoadGlobals.clearJsonUrls();
            lazyLoadGlobals.clearCrawledUrls();

            if (strictScope) {
                lazyLoadGlobals.setScope([new URL(url).host]);
            } else {
                lazyLoadGlobals.setScope([...inputScope]);
            }

            lazyLoadGlobals.setMaxReqQueue(threads);
            globals.setTech("");

            let tech: { name: string; evidence: string } | null;
            const detectionController = new AbortController();
            activeDetectionController = detectionController;
            let detectionTimedOut = false;
            const detectionTimeoutHandle =
                detectionTimeoutMs > 0
                    ? setTimeout(() => {
                          detectionTimedOut = true;
                          detectionController.abort();
                      }, detectionTimeoutMs)
                    : undefined;
            try {
                tech = await frameworkDetect(url, detectionController.signal);
            } finally {
                if (detectionTimeoutHandle !== undefined) clearTimeout(detectionTimeoutHandle);
                if (activeDetectionController === detectionController) activeDetectionController = null;
            }
            if (detectionTimedOut) {
                console.error(
                    chalk.yellow(
                        `[!] Framework detection timed out after ${detectionTimeoutMs}ms; treating as not detected`
                    )
                );
            }
            if (hardTimeoutReached) break;
            globals.setTech(tech ? tech.name : "");

            if (tech) {
                if (tech.name === "next") {
                    console.log(chalk.green("[✓] Next.js detected"));
                    console.log(chalk.yellow(`Evidence: ${tech.evidence}`));

                    activeQueue = new DownloadQueue(output, threads, { alreadyBatchTargetRoot: isBatch });
                    const crawler = new NextJsCrawler({
                        url,
                        output,
                        subsequentRequestsFlag,
                        urlsFile,
                        threads,
                        research,
                        maxIterations,
                        maxPageVisits,
                        onUrlsDiscovered: (urls) => enqueue(activeQueue!, urls),
                        includeMethods,
                        excludeMethods,
                        isBatch,
                    });
                    activeCrawler = crawler;

                    try {
                        await crawler.crawl();
                    } finally {
                        activeCrawler = null; // done — prevent timeout handler from calling stop()
                    }
                    if (hardTimeoutReached) return;
                    await activeQueue.drain();
                    if (hardTimeoutReached) return;
                    activeQueue.printSummary();
                    activeQueue = null;

                    if (buildId) {
                        // get the buildId
                        // the directory is the output <output>/<host.replace(":", "_")>/___subsequent_requests
                        const targetOutputDir = resolveHostOutputDirectory(output, new URL(url).host, isBatch);
                        const buildId = await next_buildId_RSC(path.join(targetOutputDir, "___subsequent_requests"));
                        if (hardTimeoutReached) return;

                        if (buildId) {
                            console.log(chalk.cyan("[+] Found buildId: " + buildId));
                            // now, write it to a file
                            fs.writeFileSync(path.join(targetOutputDir, "BUILD_ID"), buildId);
                        }
                    }

                    // if the research mode is enabled, then write the technique efficiency to a file
                    if (research) {
                        // prettify the JSON and write
                        fs.writeFileSync(researchOutput, JSON.stringify(crawler.techniqueEfficiencyMapping, null, 4));
                        console.log(
                            chalk.green("[✓] Research mode enabled. Technique efficiency written to " + researchOutput)
                        );
                    }

                    // extract the source maps
                    await extractSourceMaps(output, join(output, sourcemapDir));
                } else if (tech.name === "vue") {
                    console.log(chalk.green("[✓] Vue.js detected"));
                    console.log(chalk.yellow(`Evidence: ${tech.evidence}`));

                    activeQueue = new DownloadQueue(output, threads, { alreadyBatchTargetRoot: isBatch });
                    const queue = activeQueue;
                    const onFilesDiscovered = (files: string[]) => enqueue(queue, files);

                    // run the full discovery pipeline against the entry URL
                    const { clientSidePaths } = await vue_discoverJsFiles(
                        url,
                        maxJsSizeMb,
                        onFilesDiscovered,
                        includeMethods,
                        excludeMethods,
                        threads
                    );
                    if (hardTimeoutReached) return;

                    // recurse the same pipeline through every client-side path we found
                    await vue_recursiveClientSidePathDownload(
                        clientSidePaths,
                        threads,
                        maxJsSizeMb,
                        onFilesDiscovered,
                        includeMethods,
                        excludeMethods
                    );
                    if (hardTimeoutReached) return;

                    await queue.drain();
                    if (hardTimeoutReached) return;
                    queue.printSummary();

                    // extract the source maps
                    await extractSourceMaps(output, join(output, sourcemapDir));
                } else if (tech.name === "nuxt") {
                    console.log(chalk.green("[✓] Nuxt.js detected"));
                    console.log(chalk.yellow(`Evidence: ${tech.evidence}`));

                    const queue = new DownloadQueue(output, threads, { alreadyBatchTargetRoot: isBatch });
                    activeQueue = queue;

                    // find the files from the page source
                    const jsFilesFromPageSource = shouldRunMethod(
                        "nuxt_getFromPageSource",
                        includeMethods,
                        excludeMethods
                    )
                        ? await nuxt_getFromPageSource(url)
                        : [];
                    enqueue(queue, jsFilesFromPageSource);

                    const jsFilesFromStringAnalysis = shouldRunMethod(
                        "nuxt_stringAnalysisJSFiles",
                        includeMethods,
                        excludeMethods
                    )
                        ? await nuxt_stringAnalysisJSFiles(url, threads)
                        : [];
                    enqueue(queue, jsFilesFromStringAnalysis);

                    const firstBatch = [...new Set([...jsFilesFromPageSource, ...jsFilesFromStringAnalysis])];

                    let jsFilesFromAST = [];
                    if (shouldRunMethod("nuxt_astParse", includeMethods, excludeMethods)) {
                        console.log(chalk.cyan("[i] Analyzing functions in the files found"));
                        for (const jsFile of firstBatch) {
                            jsFilesFromAST.push(...(await nuxt_astParse(jsFile)));
                        }
                    }
                    enqueue(queue, jsFilesFromAST);
                    enqueue(queue, lazyLoadGlobals.getJsUrls());

                    const buildsManifestFiles = shouldRunMethod(
                        "nuxt_getBuildsManifest",
                        includeMethods,
                        excludeMethods
                    )
                        ? await nuxt_getBuildsManifest(url)
                        : [];
                    enqueue(queue, buildsManifestFiles);

                    await queue.drain();
                    if (hardTimeoutReached) return;
                    queue.printSummary();
                } else if (tech.name === "svelte") {
                    console.log(chalk.green("[✓] Svelte detected"));
                    console.log(chalk.yellow(`Evidence: ${tech.evidence}`));

                    const queue = new DownloadQueue(output, threads, { alreadyBatchTargetRoot: isBatch });
                    activeQueue = queue;

                    // find the files from the page source
                    const jsFilesFromPageSource = shouldRunMethod(
                        "svelte_getFromPageSource",
                        includeMethods,
                        excludeMethods
                    )
                        ? await svelte_getFromPageSource(url)
                        : [];
                    enqueue(queue, jsFilesFromPageSource);

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
                        enqueue(queue, versionJsonFiles);
                    }

                    // analyze the strings now
                    let jsFilesFromStringAnalysis: string[] = [];
                    let mapFilesFromStringAnalysis: string[] = [];
                    if (shouldRunMethod("svelte_stringAnalysisJSFiles", includeMethods, excludeMethods)) {
                        const result = await svelte_stringAnalysisJSFiles(url, threads);
                        jsFilesFromStringAnalysis = result.jsFiles;
                        mapFilesFromStringAnalysis = result.mapFiles;
                        enqueue(queue, jsFilesFromStringAnalysis);
                        if (mapFilesFromStringAnalysis.length > 0) {
                            enqueue(queue, mapFilesFromStringAnalysis);
                        }
                    }

                    // recursively follow ESM static imports (import ... from "./chunk.js")
                    const visited = new Set<string>();
                    let toFollow = [...new Set([...jsFilesFromPageSource, ...jsFilesFromStringAnalysis])];
                    while (toFollow.length > 0) {
                        const newFiles = await react_followImports(toFollow, maxJsSizeMb, url, visited, threads);
                        if (newFiles.length === 0) break;
                        console.log(chalk.green(`[✓] Discovered ${newFiles.length} more JS file(s) via imports`));
                        enqueue(queue, newFiles);
                        toFollow = newFiles;
                    }

                    // crawl same-origin HTML pages found via <a href> and <link href>,
                    // running the full JS-discovery pipeline on each
                    const jsFilesFromPageCrawl = shouldRunMethod(
                        "svelte_recursivePageCrawl",
                        includeMethods,
                        excludeMethods
                    )
                        ? await svelte_recursivePageCrawl(url, maxJsSizeMb, (files) => enqueue(queue, files))
                        : [];

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
                        ? await svelte_discoverPagesFromJs(url, threads)
                        : [];
                    if (jsFilesFromPathScan.length > 0) {
                        enqueue(queue, jsFilesFromPathScan);
                    }

                    // run string analysis once more to catch JS files discovered during page crawl
                    if (
                        (jsFilesFromPageCrawl.length > 0 || jsFilesFromPathScan.length > 0) &&
                        shouldRunMethod("svelte_stringAnalysisJSFiles", includeMethods, excludeMethods)
                    ) {
                        const { jsFiles: jsFilesFromStringAnalysis2, mapFiles: mapFilesFromStringAnalysis2 } =
                            await svelte_stringAnalysisJSFiles(url, threads);
                        enqueue(queue, jsFilesFromStringAnalysis2);
                        if (mapFilesFromStringAnalysis2.length > 0) {
                            enqueue(queue, mapFilesFromStringAnalysis2);
                        }
                    }

                    await queue.drain();
                    if (hardTimeoutReached) return;
                    queue.printSummary();

                    await extractSourceMaps(output, join(output, sourcemapDir));
                } else if (tech.name === "angular") {
                    console.log(chalk.green("[✓] Angular detected"));
                    console.log(chalk.yellow(`Evidence: ${tech.evidence}`));

                    const queue = new DownloadQueue(output, threads, { alreadyBatchTargetRoot: isBatch });
                    activeQueue = queue;

                    // find the files from the page source
                    const jsFilesFromPageSource = shouldRunMethod(
                        "angular_getFromPageSource",
                        includeMethods,
                        excludeMethods
                    )
                        ? await angular_getFromPageSource(url)
                        : [];
                    enqueue(queue, jsFilesFromPageSource);

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
                            enqueue(queue, jsFilesFromMainJs);

                            // recursively follow chunk-to-chunk imports beyond the first hop
                            if (shouldRunMethod("angular_recursiveChunkImports", includeMethods, excludeMethods)) {
                                const transitiveChunks = await angular_recursiveChunkImports(
                                    jsFilesFromMainJs,
                                    threads
                                );
                                enqueue(queue, transitiveChunks);
                            }
                        }
                    }

                    await queue.drain();
                    if (hardTimeoutReached) return;
                    queue.printSummary();
                } else if (tech.name === "react") {
                    console.log(chalk.green("[✓] React detected"));
                    console.log(chalk.yellow(`Evidence: ${tech.evidence}`));

                    const queue = new DownloadQueue(output, threads, {
                        compactOutput: true,
                        onProgress: (progress) => activeDownloadProgress?.update(progress),
                        alreadyBatchTargetRoot: isBatch,
                    });
                    activeQueue = queue;

                    // Seed: <script src> tags + <link rel="modulepreload"> (Vite vendor chunks)
                    const jsFilesFromPageSource = shouldRunMethod("react_getScriptTags", includeMethods, excludeMethods)
                        ? await react_getScriptTags(url, maxJsSizeMb, output, isBatch)
                        : [];
                    if (hardTimeoutReached) return;
                    enqueue(queue, jsFilesFromPageSource);

                    // webpack-style chunk path builders (CRA / custom webpack configs)
                    const webpackChunkPaths = shouldRunMethod("react_webpackChunkPaths", includeMethods, excludeMethods)
                        ? await react_webpackChunkPaths(url, maxJsSizeMb, jsFilesFromPageSource, threads)
                        : [];
                    if (hardTimeoutReached) return;
                    activeDownloadProgress = new DownloadProgress();
                    activeDownloadProgress.update(queue.progress);

                    try {
                        enqueue(queue, webpackChunkPaths);

                        // Recursively follow ESM imports and Vite __vite_mapDeps references.
                        // visited starts empty so the seed files are fetched and parsed in the first round.
                        const visited = new Set<string>();
                        if (shouldRunMethod("react_followImports", includeMethods, excludeMethods)) {
                            let toFollow = [...new Set([...jsFilesFromPageSource, ...webpackChunkPaths])];
                            while (toFollow.length > 0 && !hardTimeoutReached) {
                                const newFiles = await react_followImports(
                                    toFollow,
                                    maxJsSizeMb,
                                    url,
                                    visited,
                                    threads,
                                    true
                                );
                                if (hardTimeoutReached) break;
                                if (newFiles.length === 0) break;
                                progressLog(
                                    chalk.green(`[✓] Discovered ${newFiles.length} more JS file(s) via imports`)
                                );
                                enqueue(queue, newFiles);
                                toFollow = newFiles;
                            }
                        }

                        // Sourcemaps for everything discovered
                        if (
                            !hardTimeoutReached &&
                            shouldRunMethod("react_sourcemapUrls", includeMethods, excludeMethods)
                        ) {
                            const sourcemapUrls = await react_sourcemapUrls([...visited], threads);
                            enqueue(queue, sourcemapUrls);
                        }

                        await queue.drain();
                    } finally {
                        activeDownloadProgress?.stop();
                        activeDownloadProgress = null;
                    }
                    if (hardTimeoutReached) return;
                    queue.printSummary();

                    await extractSourceMaps(output, join(output, sourcemapDir));
                }
            } else {
                console.error(chalk.red("[!] Framework not detected :("));
                console.log(chalk.magenta(CONFIG.notFoundMessage));
                console.log(chalk.yellow("[i] Trying to download loaded JS files"));
                const js_urls = await downloadLoadedJs(url);
                if (hardTimeoutReached) return;
                if (js_urls && js_urls.length > 0) {
                    console.log(chalk.green(`[✓] Found ${js_urls.length} JS chunks`));

                    // Second-chance tech detection: scan downloaded URL paths for
                    // framework signatures that Puppeteer may have missed on timeout
                    // (e.g. Next.js served at a non-root basePath).
                    let secondChanceTech: string | null = null;
                    let secondChanceEvidence = "";
                    for (const u of js_urls) {
                        if (u.includes("/_next/")) {
                            secondChanceTech = "next";
                            secondChanceEvidence = u;
                            break;
                        }
                        if (u.includes("/_nuxt/")) {
                            secondChanceTech = "nuxt";
                            secondChanceEvidence = u;
                            break;
                        }
                        if (u.includes("/_app/immutable/")) {
                            secondChanceTech = "svelte";
                            secondChanceEvidence = u;
                            break;
                        }
                    }
                    if (secondChanceTech) {
                        console.log(
                            chalk.green(
                                `[✓] Detected ${secondChanceTech} from downloaded file paths (evidence: ${secondChanceEvidence})`
                            )
                        );
                        globals.setTech(secondChanceTech);
                    }

                    const queue = new DownloadQueue(output, threads, { alreadyBatchTargetRoot: isBatch });
                    enqueue(queue, js_urls);
                    await queue.drain();
                    if (hardTimeoutReached) return;
                    queue.printSummary();
                }
            }
        }
    };

    if (hardTimeoutMs === 0) {
        try {
            await withRequestSignal(workController.signal, work);
            return;
        } finally {
            cancellationSignal?.removeEventListener("abort", handleExternalCancellation);
            await cleanupActiveWork();
        }
    }

    const timeoutHandle = setTimeout(() => {
        requestCancellation();
        const timeoutLabel = hardTimeoutMs >= 60_000 ? `${hardTimeoutMs / 60_000} min` : `${hardTimeoutMs}ms`;
        progressWarn(
            chalk.yellow(
                `[!] Lazyload hard timeout reached (${timeoutLabel}). Stopping discovery and waiting for in-flight work...`
            )
        );
    }, hardTimeoutMs);

    try {
        // Never return while work() can still mutate files, globals, or terminal
        // state. The timeout requests cooperative cancellation, then this await
        // provides the lifecycle boundary for all in-flight framework work.
        await withRequestSignal(workController.signal, work);
    } finally {
        clearTimeout(timeoutHandle);
        cancellationSignal?.removeEventListener("abort", handleExternalCancellation);
        await cleanupActiveWork();
    }
};

export default lazyLoad;
