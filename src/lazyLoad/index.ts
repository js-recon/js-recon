import chalk from "chalk";
import fs from "fs";
import frameworkDetect, { getLastInterceptedUrls } from "./techDetect/index.js";
import _traverse from "@babel/traverse";
const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;
import { URL } from "url";
import * as cheerio from "cheerio";

// Next.js
import NextJsCrawler from "./next_js/NextJsCrawler.js";
import next_serverActionIdScan from "./next_js/next_serverActionIdScan.js";
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
import { DownloadQueue } from "./downloadQueue.js";
import generic_crawlPages from "./generic/generic_crawlPages.js";
import resolveGenericScope from "./generic/generic_resolveScope.js";

import path from "path";
import { join } from "path";
import { extractSourceMaps } from "../sourcemaps/index.js";
import { discoverSourcemapUrls } from "./sourcemap.js";

// import global vars
import * as lazyLoadGlobals from "./globals.js";
import * as globals from "../utility/globals.js";
import { shouldRunMethod } from "./methodFilter.js";
import DownloadProgress from "../utility/downloadProgress.js";
import { progressLog, progressWarn } from "../utility/progressLog.js";
import { resolveHostOutputDirectory } from "./outputPath.js";
import { withRequestSignal } from "../utility/makeReq.js";
import { resolveTargetInputs, type TargetInput } from "../utility/targetInputs.js";
import { accumulateTechnique, createTechniqueRecorder } from "./researchUtils.js";
import { printMsg, MSG } from "../utility/printMsg.js";
import { getCacheDb } from "../utility/cacheDb.js";

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
    isBatch: boolean = false,
    maxRedirects: number = 20,
    stringsEnabled: boolean = false,
    stringsMaxIterations: number = 5,
    stagnationTimeinMs: number = 0,
    stagnationPercentage: number = 80,
    stagnationMonitorMs: number = 60 * 1000,
    rscParamBruteforceLimit: number = 20,
    wordlist?: string
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
        printMsg(MSG.Header, "[i] Loading 'Lazy Load' module");

        if (globals.getDisableSandbox()) {
            printMsg(MSG.Warn, "[!] Browser sandbox disabled");
        }

        globals.setInsecure(insecure);
        if (insecure) {
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
            printMsg(MSG.Warn, "[!] Running in insecure mode. SSL certificate verification disabled");
        }

        // if cache enabled, ensure the cache DB can be opened (this also creates it + its schema if missing)
        if (!globals.getDisableCache()) {
            try {
                getCacheDb();
            } catch (err) {
                printMsg(MSG.Err, `[!] Could not open response cache database: ${err?.message || err}`);
                process.exit(32);
            }
        }

        for (const url of resolvedTargets.targets) {
            if (hardTimeoutReached) break;
            printMsg(MSG.Header, `[i] Processing ${url}`);

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
                printMsg(
                    MSG.Warn,
                    `[!] Framework detection timed out after ${detectionTimeoutMs}ms; treating as not detected`
                );
            }
            if (hardTimeoutReached) break;
            globals.setTech(tech ? tech.name : "");

            if (tech) {
                if (tech.name === "next") {
                    printMsg(MSG.Run, "[✓] Next.js detected");
                    printMsg(MSG.Warn, `Evidence: ${tech.evidence}`);

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
                        rscParamBruteforceLimit,
                        wordlist,
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
                    const nextSeenUrls = activeQueue.seenUrls;
                    activeQueue.printSummary();
                    activeQueue = null;

                    if (shouldRunMethod("next_sourcemapUrls", includeMethods, excludeMethods)) {
                        const jsUrlsForSourcemaps = nextSeenUrls.filter((u) => /\.m?js($|[?#])/.test(u));
                        const mapUrls = await discoverSourcemapUrls(jsUrlsForSourcemaps, threads, output);
                        if (mapUrls.length > 0) {
                            const mapQueue = new DownloadQueue(output, threads, { alreadyBatchTargetRoot: isBatch });
                            enqueue(mapQueue, mapUrls);
                            await mapQueue.drain();
                        }
                    }

                    if (shouldRunMethod("next_serverActionIdScan", includeMethods, excludeMethods)) {
                        const scanDir = resolveHostOutputDirectory(output, new URL(url).host, isBatch);
                        const scanResult = await next_serverActionIdScan(scanDir);
                        if (scanResult.allActionIds.length > 0) {
                            printMsg(
                                MSG.Run,
                                `[✓] Found ${scanResult.allActionIds.length} Server Action ID(s) referenced in downloaded chunks (disclosure only — not invoked)`
                            );
                            fs.writeFileSync(
                                path.join(scanDir, "server_action_ids.json"),
                                JSON.stringify(scanResult, null, 4)
                            );
                        }
                    }

                    if (buildId) {
                        // get the buildId
                        // the directory is the output <output>/<host.replace(":", "_")>/___subsequent_requests
                        const targetOutputDir = resolveHostOutputDirectory(output, new URL(url).host, isBatch);
                        const buildId = await next_buildId_RSC(path.join(targetOutputDir, "___subsequent_requests"));
                        if (hardTimeoutReached) return;

                        if (buildId) {
                            printMsg(MSG.Header, "[+] Found buildId: " + buildId);
                            // now, write it to a file
                            fs.writeFileSync(path.join(targetOutputDir, "BUILD_ID"), buildId);
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

                    activeQueue = new DownloadQueue(output, threads, { alreadyBatchTargetRoot: isBatch });
                    const queue = activeQueue;
                    const onFilesDiscovered = (files: string[]) => enqueue(queue, files);

                    const vueResearchMap: Record<string, string[]> = {};
                    const vueOnTechnique = research ? createTechniqueRecorder(vueResearchMap) : undefined;

                    // run the full discovery pipeline against the entry URL
                    const { clientSidePaths } = await vue_discoverJsFiles(
                        url,
                        maxJsSizeMb,
                        onFilesDiscovered,
                        includeMethods,
                        excludeMethods,
                        threads,
                        true,
                        true,
                        vueOnTechnique,
                        output
                    );
                    if (hardTimeoutReached) return;

                    // recurse the same pipeline through every client-side path we found
                    await vue_recursiveClientSidePathDownload(
                        clientSidePaths,
                        threads,
                        maxJsSizeMb,
                        onFilesDiscovered,
                        includeMethods,
                        excludeMethods,
                        vueOnTechnique,
                        output
                    );
                    if (hardTimeoutReached) return;

                    await queue.drain();
                    if (hardTimeoutReached) return;
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

                    const queue = new DownloadQueue(output, threads, { alreadyBatchTargetRoot: isBatch });
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
                    enqueue(queue, jsFilesFromPageSource);
                    if (research) accumulateTechnique(nuxtResearchMap, "nuxt_getFromPageSource", jsFilesFromPageSource);

                    const nuxtStringAnalysisResult = shouldRunMethod(
                        "nuxt_stringAnalysisJSFiles",
                        includeMethods,
                        excludeMethods
                    )
                        ? await nuxt_stringAnalysisJSFiles(url, threads, output)
                        : { jsFiles: [], mapFiles: [] };
                    const jsFilesFromStringAnalysis = nuxtStringAnalysisResult.jsFiles;
                    enqueue(queue, jsFilesFromStringAnalysis);
                    if (nuxtStringAnalysisResult.mapFiles.length > 0) {
                        enqueue(queue, nuxtStringAnalysisResult.mapFiles);
                    }
                    if (research)
                        accumulateTechnique(nuxtResearchMap, "nuxt_stringAnalysisJSFiles", jsFilesFromStringAnalysis);

                    const firstBatch = [...new Set([...jsFilesFromPageSource, ...jsFilesFromStringAnalysis])];

                    const jsFilesFromAST = [];
                    if (shouldRunMethod("nuxt_astParse", includeMethods, excludeMethods)) {
                        printMsg(MSG.Header, "[i] Analyzing functions in the files found");
                        for (const jsFile of firstBatch) {
                            jsFilesFromAST.push(...(await nuxt_astParse(jsFile)));
                        }
                    }
                    enqueue(queue, jsFilesFromAST);
                    if (research) accumulateTechnique(nuxtResearchMap, "nuxt_astParse", jsFilesFromAST);
                    enqueue(queue, lazyLoadGlobals.getJsUrls());

                    const buildsManifestFiles = shouldRunMethod(
                        "nuxt_getBuildsManifest",
                        includeMethods,
                        excludeMethods
                    )
                        ? await nuxt_getBuildsManifest(url)
                        : [];
                    enqueue(queue, buildsManifestFiles);
                    if (research) accumulateTechnique(nuxtResearchMap, "nuxt_getBuildsManifest", buildsManifestFiles);

                    await queue.drain();
                    if (hardTimeoutReached) return;
                    queue.printSummary();

                    if (research) {
                        fs.writeFileSync(researchOutput, JSON.stringify(nuxtResearchMap, null, 4));
                        printMsg(
                            MSG.Run,
                            "[✓] Research mode enabled. Technique efficiency written to " + researchOutput
                        );
                    }

                    // extract the source maps
                    await extractSourceMaps(output, join(output, sourcemapDir));
                } else if (tech.name === "svelte") {
                    printMsg(MSG.Run, "[✓] Svelte detected");
                    printMsg(MSG.Warn, `Evidence: ${tech.evidence}`);

                    const queue = new DownloadQueue(output, threads, { alreadyBatchTargetRoot: isBatch });
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
                    enqueue(queue, jsFilesFromPageSource);
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
                        enqueue(queue, versionJsonFiles);
                    }
                    if (research) accumulateTechnique(svelteResearchMap, "svelte_getVersionJson", versionJsonFiles);

                    // analyze the strings now
                    let jsFilesFromStringAnalysis: string[] = [];
                    let mapFilesFromStringAnalysis: string[] = [];
                    if (shouldRunMethod("svelte_stringAnalysisJSFiles", includeMethods, excludeMethods)) {
                        const result = await svelte_stringAnalysisJSFiles(url, threads, output);
                        jsFilesFromStringAnalysis = result.jsFiles;
                        mapFilesFromStringAnalysis = result.mapFiles;
                        enqueue(queue, jsFilesFromStringAnalysis);
                        if (mapFilesFromStringAnalysis.length > 0) {
                            enqueue(queue, mapFilesFromStringAnalysis);
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
                        const newFiles = await react_followImports(toFollow, maxJsSizeMb, url, visited, threads);
                        if (newFiles.length === 0) break;
                        printMsg(MSG.Run, `[✓] Discovered ${newFiles.length} more JS file(s) via imports`);
                        enqueue(queue, newFiles);
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
                        ? await svelte_recursivePageCrawl(url, maxJsSizeMb, (files) => enqueue(queue, files))
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
                        ? await svelte_discoverPagesFromJs(url, threads)
                        : [];
                    if (jsFilesFromPathScan.length > 0) {
                        enqueue(queue, jsFilesFromPathScan);
                    }
                    if (research)
                        accumulateTechnique(svelteResearchMap, "svelte_discoverPagesFromJs", jsFilesFromPathScan);

                    // run string analysis once more to catch JS files discovered during page crawl
                    if (
                        (jsFilesFromPageCrawl.length > 0 || jsFilesFromPathScan.length > 0) &&
                        shouldRunMethod("svelte_stringAnalysisJSFiles", includeMethods, excludeMethods)
                    ) {
                        const { jsFiles: jsFilesFromStringAnalysis2, mapFiles: mapFilesFromStringAnalysis2 } =
                            await svelte_stringAnalysisJSFiles(url, threads, output);
                        enqueue(queue, jsFilesFromStringAnalysis2);
                        if (mapFilesFromStringAnalysis2.length > 0) {
                            enqueue(queue, mapFilesFromStringAnalysis2);
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
                    if (hardTimeoutReached) return;
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

                    const queue = new DownloadQueue(output, threads, { alreadyBatchTargetRoot: isBatch });
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
                    enqueue(queue, jsFilesFromPageSource);
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
                            enqueue(queue, jsFilesFromMainJs);
                            if (research)
                                accumulateTechnique(angularResearchMap, "angular_getFromMainJs", jsFilesFromMainJs);

                            // recursively follow chunk-to-chunk imports beyond the first hop
                            if (shouldRunMethod("angular_recursiveChunkImports", includeMethods, excludeMethods)) {
                                const transitiveChunks = await angular_recursiveChunkImports(
                                    jsFilesFromMainJs,
                                    threads
                                );
                                enqueue(queue, transitiveChunks);
                                if (research)
                                    accumulateTechnique(
                                        angularResearchMap,
                                        "angular_recursiveChunkImports",
                                        transitiveChunks
                                    );
                            }
                        }
                    }

                    await queue.drain();
                    if (hardTimeoutReached) return;
                    queue.printSummary();

                    if (shouldRunMethod("angular_sourcemapUrls", includeMethods, excludeMethods)) {
                        const jsUrlsForSourcemaps = queue.seenUrls.filter((u) => /\.m?js($|[?#])/.test(u));
                        const mapUrls = await discoverSourcemapUrls(jsUrlsForSourcemaps, threads, output);
                        if (mapUrls.length > 0) {
                            const mapQueue = new DownloadQueue(output, threads, { alreadyBatchTargetRoot: isBatch });
                            enqueue(mapQueue, mapUrls);
                            await mapQueue.drain();
                        }
                    }

                    if (research) {
                        fs.writeFileSync(researchOutput, JSON.stringify(angularResearchMap, null, 4));
                        printMsg(
                            MSG.Run,
                            "[✓] Research mode enabled. Technique efficiency written to " + researchOutput
                        );
                    }

                    // extract the source maps
                    await extractSourceMaps(output, join(output, sourcemapDir));
                } else if (tech.name === "react") {
                    printMsg(MSG.Run, "[✓] React detected");
                    printMsg(MSG.Warn, `Evidence: ${tech.evidence}`);

                    const queue = new DownloadQueue(output, threads, {
                        compactOutput: true,
                        onProgress: (progress) => activeDownloadProgress?.update(progress),
                        alreadyBatchTargetRoot: isBatch,
                    });
                    activeQueue = queue;

                    const reactResearchMap: Record<string, string[]> = {};

                    // Seed: <script src> tags + <link rel="modulepreload"> (Vite vendor chunks)
                    const jsFilesFromPageSource = shouldRunMethod("react_getScriptTags", includeMethods, excludeMethods)
                        ? await react_getScriptTags(url, maxJsSizeMb, output, isBatch)
                        : [];
                    if (hardTimeoutReached) return;
                    enqueue(queue, jsFilesFromPageSource);
                    if (research) accumulateTechnique(reactResearchMap, "react_getScriptTags", jsFilesFromPageSource);

                    // webpack-style chunk path builders (CRA / custom webpack configs)
                    const webpackChunkPaths = shouldRunMethod("react_webpackChunkPaths", includeMethods, excludeMethods)
                        ? await react_webpackChunkPaths(url, maxJsSizeMb, jsFilesFromPageSource, threads)
                        : [];
                    if (hardTimeoutReached) return;
                    activeDownloadProgress = new DownloadProgress();
                    activeDownloadProgress.update(queue.progress);

                    try {
                        enqueue(queue, webpackChunkPaths);
                        if (research)
                            accumulateTechnique(reactResearchMap, "react_webpackChunkPaths", webpackChunkPaths);

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
                                if (research) accumulateTechnique(reactResearchMap, "react_followImports", newFiles);
                                toFollow = newFiles;
                            }
                        }

                        // Sourcemaps for everything discovered
                        if (
                            !hardTimeoutReached &&
                            shouldRunMethod("react_sourcemapUrls", includeMethods, excludeMethods)
                        ) {
                            const sourcemapUrls = await react_sourcemapUrls([...visited], threads, output);
                            enqueue(queue, sourcemapUrls);
                            if (research) accumulateTechnique(reactResearchMap, "react_sourcemapUrls", sourcemapUrls);
                        }

                        await queue.drain();
                    } finally {
                        activeDownloadProgress?.stop();
                        activeDownloadProgress = null;
                    }
                    if (hardTimeoutReached) return;
                    queue.printSummary();

                    if (research) {
                        fs.writeFileSync(researchOutput, JSON.stringify(reactResearchMap, null, 4));
                        printMsg(
                            MSG.Run,
                            "[✓] Research mode enabled. Technique efficiency written to " + researchOutput
                        );
                    }

                    await extractSourceMaps(output, join(output, sourcemapDir));
                } else if (tech.name === "next-dev") {
                    printMsg(MSG.Run, "[✓] Next.js dev server detected");
                    printMsg(MSG.Warn, `Evidence: ${tech.evidence}`);

                    activeQueue = new DownloadQueue(output, threads, { alreadyBatchTargetRoot: isBatch });
                    const queue = activeQueue;

                    const nextDevResearchMap: Record<string, string[]> = {};

                    // Dev-mode webpack serves every initial chunk directly as a <script src>
                    // tag rather than through a build manifest — no manifest/chunk-path
                    // resolution needed like the production NextJsCrawler.
                    const jsFilesFromPageSource = shouldRunMethod("react_getScriptTags", includeMethods, excludeMethods)
                        ? await react_getScriptTags(url, maxJsSizeMb, output, isBatch)
                        : [];
                    if (hardTimeoutReached) return;
                    enqueue(queue, jsFilesFromPageSource);
                    if (research) accumulateTechnique(nextDevResearchMap, "react_getScriptTags", jsFilesFromPageSource);

                    await queue.drain();
                    if (hardTimeoutReached) return;
                    queue.printSummary();
                    activeQueue = null;

                    if (research) {
                        fs.writeFileSync(researchOutput, JSON.stringify(nextDevResearchMap, null, 4));
                        printMsg(
                            MSG.Run,
                            "[✓] Research mode enabled. Technique efficiency written to " + researchOutput
                        );
                    }

                    await extractSourceMaps(output, join(output, sourcemapDir));
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
                if (hardTimeoutReached) return;

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
