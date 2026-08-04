import makeRequest from "../../utility/makeReq.js";
import * as cheerio from "cheerio";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import * as lazyLoadGlobals from "../globals.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

// <script type="..."> values known to hold non-JS content. Browsers never execute
// these as script — WordPress/plugins routinely stash JSON-LD structured data or
// browser resource-hint configs in a bare <script> tag with no src, and saving
// that content as a .js file breaks any JS parser later run against it (Babel
// can't parse a top-level JSON object as a JS Program).
const NON_JS_SCRIPT_TYPES = [
    "application/ld+json",
    "application/json",
    "speculationrules",
    "importmap",
    "text/template",
    "text/x-template",
    "text/x-handlebars-template",
    "text/x-jquery-tmpl",
    "text/ng-template",
    "text/html",
];

/**
 * Whether a <script type="..."> value indicates the tag's content should be
 * treated as JS. Missing/empty type defaults to JS per the HTML spec. Deliberately
 * permissive for unrecognized types (e.g. Cloudflare Rocket Loader rewrites
 * type="text/javascript" to a randomized "<hash>-text/javascript" to defer
 * execution — still real JS) — only the known non-JS types above are excluded.
 */
export const isLikelyJsScriptType = (type: string | undefined): boolean => {
    if (!type) return true;
    const normalized = type.trim().toLowerCase();
    if (!normalized) return true;
    if (normalized.includes("javascript") || normalized === "module" || normalized.includes("ecmascript")) {
        return true;
    }
    return !NON_JS_SCRIPT_TYPES.some((t) => normalized.includes(t));
};

/**
 * Decodes a data: URI script src (e.g. `data:text/javascript;base64,...`) into
 * its JS source text. Returns null if the URI doesn't match the expected shape
 * or the payload can't be decoded.
 */
export const decodeDataUriScript = (dataUri: string): string | null => {
    const match = /^data:([^,]*),([\s\S]*)$/.exec(dataUri);
    if (!match) return null;
    const [, meta, payload] = match;
    const isBase64 = /;base64$/i.test(meta);
    try {
        return isBase64 ? Buffer.from(payload, "base64").toString("utf-8") : decodeURIComponent(payload);
    } catch {
        return null;
    }
};

/**
 * Extracts JS chunk URLs from <script src> and <link rel="modulepreload"> tags,
 * and saves inline <script> bodies (inline text and decoded data: URIs) to disk.
 * Every saved file carries a `// File Source: <url>` header — this is what lets
 * generic_stringsDiscovery.ts later resolve string-literal JS paths found inside
 * these files against the URL they actually came from. Mirrors react_getScriptTags.ts
 * — the same seeding pattern applies to any site regardless of framework.
 */
const generic_getScriptTags = async (
    url: string,
    maxJsSizeMb: number,
    outputDir?: string
): Promise<{ urls: string[]; pageSource: string }> => {
    let toReturn: string[] = [];

    const req = await makeRequest(url);
    const pageSource = req ? await req.text() : "";

    const $ = cheerio.load(pageSource);
    const host = new URL(url).host.replace(":", "_");
    // Mirrors the page's own path, not just its host — so inline scripts from
    // different pages of a multi-page generic crawl (internal#66) land in
    // separate directories instead of colliding on inline-0.js, inline-1.js, etc.
    const pageDir = new URL(url).pathname;
    let inlineIndex = 0;

    $("script").each((_, elem) => {
        const src = $(elem).attr("src");
        if (src) {
            let resolved: URL;
            try {
                resolved = new URL(src, url);
            } catch {
                return;
            }

            // A data: URI script src embeds the JS source directly — it isn't a
            // network-fetchable URL, so pushing it to toReturn would make the
            // downloader try (and fail) to request/save it as a file.
            if (resolved.protocol === "data:") {
                if (!outputDir) return;
                const content = decodeDataUriScript(resolved.href);
                if (!content) return;

                const hostDir = path.join(outputDir, host, pageDir);
                fs.mkdirSync(hostDir, { recursive: true });
                const filename = `inline-${inlineIndex++}.js`;
                const filePath = path.join(hostDir, filename);
                fs.writeFileSync(filePath, `// File Source: ${url} (data URI script #${inlineIndex - 1})\n${content}`);
                lazyLoadGlobals.recordJsFileHash(crypto.createHash("sha256").update(content).digest("hex"));
                printMsg(MSG.Run, `[✓] Saved data URI script to ${filePath}`);
                return;
            }

            // blob:, javascript:, etc — not something we can fetch over the network either.
            if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return;

            toReturn.push(resolved.href);
        } else if (outputDir) {
            if (!isLikelyJsScriptType($(elem).attr("type"))) return;

            const content = $(elem).text().trim();
            if (!content) return;

            const hostDir = path.join(outputDir, host, pageDir);
            fs.mkdirSync(hostDir, { recursive: true });
            const filename = `inline-${inlineIndex++}.js`;
            const filePath = path.join(hostDir, filename);
            fs.writeFileSync(filePath, `// File Source: ${url} (inline script #${inlineIndex - 1})\n${content}`);
            lazyLoadGlobals.recordJsFileHash(crypto.createHash("sha256").update(content).digest("hex"));
            printMsg(MSG.Run, `[✓] Saved inline script to ${filePath}`);
        }
    });

    $("link[rel='modulepreload']").each((_, elem) => {
        const href = $(elem).attr("href");
        if (href) {
            try {
                toReturn.push(new URL(href, url).href);
            } catch {
                /* not a resolvable URL — skip */
            }
        }
    });

    toReturn = [...new Set(toReturn)];
    return { urls: toReturn, pageSource };
};

export default generic_getScriptTags;
