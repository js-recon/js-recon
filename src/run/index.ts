import endpoints from "../endpoints/index.js";
import strings from "../strings/index.js";
import map from "../map/index.js";
import * as globalsUtil from "../utility/globals.js";
import * as fs from "fs";
import lazyLoad from "../lazyLoad/index.js";
import chalk from "chalk";
import CONFIG from "../globalConfig.js";
import analyze from "../analyze/index.js";
import report from "../report/index.js";
import refactor from "../refactor/index.js";
import initGlobalReportDb from "../report/utility/initGlobalReportDb.js";
import mergeDomainIntoGlobalDb from "../report/utility/mergeDomainIntoGlobalDb.js";
import { clearJsUrls, clearJsonUrls, clearJsFileHashCounts, getJsUrls } from "../lazyLoad/globals.js";
import path from "path";
import {
    installSigintHandler,
    removeSigintHandler,
    getSkipStepPromise,
    resetSkipStep,
    shouldSkipTarget,
    resetSkipTarget,
    waitForPendingInterrupt,
} from "./interruptHandler.js";
import { detectBundler } from "./bundler-detect.js";
import { printMsg, MSG, setHeaderListener } from "../utility/printMsg.js";
import configureProxy from "../utility/configureProxy.js";
import { getOxylabsFallbackConfiguration } from "../proxy/oxylabsFallback.js";
import { probeFeasibility } from "../proxy/checkFeasibility.js";
import { getResolvedProxyConfigFromGlobals } from "../utility/makeReq.js";
import { resolveHostOutputDirectory } from "../lazyLoad/outputPath.js";
import { awaitCancellableStep } from "./cancellableStep.js";
import { resolveTargetInputs } from "../utility/targetInputs.js";
import { clearRunOutputDirectory, getBatchTargetDirectoryName, reserveRunOutputDirectory } from "./outputDirectory.js";
import { startDashboardServer } from "./dashboard/server.js";
import * as dashboardState from "./dashboard/state.js";

/**
 * Determines the directory for a Content Delivery Network (CDN) if used by the target.
 *
 * Checks if any of the downloaded JavaScript files are from a different host, which
 * indicates a CDN is in use. This is important for modules that rely on code analysis.
 *
 * @param host - The host of the target URL
 * @param outputDir - The base output directory
 * @returns Promise that resolves to the path of the CDN directory or undefined if no CDN is detected
 */
const getCdnDir = async (host: string, outputDir: string, isBatch: boolean): Promise<string | undefined> => {
    // get the JS URLs
    let cdnDir: string | undefined;
    for (const url of getJsUrls()) {
        if (url.includes("_next/static/chunks")) {
            // check if the host and url.host match
            const urlHost = new URL(url).host; // e.g. example.com:8443
            const initialHost = new URL(host).host; // e.g. example.com:443
            if (urlHost !== initialHost) {
                cdnDir = resolveHostOutputDirectory(outputDir, urlHost, isBatch);
                break;
            }
        }
    }
    return cdnDir;
};

/**
 * Processes a single URL through the entire js-recon analysis pipeline.
 *
 * This function orchestrates the execution of all modules in sequence:
 * 1. Lazyload - Downloads JavaScript files
 * 2. Strings - Extracts endpoints and secrets
 * 3. Map - Analyzes functions and generates mappings
 * 4. Endpoints - Extracts client-side endpoints
 * 5. Analyze - Runs security analysis rules
 * 6. Report - Generates final analysis report
 *
 * @param url - The URL to analyze
 * @param outputDir - The directory for downloaded content (e.g., JS files)
 * @param workingDir - The directory for storing analysis results and reports
 * @param cmd - The command-line options object
 * @param isBatch - Whether this is part of a batch process, affecting file path resolution
 * @returns Promise that resolves when the analysis for the URL is complete
 */
const processUrl = async (
    url: string,
    outputDir: string,
    workingDir: string,
    cmd: any,
    isBatch: boolean,
    includeMethods: string[] = [],
    excludeMethods: string[] = []
): Promise<void> => {
    const targetHost = new URL(url).host;
    globalsUtil.setTargetUrl(url);

    printMsg(MSG.Run, `[+] Starting analysis for ${url}...`);

    if (isBatch) {
        clearJsUrls();
        clearJsonUrls();
        clearJsFileHashCounts();
        globalsUtil.clearOpenapiOutput();
    }

    if (cmd.proxyWafFallback && cmd._proxyConfigured) {
        globalsUtil.setUseProxy(true); // reset in case a previous target's fallback check disabled it
        const resolved = getResolvedProxyConfigFromGlobals();
        let outcome;
        try {
            outcome = await probeFeasibility(resolved, url);
        } catch (error) {
            printMsg(
                MSG.Err,
                `[!] Proxy WAF fallback check failed: ${error}. ${isBatch ? "Skipping this target." : "Quitting."}`
            );
            if (isBatch) return;
            process.exit(29);
        }
        printMsg(outcome.code === 0 ? MSG.Run : MSG.Warn, outcome.message);
        if (outcome.code === 27) {
            // no firewall detected without a proxy - don't use it for this target
            globalsUtil.setUseProxy(false);
        } else if (outcome.code === 28) {
            printMsg(
                MSG.Err,
                `[!] Proxy could not bypass the firewall for this target. ${isBatch ? "Skipping this target." : "Quitting."}`
            );
            if (isBatch) return;
            process.exit(29);
        }
        // outcome.code === 0: firewall present, proxy bypasses it - keep using the proxy
    }

    printMsg(MSG.Header, "[1/8] Running lazyload to download JavaScript files...");
    resetSkipStep();
    try {
        await awaitCancellableStep(
            (signal) =>
                lazyLoad(
                    url,
                    outputDir,
                    cmd.strictScope,
                    cmd.scope.split(","),
                    cmd.threads,
                    false,
                    "",
                    cmd.insecure,
                    false,
                    cmd.sourcemapDir,
                    cmd.research,
                    cmd.researchOutput,
                    Number(cmd.maxIterations),
                    Number(cmd.maxJsSize),
                    Number(cmd.lazyloadTimeout) * 60 * 1000,
                    Number(cmd.maxPages),
                    includeMethods,
                    excludeMethods,
                    Number(cmd.detectionTimeout) * 1000,
                    signal,
                    isBatch,
                    Number(cmd.maxRedirects),
                    cmd.strings,
                    Number(cmd.stringsMaxIterations),
                    Number(cmd.stagnationTimein) * 60 * 1000,
                    Number(cmd.stagnationPercentage),
                    Number(cmd.stagnationMonitor) * 60 * 1000,
                    Number(cmd.rscParamBruteforceLimit),
                    cmd.wordlist
                ),
            getSkipStepPromise()
        );
    } catch (error) {
        printMsg(MSG.Err, `[!] Lazyload step failed: ${error}. ${isBatch ? "Skipping this target." : "Quitting."}`);
        if (isBatch) return;
        process.exit(33);
    }
    printMsg(MSG.Run, "[+] Lazyload complete.");
    if (shouldSkipTarget()) return;

    if (globalsUtil.getTech() === "") {
        printMsg(MSG.Err, `[!] Technology not detected. ${isBatch ? "Skipping this target." : "Quitting."}`);
        if (isBatch) {
            return;
        }
        process.exit(10);
    }

    if (
        ![
            "next",
            "next-dev",
            "vue",
            "vue-dev",
            "nuxt",
            "nuxt-dev",
            "react",
            "react-dev",
            "svelte",
            "svelte-dev",
            "angular",
            "angular-dev",
        ].includes(globalsUtil.getTech())
    ) {
        printMsg(
            MSG.Warn,
            `[!] The tool supports Next.JS, Vue.JS, Nuxt.JS, React, Svelte/Astro, and Angular in the run module. For ${globalsUtil.getTech()}, only downloading JS files is supported`
        );
        return;
    }

    // Capture the tech here — subsequent lazyload passes (steps 3, 4.5) re-run framework
    // detection and may reset the global to "" if the site doesn't expose framework signals
    // on the second crawl. Using the captured value ensures map and analyze always receive
    // the tech that was confirmed in step 1.
    const detectedTech = globalsUtil.getTech();
    // Dev-server bundles are still standard modules for their respective bundler — map/analyze
    // reuse the prod tech logic wholesale rather than duplicating it under a second branch.
    // Kept as a distinct global tech value everywhere else (output labeling, bundler/refactor
    // detection, benchmark/bug-report separation per js-recon-internal-docs#137 and #190) so
    // next-dev's / vue-dev's discovery coverage isn't silently conflated with the
    // already-benchmarked prod pipelines.
    const mapAnalyzeTech =
        detectedTech === "next-dev"
            ? "next"
            : detectedTech === "vue-dev"
              ? "vue"
              : detectedTech === "react-dev"
                ? "react"
                : detectedTech === "svelte-dev"
                  ? "svelte"
                  : detectedTech === "angular-dev"
                    ? "angular"
                    : detectedTech;

    if (detectedTech === "react" || detectedTech === "react-dev") {
        const mappedFileReact = isBatch ? `${workingDir}/mapped` : "mapped";
        const mappedJsonFileReact = isBatch ? `${workingDir}/mapped.json` : "mapped.json";
        const openapiFile = isBatch ? `${workingDir}/mapped-openapi.json` : "mapped-openapi.json";
        const analyzeFile = isBatch ? `${workingDir}/analyze.json` : "analyze.json";
        const reportDbFile = isBatch ? `${workingDir}/js-recon.db` : "js-recon.db";
        const reportFile = isBatch ? `${workingDir}/report` : "report";
        const endpointsFile = isBatch ? `${workingDir}/endpoints` : "endpoints";

        printMsg(MSG.Header, "[2/4] Running map to find functions and API calls...");
        globalsUtil.setOpenapi(true);
        if (isBatch) {
            globalsUtil.setOpenapiOutputFile(openapiFile);
        }
        for (const ext of [".json", "-openapi.json", "-openapi.postman_collection.json"]) {
            const p = `${mappedFileReact}${ext}`;
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }
        resetSkipStep();
        await Promise.race([
            map(outputDir, mappedFileReact, ["json"], mapAnalyzeTech, false, false, cmd.command || []),
            getSkipStepPromise(),
        ]);
        printMsg(MSG.Run, "[+] Map complete.");
        if (shouldSkipTarget()) return;

        printMsg(MSG.Header, "[3/4] Running analyze...");
        resetSkipStep();
        await Promise.race([
            analyze(
                cmd.rules || "",
                mappedJsonFileReact,
                mapAnalyzeTech as "next" | "vue" | "react" | "svelte" | "angular",
                false,
                openapiFile,
                false,
                analyzeFile,
                !!cmd.disableRulesVersionCheck,
                false,
                false
            ),
            getSkipStepPromise(),
        ]);
        printMsg(MSG.Run, "[+] Analyze complete.");
        if (shouldSkipTarget()) return;

        printMsg(MSG.Header, "[4/4] Running report module...");
        const endpointsJson = `${endpointsFile}.json`;
        if (!fs.existsSync(endpointsJson)) {
            fs.writeFileSync(endpointsJson, "[]");
        }
        resetSkipStep();
        await Promise.race([
            report(
                reportDbFile,
                mappedJsonFileReact,
                analyzeFile,
                endpointsJson,
                openapiFile,
                reportFile,
                cmd.sj,
                cmd.sjBin,
                cmd.sjArgs
            ),
            getSkipStepPromise(),
        ]);
        printMsg(MSG.Run, "[+] Report complete.");
        if (shouldSkipTarget()) return;

        if (!cmd.disableRefactor) {
            printMsg(MSG.Header, "[*] Detecting bundler via CS-MAST-S for refactor...");
            const detectedBundlerTechReact = await detectBundler(
                mappedJsonFileReact,
                mapAnalyzeTech,
                Number(cmd.csMastTechDetectThreshold ?? 50)
            );
            if (detectedBundlerTechReact) {
                const refactorOutputDirReact = isBatch ? `${workingDir}/refactored` : "refactored";
                if (fs.existsSync(refactorOutputDirReact)) fs.rmSync(refactorOutputDirReact, { recursive: true });
                printMsg(MSG.Header, `[*] Running refactor (${detectedBundlerTechReact})...`);
                // Vendor chunks may have been downloaded under a different host than the target
                // (CDN) — resolve the assets dir from an actual downloaded JS URL's host instead
                // of always assuming targetHost, mirroring getCdnDir's approach for the map step.
                let reactAssetsHostDir = targetHost;
                for (const jsUrl of getJsUrls()) {
                    const jsUrlHost = new URL(jsUrl).host;
                    if (jsUrlHost !== targetHost) {
                        reactAssetsHostDir = jsUrlHost;
                        break;
                    }
                }
                resetSkipStep();
                await Promise.race([
                    refactor(
                        mappedJsonFileReact,
                        refactorOutputDirReact,
                        detectedBundlerTechReact,
                        false,
                        undefined,
                        undefined,
                        path.join(resolveHostOutputDirectory(outputDir, reactAssetsHostDir, isBatch), "assets")
                    ),
                    getSkipStepPromise(),
                ]);
                if (shouldSkipTarget()) return;
                printMsg(MSG.Run, "[+] Refactor complete.");
            } else {
                printMsg(MSG.Warn, "[!] Bundler not detected via CS-MAST-S, skipping refactor.");
            }
        } else {
            printMsg(MSG.Warn, "[!] Refactor step disabled via --disable-refactor, skipping.");
        }

        printMsg(MSG.Run, `[+] Analysis complete for ${url}.`);
        return;
    }

    if (detectedTech === "vue" || detectedTech === "vue-dev") {
        // Vue.JS pipeline: lazyload (done) + map + analyze + report.
        // Scan the whole download directory: Vue builds frequently spread chunks
        // across multiple asset hosts, and relative imports resolve within each tree.
        // vue-dev (Vite dev server) reuses this pipeline wholesale — map/analyze operate on
        // plain ES modules either way; see js-recon-internal-docs#190 for the research spike
        // confirming coverage. All map/analyze/report calls below pass the literal "vue" tech
        // string regardless of detectedTech, matching next-dev's mapAnalyzeTech precedent.
        const mappedFileVue = isBatch ? `${workingDir}/mapped` : "mapped";
        const mappedJsonFileVue = isBatch ? `${workingDir}/mapped.json` : "mapped.json";
        const openapiFile = isBatch ? `${workingDir}/mapped-openapi.json` : "mapped-openapi.json";
        const analyzeFile = isBatch ? `${workingDir}/analyze.json` : "analyze.json";
        const reportDbFile = isBatch ? `${workingDir}/js-recon.db` : "js-recon.db";
        const reportFile = isBatch ? `${workingDir}/report` : "report";
        const endpointsFile = isBatch ? `${workingDir}/endpoints` : "endpoints";

        printMsg(MSG.Header, "[2/4] Running map to find functions and API calls...");
        globalsUtil.setOpenapi(true);
        if (isBatch) {
            globalsUtil.setOpenapiOutputFile(openapiFile);
        }
        for (const ext of [".json", "-openapi.json", "-openapi.postman_collection.json"]) {
            const p = `${mappedFileVue}${ext}`;
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }
        resetSkipStep();
        await Promise.race([
            map(outputDir, mappedFileVue, ["json"], "vue", false, false, cmd.command || []),
            getSkipStepPromise(),
        ]);
        printMsg(MSG.Run, "[+] Map complete.");
        if (shouldSkipTarget()) return;

        printMsg(MSG.Header, "[3/4] Running analyze...");
        resetSkipStep();
        await Promise.race([
            analyze(
                cmd.rules || "",
                mappedJsonFileVue,
                "vue",
                false,
                openapiFile,
                false,
                analyzeFile,
                !!cmd.disableRulesVersionCheck,
                false,
                false
            ),
            getSkipStepPromise(),
        ]);
        printMsg(MSG.Run, "[+] Analyze complete.");
        if (shouldSkipTarget()) return;

        printMsg(MSG.Header, "[4/4] Running report module...");
        // Endpoints extraction isn't implemented for Vue yet; pass an empty file if absent.
        const endpointsJson = `${endpointsFile}.json`;
        if (!fs.existsSync(endpointsJson)) {
            fs.writeFileSync(endpointsJson, "[]");
        }
        resetSkipStep();
        await Promise.race([
            report(
                reportDbFile,
                mappedJsonFileVue,
                analyzeFile,
                endpointsJson,
                openapiFile,
                reportFile,
                cmd.sj,
                cmd.sjBin,
                cmd.sjArgs
            ),
            getSkipStepPromise(),
        ]);
        printMsg(MSG.Run, "[+] Report complete.");
        if (shouldSkipTarget()) return;

        if (!cmd.disableRefactor) {
            printMsg(MSG.Header, "[*] Detecting bundler via CS-MAST-S for refactor...");
            const detectedBundlerTechVue = await detectBundler(
                mappedJsonFileVue,
                "vue",
                Number(cmd.csMastTechDetectThreshold ?? 50)
            );
            if (detectedBundlerTechVue) {
                const refactorOutputDirVue = isBatch ? `${workingDir}/refactored` : "refactored";
                if (fs.existsSync(refactorOutputDirVue)) fs.rmSync(refactorOutputDirVue, { recursive: true });
                printMsg(MSG.Header, `[*] Running refactor (${detectedBundlerTechVue})...`);
                resetSkipStep();
                await Promise.race([
                    refactor(mappedJsonFileVue, refactorOutputDirVue, detectedBundlerTechVue, false),
                    getSkipStepPromise(),
                ]);
                if (shouldSkipTarget()) return;
                printMsg(MSG.Run, "[+] Refactor complete.");
            } else {
                printMsg(MSG.Warn, "[!] Bundler not detected via CS-MAST-S, skipping refactor.");
            }
        } else {
            printMsg(MSG.Warn, "[!] Refactor step disabled via --disable-refactor, skipping.");
        }

        printMsg(MSG.Run, `[+] Analysis complete for ${url}.`);
        return;
    }

    if (detectedTech === "nuxt" || detectedTech === "nuxt-dev") {
        // Nuxt is built on Vue.js — the same map/analyze/report pipeline applies.
        const mappedFileNuxt = isBatch ? `${workingDir}/mapped` : "mapped";
        const mappedJsonFileNuxt = isBatch ? `${workingDir}/mapped.json` : "mapped.json";
        const openapiFile = isBatch ? `${workingDir}/mapped-openapi.json` : "mapped-openapi.json";
        const analyzeFile = isBatch ? `${workingDir}/analyze.json` : "analyze.json";
        const reportDbFile = isBatch ? `${workingDir}/js-recon.db` : "js-recon.db";
        const reportFile = isBatch ? `${workingDir}/report` : "report";
        const endpointsFile = isBatch ? `${workingDir}/endpoints` : "endpoints";

        printMsg(MSG.Header, "[2/4] Running map to find functions and API calls...");
        globalsUtil.setOpenapi(true);
        if (isBatch) {
            globalsUtil.setOpenapiOutputFile(openapiFile);
        }
        for (const ext of [".json", "-openapi.json", "-openapi.postman_collection.json"]) {
            const p = `${mappedFileNuxt}${ext}`;
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }
        resetSkipStep();
        await Promise.race([
            map(outputDir, mappedFileNuxt, ["json"], "vue", false, false, cmd.command || []),
            getSkipStepPromise(),
        ]);
        printMsg(MSG.Run, "[+] Map complete.");
        if (shouldSkipTarget()) return;

        printMsg(MSG.Header, "[3/4] Running analyze...");
        resetSkipStep();
        await Promise.race([
            analyze(
                cmd.rules || "",
                mappedJsonFileNuxt,
                "vue",
                false,
                openapiFile,
                false,
                analyzeFile,
                !!cmd.disableRulesVersionCheck,
                false,
                false
            ),
            getSkipStepPromise(),
        ]);
        printMsg(MSG.Run, "[+] Analyze complete.");
        if (shouldSkipTarget()) return;

        printMsg(MSG.Header, "[4/4] Running report module...");
        const endpointsJson = `${endpointsFile}.json`;
        if (!fs.existsSync(endpointsJson)) {
            fs.writeFileSync(endpointsJson, "[]");
        }
        resetSkipStep();
        await Promise.race([
            report(
                reportDbFile,
                mappedJsonFileNuxt,
                analyzeFile,
                endpointsJson,
                openapiFile,
                reportFile,
                cmd.sj,
                cmd.sjBin,
                cmd.sjArgs
            ),
            getSkipStepPromise(),
        ]);
        printMsg(MSG.Run, "[+] Report complete.");
        if (shouldSkipTarget()) return;

        if (!cmd.disableRefactor) {
            printMsg(MSG.Header, "[*] Detecting bundler via CS-MAST-S for refactor...");
            const detectedBundlerTechNuxt = await detectBundler(
                mappedJsonFileNuxt,
                "nuxt",
                Number(cmd.csMastTechDetectThreshold ?? 50)
            );
            if (detectedBundlerTechNuxt) {
                const refactorOutputDirNuxt = isBatch ? `${workingDir}/refactored` : "refactored";
                if (fs.existsSync(refactorOutputDirNuxt)) fs.rmSync(refactorOutputDirNuxt, { recursive: true });
                printMsg(MSG.Header, `[*] Running refactor (${detectedBundlerTechNuxt})...`);
                resetSkipStep();
                await Promise.race([
                    refactor(mappedJsonFileNuxt, refactorOutputDirNuxt, detectedBundlerTechNuxt, false),
                    getSkipStepPromise(),
                ]);
                if (shouldSkipTarget()) return;
                printMsg(MSG.Run, "[+] Refactor complete.");
            } else {
                printMsg(MSG.Warn, "[!] Bundler not detected via CS-MAST-S, skipping refactor.");
            }
        } else {
            printMsg(MSG.Warn, "[!] Refactor step disabled via --disable-refactor, skipping.");
        }

        printMsg(MSG.Run, `[+] Analysis complete for ${url}.`);
        return;
    }

    if (detectedTech === "svelte" || detectedTech === "svelte-dev") {
        const mappedFileSvelte = isBatch ? `${workingDir}/mapped` : "mapped";
        const mappedJsonFileSvelte = isBatch ? `${workingDir}/mapped.json` : "mapped.json";
        const openapiFile = isBatch ? `${workingDir}/mapped-openapi.json` : "mapped-openapi.json";
        const analyzeFile = isBatch ? `${workingDir}/analyze.json` : "analyze.json";
        const reportDbFile = isBatch ? `${workingDir}/js-recon.db` : "js-recon.db";
        const reportFile = isBatch ? `${workingDir}/report` : "report";
        const endpointsFile = isBatch ? `${workingDir}/endpoints` : "endpoints";

        printMsg(MSG.Header, "[2/4] Running map to find functions and API calls...");
        globalsUtil.setOpenapi(true);
        if (isBatch) {
            globalsUtil.setOpenapiOutputFile(openapiFile);
        }
        for (const ext of [".json", "-openapi.json", "-openapi.postman_collection.json"]) {
            const p = `${mappedFileSvelte}${ext}`;
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }
        resetSkipStep();
        await Promise.race([
            map(outputDir, mappedFileSvelte, ["json"], "svelte", false, false, cmd.command || []),
            getSkipStepPromise(),
        ]);
        printMsg(MSG.Run, "[+] Map complete.");
        if (shouldSkipTarget()) return;

        printMsg(MSG.Header, "[3/4] Running analyze...");
        resetSkipStep();
        await Promise.race([
            analyze(
                cmd.rules || "",
                mappedJsonFileSvelte,
                "svelte",
                false,
                openapiFile,
                false,
                analyzeFile,
                !!cmd.disableRulesVersionCheck,
                false,
                false
            ),
            getSkipStepPromise(),
        ]);
        printMsg(MSG.Run, "[+] Analyze complete.");
        if (shouldSkipTarget()) return;

        printMsg(MSG.Header, "[4/4] Running report module...");
        const endpointsJson = `${endpointsFile}.json`;
        if (!fs.existsSync(endpointsJson)) {
            fs.writeFileSync(endpointsJson, "[]");
        }
        resetSkipStep();
        await Promise.race([
            report(
                reportDbFile,
                mappedJsonFileSvelte,
                analyzeFile,
                endpointsJson,
                openapiFile,
                reportFile,
                cmd.sj,
                cmd.sjBin,
                cmd.sjArgs
            ),
            getSkipStepPromise(),
        ]);
        printMsg(MSG.Run, "[+] Report complete.");

        printMsg(MSG.Run, `[+] Analysis complete for ${url}.`);
        return;
    }

    if (detectedTech === "angular" || detectedTech === "angular-dev") {
        // Angular pipeline: lazyload (done) + map + analyze + report.
        // Angular CLI (esbuild) chunks land directly under output/<host>/ with no
        // static/js subdirectory, so we scan the whole host dir.
        const mappedFileAngular = isBatch ? `${workingDir}/mapped` : "mapped";
        const mappedJsonFileAngular = isBatch ? `${workingDir}/mapped.json` : "mapped.json";
        const openapiFile = isBatch ? `${workingDir}/mapped-openapi.json` : "mapped-openapi.json";
        const analyzeFile = isBatch ? `${workingDir}/analyze.json` : "analyze.json";
        const reportDbFile = isBatch ? `${workingDir}/js-recon.db` : "js-recon.db";
        const reportFile = isBatch ? `${workingDir}/report` : "report";
        const endpointsFile = isBatch ? `${workingDir}/endpoints` : "endpoints";

        const angularHostDir = resolveHostOutputDirectory(outputDir, targetHost, isBatch);

        printMsg(MSG.Header, "[2/4] Running map to find functions and API calls...");
        globalsUtil.setOpenapi(true);
        if (isBatch) {
            globalsUtil.setOpenapiOutputFile(openapiFile);
        }
        for (const ext of [".json", "-openapi.json", "-openapi.postman_collection.json"]) {
            const p = `${mappedFileAngular}${ext}`;
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }
        resetSkipStep();
        await Promise.race([
            map(angularHostDir, mappedFileAngular, ["json"], "angular", false, false, cmd.command || []),
            getSkipStepPromise(),
        ]);
        printMsg(MSG.Run, "[+] Map complete.");
        if (shouldSkipTarget()) return;

        printMsg(MSG.Header, "[3/4] Running analyze...");
        resetSkipStep();
        await Promise.race([
            analyze(
                cmd.rules || "",
                mappedJsonFileAngular,
                "angular",
                false,
                openapiFile,
                false,
                analyzeFile,
                !!cmd.disableRulesVersionCheck,
                false,
                false
            ),
            getSkipStepPromise(),
        ]);
        printMsg(MSG.Run, "[+] Analyze complete.");
        if (shouldSkipTarget()) return;

        printMsg(MSG.Header, "[4/4] Running report module...");
        const endpointsJson = `${endpointsFile}.json`;
        if (!fs.existsSync(endpointsJson)) {
            fs.writeFileSync(endpointsJson, "[]");
        }
        resetSkipStep();
        await Promise.race([
            report(
                reportDbFile,
                mappedJsonFileAngular,
                analyzeFile,
                endpointsJson,
                openapiFile,
                reportFile,
                cmd.sj,
                cmd.sjBin,
                cmd.sjArgs
            ),
            getSkipStepPromise(),
        ]);
        printMsg(MSG.Run, "[+] Report complete.");

        printMsg(MSG.Run, `[+] Analysis complete for ${url}.`);
        return;
    }

    const stringsFile = isBatch ? `${workingDir}/strings.json` : "strings.json";
    const extractedUrlsFile = isBatch ? `${workingDir}/extracted_urls` : "extracted_urls";
    const mappedFile = isBatch ? `${workingDir}/mapped` : "mapped";
    const mappedJsonFile = isBatch ? `${workingDir}/mapped.json` : "mapped.json";
    const endpointsFile = isBatch ? `${workingDir}/endpoints` : "endpoints";
    const openapiFile = isBatch ? `${workingDir}/mapped-openapi.json` : "mapped-openapi.json";
    const analyzeFile = isBatch ? `${workingDir}/analyze.json` : "analyze.json";
    const reportDbFile = isBatch ? `${workingDir}/js-recon.db` : "js-recon.db";
    const reportFile = isBatch ? `${workingDir}/report` : "report";

    // if the target is using a CDN, then just passing the outputDir/host won't work, and would throw an error.
    // So, if the target was found to be using a CDN, scan the CDN directory rather than the outputDir/host
    // One IMPORTANT thing: this is only meant for modules that rely on just the code (map)
    const cdnDir = await getCdnDir(url, outputDir, isBatch);
    const cdnOutputDir = cdnDir ? cdnDir : resolveHostOutputDirectory(outputDir, targetHost, isBatch);

    printMsg(MSG.Header, "[2/8] Running strings to extract endpoints...");
    resetSkipStep();
    await Promise.race([
        strings(outputDir, stringsFile, true, extractedUrlsFile, false, false, false, false),
        getSkipStepPromise(),
    ]);
    printMsg(MSG.Run, "[+] Strings complete.");
    if (shouldSkipTarget()) return;

    printMsg(MSG.Header, "[3/8] Running lazyload with subsequent requests to download JavaScript files...");
    resetSkipStep();
    await awaitCancellableStep(
        (signal) =>
            lazyLoad(
                url,
                outputDir,
                cmd.strictScope,
                cmd.scope.split(","),
                cmd.threads,
                true,
                `${extractedUrlsFile}.json`,
                cmd.insecure,
                true,
                cmd.sourcemapDir,
                cmd.research,
                cmd.researchOutput,
                Number(cmd.maxIterations),
                Number(cmd.maxJsSize),
                Number(cmd.lazyloadTimeout) * 60 * 1000,
                Number(cmd.maxPages),
                includeMethods,
                excludeMethods,
                Number(cmd.detectionTimeout) * 1000,
                signal,
                isBatch,
                Number(cmd.maxRedirects),
                cmd.strings,
                Number(cmd.stringsMaxIterations),
                Number(cmd.stagnationTimein) * 60 * 1000,
                Number(cmd.stagnationPercentage),
                Number(cmd.stagnationMonitor) * 60 * 1000,
                Number(cmd.rscParamBruteforceLimit),
                cmd.wordlist
            ),
        getSkipStepPromise()
    );
    printMsg(MSG.Run, "[+] Lazyload with subsequent requests complete.");
    if (shouldSkipTarget()) return;

    printMsg(MSG.Header, "[4/8] Running strings again to extract endpoints...");
    resetSkipStep();
    await Promise.race([
        strings(
            outputDir,
            stringsFile,
            true,
            extractedUrlsFile,
            cmd.secrets,
            true,
            true,
            cmd.trufflehog,
            cmd.trufflehogBin,
            cmd.trufflehogAcceptTerms
        ),
        getSkipStepPromise(),
    ]);
    printMsg(MSG.Run, "[+] Strings complete.");
    if (shouldSkipTarget()) return;

    // a second subsequent_requests pass: the first strings pass only sees initial chunks,
    // so dynamic routes such as `/post/1` are only discovered after the first subsequent
    // crawl + second strings extraction. Re-running subsequent_requests with the freshly
    // updated paths picks up chunks for those dynamic routes (e.g. the post page).
    printMsg(MSG.Header, "[4.5/8] Re-running lazyload with subsequent requests for newly discovered paths...");
    resetSkipStep();
    await awaitCancellableStep(
        (signal) =>
            lazyLoad(
                url,
                outputDir,
                cmd.strictScope,
                cmd.scope.split(","),
                cmd.threads,
                true,
                `${extractedUrlsFile}.json`,
                cmd.insecure,
                false,
                cmd.sourcemapDir,
                cmd.research,
                cmd.researchOutput,
                Number(cmd.maxIterations),
                Number(cmd.maxJsSize),
                Number(cmd.lazyloadTimeout) * 60 * 1000,
                Number(cmd.maxPages),
                includeMethods,
                excludeMethods,
                Number(cmd.detectionTimeout) * 1000,
                signal,
                isBatch,
                Number(cmd.maxRedirects),
                cmd.strings,
                Number(cmd.stringsMaxIterations),
                Number(cmd.stagnationTimein) * 60 * 1000,
                Number(cmd.stagnationPercentage),
                Number(cmd.stagnationMonitor) * 60 * 1000,
                Number(cmd.rscParamBruteforceLimit),
                cmd.wordlist
            ),
        getSkipStepPromise()
    );
    printMsg(MSG.Run, "[+] Lazyload re-pass complete.");
    if (shouldSkipTarget()) return;

    printMsg(MSG.Header, "[4.6/8] Re-running strings for chunks from the re-pass...");
    resetSkipStep();
    await Promise.race([
        strings(
            outputDir,
            stringsFile,
            true,
            extractedUrlsFile,
            cmd.secrets,
            true,
            true,
            cmd.trufflehog,
            cmd.trufflehogBin,
            cmd.trufflehogAcceptTerms
        ),
        getSkipStepPromise(),
    ]);
    printMsg(MSG.Run, "[+] Strings re-pass complete.");
    if (shouldSkipTarget()) return;

    printMsg(MSG.Header, "[5/8] Running map to find functions...");
    globalsUtil.setOpenapi(true);
    if (isBatch) {
        globalsUtil.setOpenapiOutputFile(openapiFile);
    }
    // Delete stale map artifacts so map always regenerates from the current target's output.
    // Without this, a leftover mapped.json from a previous run would be reused, causing
    // resolveFetch to look for files from the wrong target's directory.
    for (const ext of [".json", "-openapi.json", "-openapi.postman_collection.json"]) {
        const p = `${mappedFile}${ext}`;
        if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    resetSkipStep();
    await Promise.race([
        map(cdnOutputDir, mappedFile, ["json"], mapAnalyzeTech, false, false, cmd.command || []),
        getSkipStepPromise(),
    ]);
    printMsg(MSG.Run, "[+] Map complete.");
    if (shouldSkipTarget()) return;

    printMsg(MSG.Header, "[6/8] Running endpoints to extract endpoints...");
    resetSkipStep();
    const targetOutputDir = resolveHostOutputDirectory(outputDir, targetHost, isBatch);
    if (fs.existsSync(path.join(targetOutputDir, "___subsequent_requests"))) {
        await Promise.race([
            endpoints(url, targetOutputDir, endpointsFile, ["json"], "next", false, mappedJsonFile),
            getSkipStepPromise(),
        ]);
    } else {
        await Promise.race([
            endpoints(url, undefined, endpointsFile, ["json"], "next", false, mappedJsonFile),
            getSkipStepPromise(),
        ]);
    }
    printMsg(MSG.Run, "[+] Endpoints complete.");
    if (shouldSkipTarget()) return;

    printMsg(MSG.Header, "[7/8] Running analyze to extract endpoints...");
    resetSkipStep();
    await Promise.race([
        analyze(
            cmd.rules || "",
            mappedJsonFile,
            mapAnalyzeTech as "next" | "vue" | "svelte" | "angular" | "react",
            false,
            openapiFile,
            false,
            analyzeFile,
            !!cmd.disableRulesVersionCheck,
            false,
            false
        ),
        getSkipStepPromise(),
    ]);
    printMsg(MSG.Run, "[+] Analyze complete.");
    if (shouldSkipTarget()) return;

    printMsg(MSG.Header, "[8/8] Running report module...");
    resetSkipStep();
    await Promise.race([
        report(
            reportDbFile,
            mappedJsonFile,
            analyzeFile,
            `${endpointsFile}.json`,
            openapiFile,
            reportFile,
            cmd.sj,
            cmd.sjBin,
            cmd.sjArgs
        ),
        getSkipStepPromise(),
    ]);
    printMsg(MSG.Run, "[+] Report complete.");
    if (shouldSkipTarget()) return;

    if (!cmd.disableRefactor) {
        printMsg(MSG.Header, "[*] Detecting bundler via CS-MAST-S for refactor...");
        const detectedBundlerTechNext = await detectBundler(
            mappedJsonFile,
            detectedTech,
            Number(cmd.csMastTechDetectThreshold ?? 50)
        );
        if (detectedBundlerTechNext) {
            const refactorOutputDirNext = isBatch ? `${workingDir}/refactored` : "refactored";
            if (fs.existsSync(refactorOutputDirNext)) fs.rmSync(refactorOutputDirNext, { recursive: true });
            printMsg(MSG.Header, `[*] Running refactor (${detectedBundlerTechNext})...`);
            resetSkipStep();
            await Promise.race([
                refactor(mappedJsonFile, refactorOutputDirNext, detectedBundlerTechNext, false),
                getSkipStepPromise(),
            ]);
            if (shouldSkipTarget()) return;
            printMsg(MSG.Run, "[+] Refactor complete.");
        } else {
            printMsg(MSG.Warn, "[!] Bundler not detected via CS-MAST-S, skipping refactor.");
        }
    } else {
        printMsg(MSG.Warn, "[!] Refactor step disabled via --disable-refactor, skipping.");
    }

    printMsg(MSG.Run, `[+] Analysis complete for ${url}.`);
};

/**
 * Main handler for the 'run' command that executes the complete js-recon analysis pipeline.
 *
 * Sets up global configuration and determines whether to process a single URL or
 * a file containing multiple URLs. For batch processing, creates organized directory
 * structure and processes each URL sequentially.
 *
 * @param cmd - The command-line options object from commander.js
 * @returns Promise that resolves when all URL processing is complete
 */
/**
 * Parses a batch/single `cmd.url` into the `{ url, hostDir, dir }` entries the
 * dashboard state store needs, mirroring the hostDir/dir resolution the batch
 * loop and single-target path use below. Invalid URLs are dropped — they're
 * reported (and skipped) by the existing validation further down.
 */
const buildDashboardTargetEntries = (cmd: any, isBatch: boolean) => {
    const toEntry = (url: string, dir: string) => {
        try {
            return { url, hostDir: new URL(url).host.replace(":", "_"), dir };
        } catch {
            return null;
        }
    };

    if (!isBatch) {
        const entry = toEntry(cmd.url, cmd.output);
        return entry ? [entry] : [];
    }

    return fs
        .readFileSync(cmd.url, "utf-8")
        .split("\n")
        .filter((url) => url !== "")
        .map((url) => toEntry(url, `${cmd.output}/${new URL(url).host.replace(":", "_")}`))
        .filter((e): e is { url: string; hostDir: string; dir: string } => e !== null);
};

export default async (cmd: any): Promise<void> => {
    const resolvedTargets = resolveTargetInputs(cmd.url);
    configureProxy(cmd);
    if (getOxylabsFallbackConfiguration().enabled) globalsUtil.setUseProxy(false);
    // Snapshot the originally-configured proxy state so `processUrl`'s --proxy-waf-fallback check
    // can reset it before each target in batch mode, regardless of what a previous target left it as.
    globalsUtil.setDisableCache(cmd.disableCache);
    globalsUtil.setRespCacheFile(cmd.cacheFile);
    globalsUtil.setYes(cmd.yes);

    const outputOverwrite = cmd.outputOverwrite === true;
    const outputReservation = reserveRunOutputDirectory(cmd.output, outputOverwrite);
    const isBatch = resolvedTargets.isBatch;
    const runCommand = Object.freeze({
        ...cmd,
        output: outputReservation.path,
        _proxyConfigured: globalsUtil.getUseProxy(),
    });
    if (outputReservation.redirected) {
        console.log(
            chalk.yellow(
                `[i] Output directory ${cmd.output} is already occupied; using ${outputReservation.path} instead.`
            )
        );
    }
    if (outputOverwrite && outputReservation.occupied) {
        console.log(chalk.yellow(`[!] Output directory ${runCommand.output} already exists. Overwriting it.`));
        clearRunOutputDirectory(runCommand.output);
    }

    installSigintHandler(isBatch);

    let dashboard: { port: number; url: string; stop: () => Promise<void> } | null = null;
    if (cmd.webStatsDashboard) {
        dashboardState.registerTargets(buildDashboardTargetEntries(cmd, isBatch));
        dashboard = await startDashboardServer(Number(cmd.webStatsPort));
        printMsg(MSG.Run, `[+] Web stats dashboard running at ${dashboard.url}`);
        setHeaderListener((msg) => dashboardState.markStep(msg));
    }

    try {
        if (!isBatch) {
            if (cmd.webStatsDashboard) {
                dashboardState.setCurrentUrl(resolvedTargets.targets[0]);
                dashboardState.markRunning(resolvedTargets.targets[0]);
            }
            try {
                await processUrl(
                    resolvedTargets.targets[0],
                    runCommand.output,
                    ".",
                    runCommand,
                    false,
                    runCommand._includeMethods ?? [],
                    runCommand._excludeMethods ?? []
                );
                if (cmd.webStatsDashboard) dashboardState.markCompleted(resolvedTargets.targets[0]);
            } catch (e) {
                if (cmd.webStatsDashboard)
                    dashboardState.markError(resolvedTargets.targets[0], e instanceof Error ? e.message : String(e));
                throw e;
            }
        } else {
            const globalDbPath = `${runCommand.output}/js-recon.db`;
            await initGlobalReportDb(globalDbPath);
            const targetHosts = resolvedTargets.targets.map((target) => new URL(target).host);
            const hostFrequencies = targetHosts.reduce<Map<string, number>>(
                (frequencies, host) => new Map(frequencies).set(host, (frequencies.get(host) ?? 0) + 1),
                new Map()
            );

            for (const url of resolvedTargets.targets) {
                resetSkipTarget();

                const urlObj = new URL(url);
                let hostDir = getBatchTargetDirectoryName(url, (hostFrequencies.get(urlObj.host) ?? 0) > 1);
                const requestedTargetDir = path.join(runCommand.output, hostDir);
                const targetReservation = reserveRunOutputDirectory(requestedTargetDir, outputOverwrite);
                const thisTargetDir = targetReservation.path;
                hostDir = path.basename(thisTargetDir);
                if (outputOverwrite && targetReservation.occupied) {
                    console.log(chalk.yellow(`[!] Output directory ${thisTargetDir} already exists. Overwriting it.`));
                    clearRunOutputDirectory(thisTargetDir);
                } else if (targetReservation.redirected) {
                    console.log(chalk.yellow(`[i] Target output already exists; using ${thisTargetDir} for ${url}.`));
                }

                if (cmd.webStatsDashboard && dashboardState.isSkipRequested(url)) {
                    printMsg(MSG.Warn, `[!] Skipping ${url} (skipped from the web dashboard).`);
                    dashboardState.markSkipped(url);
                    targetReservation.release();
                    continue;
                }

                if (cmd.webStatsDashboard) {
                    dashboardState.setCurrentUrl(url);
                    dashboardState.markRunning(url);
                }
                try {
                    try {
                        await processUrl(
                            url,
                            thisTargetDir,
                            thisTargetDir,
                            runCommand,
                            true,
                            runCommand._includeMethods ?? [],
                            runCommand._excludeMethods ?? []
                        );
                        if (cmd.webStatsDashboard) {
                            if (shouldSkipTarget()) dashboardState.markSkipped(url);
                            else dashboardState.markCompleted(url);
                        }
                    } catch (error) {
                        if (cmd.webStatsDashboard)
                            dashboardState.markError(url, error instanceof Error ? error.message : String(error));
                        printMsg(MSG.Err, `[!] Unhandled error while processing ${url}: ${error}`);
                        process.exitCode = 1;
                        continue;
                    }

                    const domainDbPath = `${thisTargetDir}/js-recon.db`;
                    if (fs.existsSync(domainDbPath)) {
                        try {
                            mergeDomainIntoGlobalDb(globalDbPath, domainDbPath, hostDir);
                        } catch (error) {
                            printMsg(MSG.Warn, `[!] Failed to merge ${hostDir} into the global js-recon.db: ${error}`);
                        }
                    } else {
                        printMsg(
                            MSG.Warn,
                            `[i] No js-recon.db found for ${hostDir}, skipping merge into the global database.`
                        );
                    }
                } finally {
                    targetReservation.release();
                }
            }
        }
    } catch (error) {
        printMsg(MSG.Err, `[!] Unhandled error: ${error}`);
        process.exitCode = 1;
    } finally {
        if (dashboard) {
            setHeaderListener(null);
            await dashboard.stop();
        }
        try {
            await waitForPendingInterrupt();
        } finally {
            removeSigintHandler();
            outputReservation.release();
        }
        process.exit(process.exitCode ?? 0);
    }
};
