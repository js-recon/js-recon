import endpoints from "../endpoints/index.js";
import strings from "../strings/index.js";
import map from "../map/index.js";
import * as globalsUtil from "../utility/globals.js";
import * as fs from "fs";
import lazyLoad from "../lazyLoad/index.js";
import CONFIG from "../globalConfig.js";
import analyze from "../analyze/index.js";
import report from "../report/index.js";
import refactor from "../refactor/index.js";
import { clearJsUrls, clearJsonUrls, clearJsFileHashCounts, getJsUrls } from "../lazyLoad/globals.js";
import path from "path";
import {
    installSigintHandler,
    removeSigintHandler,
    getSkipStepPromise,
    resetSkipStep,
    shouldSkipTarget,
    resetSkipTarget,
} from "./interruptHandler.js";
import { detectBundler } from "./bundler-detect.js";
import { printMsg, MSG } from "../utility/printMsg.js";

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
const getCdnDir = async (host: string, outputDir: string): Promise<string | undefined> => {
    // get the JS URLs
    let cdnDir: string | undefined;
    for (const url of getJsUrls()) {
        if (url.includes("_next/static/chunks")) {
            // check if the host and url.host match
            const urlHostDir = new URL(url).host.replace(":", "_"); // e.g. example.com_8443
            const urlHost = new URL(url).host; // e.g. example.com:8443
            const initialHost = new URL(host).host; // e.g. example.com:443
            if (urlHost !== initialHost) {
                cdnDir = path.join(outputDir, urlHostDir);
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
    const targetHost = new URL(url).host.replace(":", "_");

    printMsg(MSG.Run, `[+] Starting analysis for ${url}...`);

    if (isBatch) {
        clearJsUrls();
        clearJsonUrls();
        clearJsFileHashCounts();
        globalsUtil.clearOpenapiOutput();
    }

    printMsg(MSG.Header, "[1/8] Running lazyload to download JavaScript files...");
    resetSkipStep();
    await Promise.race([
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
            Number(cmd.maxRedirects),
            cmd.strings,
            Number(cmd.stringsMaxIterations),
            Number(cmd.stagnationTimein) * 60 * 1000,
            Number(cmd.stagnationPercentage),
            Number(cmd.stagnationMonitor) * 60 * 1000
        ),
        getSkipStepPromise(),
    ]);
    printMsg(MSG.Run, "[+] Lazyload complete.");
    if (shouldSkipTarget()) return;

    if (globalsUtil.getTech() === "") {
        printMsg(MSG.Err, `[!] Technology not detected. ${isBatch ? "Skipping this target." : "Quitting."}`);
        if (isBatch) {
            return;
        }
        process.exit(10);
    }

    if (!["next", "vue", "nuxt", "react", "svelte", "angular"].includes(globalsUtil.getTech())) {
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

    if (detectedTech === "react") {
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
            map(outputDir, mappedFileReact, ["json"], "react", false, false, cmd.command || []),
            getSkipStepPromise(),
        ]);
        printMsg(MSG.Run, "[+] Map complete.");
        if (shouldSkipTarget()) return;

        printMsg(MSG.Header, "[3/4] Running analyze...");
        resetSkipStep();
        // @ts-ignore
        await Promise.race([
            analyze(
                cmd.rules || "",
                mappedJsonFileReact,
                "react",
                false,
                openapiFile,
                false,
                analyzeFile,
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

        printMsg(MSG.Header, "[*] Detecting bundler via CS-MAST-S for refactor...");
        const detectedBundlerTechReact = await detectBundler(
            mappedJsonFileReact,
            "react",
            Number(cmd.csMastTechDetectThreshold ?? 50)
        );
        if (detectedBundlerTechReact) {
            const refactorOutputDirReact = isBatch ? `${workingDir}/refactored` : "refactored";
            if (fs.existsSync(refactorOutputDirReact)) fs.rmSync(refactorOutputDirReact, { recursive: true });
            printMsg(MSG.Header, `[*] Running refactor (${detectedBundlerTechReact})...`);
            resetSkipStep();
            await Promise.race([
                refactor(mappedJsonFileReact, refactorOutputDirReact, detectedBundlerTechReact, false),
                getSkipStepPromise(),
            ]);
            if (shouldSkipTarget()) return;
            printMsg(MSG.Run, "[+] Refactor complete.");
        } else {
            printMsg(MSG.Warn, "[!] Bundler not detected via CS-MAST-S, skipping refactor.");
        }

        printMsg(MSG.Run, `[+] Analysis complete for ${url}.`);
        return;
    }

    if (detectedTech === "vue") {
        // Vue.JS pipeline: lazyload (done) + map + analyze + report.
        // Scan the whole download directory: Vue builds frequently spread chunks
        // across multiple asset hosts, and relative imports resolve within each tree.
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
        // @ts-ignore
        await Promise.race([
            analyze(cmd.rules || "", mappedJsonFileVue, "vue", false, openapiFile, false, analyzeFile, false, false),
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

        printMsg(MSG.Run, `[+] Analysis complete for ${url}.`);
        return;
    }

    if (detectedTech === "nuxt") {
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
        // @ts-ignore
        await Promise.race([
            analyze(cmd.rules || "", mappedJsonFileNuxt, "vue", false, openapiFile, false, analyzeFile, false, false),
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

        printMsg(MSG.Run, `[+] Analysis complete for ${url}.`);
        return;
    }

    if (detectedTech === "svelte") {
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
        // @ts-ignore
        await Promise.race([
            analyze(
                cmd.rules || "",
                mappedJsonFileSvelte,
                "svelte",
                false,
                openapiFile,
                false,
                analyzeFile,
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

    if (detectedTech === "angular") {
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

        const angularHostDir = `${outputDir}/${targetHost}`;

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
        // @ts-ignore
        await Promise.race([
            analyze(
                cmd.rules || "",
                mappedJsonFileAngular,
                "angular",
                false,
                openapiFile,
                false,
                analyzeFile,
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
    const cdnDir = await getCdnDir(url, outputDir);
    const cdnOutputDir = cdnDir ? cdnDir : outputDir + "/" + targetHost;

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
    await Promise.race([
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
            Number(cmd.maxRedirects),
            cmd.strings,
            Number(cmd.stringsMaxIterations),
            Number(cmd.stagnationTimein) * 60 * 1000,
            Number(cmd.stagnationPercentage),
            Number(cmd.stagnationMonitor) * 60 * 1000
        ),
        getSkipStepPromise(),
    ]);
    printMsg(MSG.Run, "[+] Lazyload with subsequent requests complete.");
    if (shouldSkipTarget()) return;

    printMsg(MSG.Header, "[4/8] Running strings again to extract endpoints...");
    resetSkipStep();
    await Promise.race([
        strings(outputDir, stringsFile, true, extractedUrlsFile, cmd.secrets, true, true, cmd.trufflehog),
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
    await Promise.race([
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
            Number(cmd.maxRedirects),
            cmd.strings,
            Number(cmd.stringsMaxIterations),
            Number(cmd.stagnationTimein) * 60 * 1000,
            Number(cmd.stagnationPercentage),
            Number(cmd.stagnationMonitor) * 60 * 1000
        ),
        getSkipStepPromise(),
    ]);
    printMsg(MSG.Run, "[+] Lazyload re-pass complete.");
    if (shouldSkipTarget()) return;

    printMsg(MSG.Header, "[4.6/8] Re-running strings for chunks from the re-pass...");
    resetSkipStep();
    await Promise.race([
        strings(outputDir, stringsFile, true, extractedUrlsFile, cmd.secrets, true, true, cmd.trufflehog),
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
        map(cdnOutputDir, mappedFile, ["json"], detectedTech, false, false, cmd.command || []),
        getSkipStepPromise(),
    ]);
    printMsg(MSG.Run, "[+] Map complete.");
    if (shouldSkipTarget()) return;

    printMsg(MSG.Header, "[6/8] Running endpoints to extract endpoints...");
    resetSkipStep();
    if (fs.existsSync(`${outputDir}/${targetHost}/___subsequent_requests`)) {
        await Promise.race([
            endpoints(url, `${outputDir}/${targetHost}/`, endpointsFile, ["json"], "next", false, mappedJsonFile),
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
        // @ts-ignore
        analyze(cmd.rules || "", mappedJsonFile, detectedTech, false, openapiFile, false, analyzeFile, false, false),
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
export default async (cmd: any): Promise<void> => {
    globalsUtil.setApiGatewayConfigFile(cmd.apiGatewayConfig);
    globalsUtil.setUseApiGateway(cmd.apiGateway);
    globalsUtil.setDisableCache(cmd.disableCache);
    globalsUtil.setRespCacheFile(cmd.cacheFile);
    globalsUtil.setYes(cmd.yes);

    const isBatch = fs.existsSync(cmd.url);
    installSigintHandler(isBatch);

    try {
        // check if the given URL is a file
        if (!isBatch) {
            // check if output directory exists. If so, ask the user to switch to other directory
            // if not done, it might conflict this process
            // for devs: run `npm run cleanup` to prepare this directory
            if (fs.existsSync(cmd.output)) {
                printMsg(
                    MSG.Err,
                    `[!] Output directory ${cmd.output} already exists. Please switch to other directory or it might conflict with this process.`
                );
                printMsg(
                    MSG.Warn,
                    `[i] For advanced users: use the individual modules separately. See docs at ${CONFIG.modulesDocs}`
                );
                process.exit(11);
            }

            try {
                new URL(cmd.url);
            } catch (e) {
                printMsg(MSG.Err, `[!] Invalid URL: ${cmd.url}`);
                process.exit(12);
            }

            await processUrl(
                cmd.url,
                cmd.output,
                ".",
                cmd,
                false,
                cmd._includeMethods ?? [],
                cmd._excludeMethods ?? []
            );
        } else {
            // since this is a file, we need to first load the URLs in the memory remove empty strings
            const urls = fs
                .readFileSync(cmd.url, "utf-8")
                .split("\n")
                .filter((url) => url !== "");

            if (!fs.existsSync(cmd.output)) {
                fs.mkdirSync(cmd.output, { recursive: true });
            }

            for (const url of urls) {
                resetSkipTarget();

                // Validate URL only
                let urlObj;
                try {
                    urlObj = new URL(url);
                } catch {
                    printMsg(MSG.Err, `[!] Invalid URL: ${url}`);
                    continue;
                }

                const hostDir = urlObj.host.replace(":", "_");
                const thisTargetDir = `${cmd.output}/${hostDir}`;

                if (fs.existsSync(thisTargetDir)) {
                    printMsg(MSG.Err, `[!] Output directory ${thisTargetDir} already exists. Skipping ${url}.`);
                    printMsg(
                        MSG.Warn,
                        `[i] For advanced users: use the individual modules separately. See docs at ${CONFIG.modulesDocs}`
                    );
                    continue;
                }

                fs.mkdirSync(thisTargetDir, { recursive: true });
                await processUrl(
                    url,
                    thisTargetDir,
                    thisTargetDir,
                    cmd,
                    true,
                    cmd._includeMethods ?? [],
                    cmd._excludeMethods ?? []
                );
            }
        }
    } finally {
        removeSigintHandler();
        process.exit(process.exitCode ?? 0);
    }
};
