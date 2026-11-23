import type * as cheerio from "cheerio";

// Distribution file names of the React / Vue builds meant for a plain <script> tag
// (UMD / IIFE globals), e.g. react.development.js, react-dom.production.min.js,
// vue.global.prod.js, vue.min.js, or anything under a /umd/ directory.
const GLOBAL_BUILD_FILE =
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored, bounded optional groups
    /(?:^|\/)(?:react|react-dom|vue)(?:\.runtime)?(?:\.global)?(?:\.(?:development|production|prod))?(?:\.min)?\.js$/i;
const UMD_DIR = /\/umd\/react(?:-dom)?[^/]*\.js$/i;
const WEBPACK_RUNTIME = /webpackChunk|__webpack_require__/;

/**
 * True when the page loads React or Vue as a global script build (no bundler): a
 * global-build file is referenced and nothing on the page looks bundled (no ES-module
 * scripts, no modulepreload, no inline webpack runtime). Such sites are server-rendered
 * multi-page sites, which only the generic crawler covers — the framework crawlers read
 * the entry page's bundle graph and never visit other pages.
 */
export const isGlobalBuildOnly = ($: cheerio.CheerioAPI): boolean => {
    if ($('script[type="module"], link[rel="modulepreload"]').length > 0) return false;

    let hasGlobalBuild = false;
    for (const el of $("script").get()) {
        const src = $(el).attr("src");
        if (src) {
            let path: string;
            try {
                path = new URL(src, "http://x/").pathname;
            } catch {
                continue;
            }
            if (GLOBAL_BUILD_FILE.test(path) || UMD_DIR.test(path)) hasGlobalBuild = true;
        } else if (WEBPACK_RUNTIME.test($(el).text())) {
            return false;
        }
    }
    return hasGlobalBuild;
};
