import chalk from "chalk";
import vue_pageSrc from "./vue_pageSrc.js";
import vue_runtimeJs from "./vue_RuntimeJs.js";
import vue_singleJsFileOnHome from "./vue_SingleJsFileOnHome.js";
import vue_severalJsFilesHome from "./vue_severalJsFilesHome.js";
import vue_jsImports from "./vue_jsImports.js";
import vue_reconstructSourceMaps from "./vue_reconstructSourceMaps.js";
import vue_getClientSidePaths from "./vue_getClientSidePaths.js";
import vue_viteMapDeps from "./vue_viteMapDeps.js";
import vue_stringJsFiles from "./vue_stringJsFiles.js";
import { shouldRunMethod } from "../methodFilter.js";

export interface VueDiscoveryResult {
    jsFiles: string[];
    clientSidePaths: string[];
}

/**
 * Runs the full Vue.js JS-file discovery pipeline against a single URL.
 *
 * Combines all the per-URL discovery techniques (page source script tags,
 * runtime.js chunks, single/several JS files on home, import statements,
 * source-map reconstruction) into one reusable flow, and also surfaces the
 * client-side paths found in the discovered files so callers can recurse.
 *
 * @param onFilesDiscovered Called with each batch of newly found URLs so the
 *   caller can start downloading them immediately rather than waiting for the
 *   full pipeline to finish.
 */
const vue_discoverJsFiles = async (
    url: string,
    maxJsSizeMb: number = 2,
    onFilesDiscovered?: (files: string[]) => void,
    includeMethods: string[] = [],
    excludeMethods: string[] = [],
    threads: number = 1
): Promise<VueDiscoveryResult> => {
    let jsFiles: string[] = [];

    const inc = includeMethods;
    const exc = excludeMethods;

    const normalize = (f: string) => (f.startsWith("//") ? "https:" + f : f);
    const countNew = (files: string[], before: Set<string>): number =>
        files.filter((f) => !before.has(normalize(f))).length;

    const emit = (files: string[]) => {
        jsFiles.push(...files);
        if (files.length > 0 && onFilesDiscovered) {
            onFilesDiscovered(files.map((f) => (f.startsWith("//") ? "https:" + f : f)));
        }
    };

    // first, get all the JS files from the page source
    if (shouldRunMethod("vue_pageSrc", inc, exc)) {
        emit(await vue_pageSrc(url));
    }

    // method 1: through runtime.<hash>.js
    if (shouldRunMethod("vue_RuntimeJs", inc, exc)) {
        emit(await vue_runtimeJs(url));
    }

    // single JS file on the page (typically dev-mode)
    if (shouldRunMethod("vue_SingleJsFileOnHome", inc, exc)) {
        const beforeSingleJs = new Set(jsFiles.map(normalize));
        const fromSingleJs = await vue_singleJsFileOnHome(url);
        emit(fromSingleJs);
        const newSingleJs = countNew(fromSingleJs, beforeSingleJs);
        if (newSingleJs > 0) {
            console.log(chalk.green(`[✓] Found ${newSingleJs} new files from the single JS file on home`));
        }
    }

    // several JS files referenced directly on the page
    if (shouldRunMethod("vue_severalJsFilesHome", inc, exc)) {
        emit(await vue_severalJsFilesHome(url));
    }

    // scan page-loaded JS files for Vite's __vite__mapDeps chunk manifest
    if (shouldRunMethod("vue_viteMapDeps", inc, exc)) {
        const beforeViteMapDeps = new Set(jsFiles.map(normalize));
        const fromViteMapDeps = await vue_viteMapDeps(jsFiles, maxJsSizeMb, threads);
        emit(fromViteMapDeps);
        const newViteMapDeps = countNew(fromViteMapDeps, beforeViteMapDeps);
        if (newViteMapDeps > 0) {
            console.log(chalk.green(`[✓] Found ${newViteMapDeps} new files from __vite__mapDeps`));
        }
    }

    // walk the import graph of everything found so far
    if (shouldRunMethod("vue_jsImports", inc, exc)) {
        const beforeJsImports = new Set(jsFiles.map(normalize));
        const fromImports = await vue_jsImports(url, jsFiles, maxJsSizeMb, threads);
        emit(fromImports);
        const newJsImports = countNew(fromImports, beforeJsImports);
        if (newJsImports > 0) {
            console.log(chalk.green(`[✓] Found ${newJsImports} new files from import statements`));
        }
    }

    // scan string literals inside known JS files for .js references
    if (shouldRunMethod("vue_stringJsFiles", inc, exc)) {
        const beforeStringRefs = new Set(jsFiles.map(normalize));
        const fromStringRefs = await vue_stringJsFiles(jsFiles, maxJsSizeMb, threads);
        emit(fromStringRefs);
        const newStringRefs = countNew(fromStringRefs, beforeStringRefs);
        if (newStringRefs > 0) {
            console.log(chalk.green(`[✓] Found ${newStringRefs} new files from string literal JS references`));
        }
    }

    // reconstruct sourceMappingURL references
    if (shouldRunMethod("vue_reconstructSourceMaps", inc, exc)) {
        const beforeSourceMaps = new Set(jsFiles.map(normalize));
        const fromSourceMaps = await vue_reconstructSourceMaps(url, jsFiles, threads);
        emit(fromSourceMaps);
        const newSourceMaps = countNew(fromSourceMaps, beforeSourceMaps);
        if (newSourceMaps > 0) {
            console.log(chalk.green(`[✓] Found ${newSourceMaps} new files from reconstructing source maps`));
        }
    }

    jsFiles = [...new Set(jsFiles)].map((f) => (f.startsWith("//") ? "https:" + f : f));

    // surface client-side paths so the caller can recurse into them
    let clientSidePaths: string[] = [];
    if (shouldRunMethod("vue_getClientSidePaths", inc, exc)) {
        clientSidePaths = await vue_getClientSidePaths(url, jsFiles, maxJsSizeMb, threads);
    }

    return { jsFiles, clientSidePaths: [...new Set(clientSidePaths)] };
};

export default vue_discoverJsFiles;
