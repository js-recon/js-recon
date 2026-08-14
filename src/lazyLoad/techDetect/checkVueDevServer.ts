/**
 * Distinguishes a Vue.js dev server (`npm run dev` under Vite, or `vue-cli-service serve` under
 * webpack) from a production build, given a cheerio-parsed document that has already matched
 * `checkVueJS` (and not `checkNuxtJS` — Nuxt's own dev server is a separate concern, out of
 * scope here). Two independent bundler tool-chains emit different dev-mode markers:
 *
 * - **Vite** (default for `create-vue` / Vue 3 scaffolds): a `<script type="module" src="...">`
 *   tag whose pathname is `/@vite/client`, or an inline `<script>` block containing
 *   `import.meta.hot`.
 * - **webpack** (`vue-cli`/`@vue/cli-service`, still common on older Vue 2/3 apps): an inline
 *   `<script>` block containing `webpackHotUpdate`, a script/link `src`/`href` (or intercepted
 *   request URL) whose pathname includes `/sockjs-node/` (the HMR WebSocket path), or an
 *   unhashed entry filename (`app.js`, `chunk-vendors.js`) where a production build would emit
 *   a content-hashed name instead (`app.<contenthash>.js`).
 *
 *   The webpack markers are implemented from the dev-server tooling's documented/known output
 *   shape but have not been live-validated against a running `vue-cli`/webpack dev server — no
 *   such app exists in the research workspace (every available Vue test app is Vite-based). The
 *   Vite markers, by contrast, have been confirmed against real running Vite dev servers.
 *
 * All pathname checks are done via the `URL` constructor rather than raw substring/`endsWith`
 * checks on the full `src`/`href` string, so a query string or fragment appended after a marker
 * doesn't produce a false negative, and a malformed value doesn't produce a false positive.
 */
import type { CheerioAPI } from "cheerio";

const UNHASHED_WEBPACK_ENTRY_NAMES = new Set(["app.js", "chunk-vendors.js"]);

const pathnameOf = (raw: string, baseUrl: string): string | undefined => {
    try {
        return new URL(raw, baseUrl).pathname;
    } catch {
        return undefined;
    }
};

const isViteClientPath = (raw: string, baseUrl: string): boolean => pathnameOf(raw, baseUrl) === "/@vite/client";

const isSockjsNodePath = (raw: string, baseUrl: string): boolean => {
    const pathname = pathnameOf(raw, baseUrl);
    return pathname !== undefined && pathname.includes("/sockjs-node/");
};

const isUnhashedWebpackEntryPath = (raw: string, baseUrl: string): boolean => {
    const pathname = pathnameOf(raw, baseUrl);
    if (pathname === undefined) return false;
    const basename = pathname.split("/").pop() ?? "";
    return UNHASHED_WEBPACK_ENTRY_NAMES.has(basename);
};

export const isVueDevServer = ($: CheerioAPI, baseUrl: string, interceptedUrls: string[] = []): boolean => {
    let found = false;

    $("script, link").each((_, el) => {
        if (found) return;
        const src = $(el).attr("src") ?? $(el).attr("href");
        if (!src) return;
        if (
            isViteClientPath(src, baseUrl) ||
            isSockjsNodePath(src, baseUrl) ||
            isUnhashedWebpackEntryPath(src, baseUrl)
        ) {
            found = true;
        }
    });
    if (found) return true;

    $("script:not([src])").each((_, el) => {
        if (found) return;
        const body = $(el).text();
        if (body && (body.includes("import.meta.hot") || body.includes("webpackHotUpdate"))) found = true;
    });
    if (found) return true;

    return interceptedUrls.some((u) => isViteClientPath(u, baseUrl) || isSockjsNodePath(u, baseUrl));
};
