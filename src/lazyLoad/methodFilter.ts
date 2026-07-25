/**
 * Method name registry and filtering utilities for the lazyload module.
 * Method names match their source file names (without .ts extension).
 */
export const FRAMEWORK_METHODS: Record<string, string[]> = {
    next_js: [
        "next_GetJSScript",
        "next_GetLazyResourcesBuildManifestJs",
        "next_GetLazyResourcesWebpackJs",
        "next_SubsequentRequests",
        "next_scriptTagsSubsequentRequests",
        "next_promiseResolve",
        "next_parseLayoutJs",
        "next_bruteForceJsFiles",
        "next_getClientSidePaths",
    ],
    vue: [
        "vue_discoverJsFiles",
        "vue_recursiveClientSidePathDownload",
        "vue_stringJsFiles",
        "vue_getClientSidePaths",
        "vue_pageSrc",
        "vue_reconstructSourceMaps",
        "vue_RuntimeJs",
        "vue_viteMapDeps",
        "vue_sourcemapExtract",
        "vue_jsImports",
        "vue_severalJsFilesHome",
        "vue_SingleJsFileOnHome",
    ],
    nuxt_js: ["nuxt_getFromPageSource", "nuxt_stringAnalysisJSFiles", "nuxt_astParse"],
    svelte: [
        "svelte_getFromPageSource",
        "svelte_getVersionJson",
        "svelte_stringAnalysisJSFiles",
        "svelte_recursivePageCrawl",
        "svelte_discoverPagesFromJs",
    ],
    angular: ["angular_getFromPageSource", "angular_getFromMainJs", "angular_recursiveChunkImports"],
    react: ["react_getScriptTags", "react_webpackChunkPaths", "react_sourcemapUrls", "react_followImports"],
};

export const VALID_METHODS: string[] = Object.values(FRAMEWORK_METHODS).flat();

export const shouldRunMethod = (name: string, include: string[], exclude: string[]): boolean => {
    if (include.length > 0) return include.includes(name);
    if (exclude.length > 0) return !exclude.includes(name);
    return true;
};
