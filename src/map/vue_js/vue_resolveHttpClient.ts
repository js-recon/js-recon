import { printMsg, MSG } from "../../utility/printMsg.js";
import parser from "@babel/parser";
import _traverse from "@babel/traverse";
import fs from "fs";
import path from "path";
import { resolveNodeValue, substituteVariablesInString } from "../next_js/utils.js";
import * as globals from "../../utility/globals.js";
import {
    EnclosingFn,
    inferEnclosingFn,
    substituteCallerPlaceholders,
    substituteCallerHeaders,
    makeGetCallers,
    enclosingFnChainHasBinding,
    GetCallersFn,
} from "./taint_utils.js";
import { deepResolveValue, hasMarkers, resolveParamToAnyValue, deepSubstituteBodyValue } from "./bodyResolver.js";
import { substituteCrossFileMarkers, substituteCrossFileMarkersDeep } from "./crossFileResolver.js";

const stripAstNodes = (fn: EnclosingFn | null): EnclosingFn | null => {
    if (!fn) return null;
    const root: EnclosingFn = { ...fn, node: null };
    let cur: EnclosingFn = root;
    let src: EnclosingFn | null | undefined = fn.parent;
    while (src) {
        cur.parent = { ...src, node: null };
        cur = cur.parent;
        src = src.parent;
    }
    return root;
};

const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;

const HTTP_VERBS = new Set(["get", "post", "put", "delete", "patch", "head", "options"]);

interface HttpCallEntry {
    file: string;
    filePath: string;
    fileLine: number;
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
    /**
     * Structured form of `body` when the request body resolves to an object.
     * Preserved separately so taint substitution can rewrite leaf-string
     * markers (`[param:X]`, `[member:P.X]`, …) without parsing JSON.
     */
    bodyValue?: any;
    enclosingFn: EnclosingFn | null;
}

/**
 * Heuristic: only treat a resolved string as a URL if, after stripping every
 * `[…]` placeholder produced by resolveNodeValue, the remaining literal text
 * still contains a `/` separator or an explicit scheme. This rejects calls on
 * Map/Set/Headers/EventBus (`x.get("key")`, `bus.post(event)`) while keeping
 * partial URLs like `[call:base()]<literal>/[param:e]/[param:t]`.
 */
const looksLikeUrl = (s: string): boolean => {
    if (!s) return false;
    if (s.startsWith("http://") || s.startsWith("https://")) return true;
    const stripped = s.replace(/\[[^\]]*\]/g, "");
    return stripped.includes("/");
};

/**
 * Recovers `[unresolved: NAME]` placeholders by chasing later assignments to
 * NAME within the enclosing function. Pattern: `let ue; …; ue = e + "/" + t;`
 * — babel's binding has no `init`, so resolveNodeValue returns the unresolved
 * marker. The assignment shows up under `binding.constantViolations`.
 *
 * Iterates until no further substitutions are made (an assignment may itself
 * resolve to a string containing more unresolved markers).
 */
/**
 * Enumerates every concrete URL obtainable by substituting `[param:X]`
 * placeholders with the resolved values from each caller of the enclosing
 * function chain. Returns an empty array if no `[param:X]` markers are
 * present (caller falls back to the single-result substituter).
 *
 * Walks up to 5 levels deep to chain across nested wrappers
 * (callback → wrapper → exported method → external caller).
 */
const expandParamPlaceholders = (
    url: string,
    fn: EnclosingFn | null,
    getCallers: GetCallersFn,
    depth = 0,
    deadlineMs: number = Date.now() + 10000,
    capacity: { remaining: number } = { remaining: 150 },
    maxDepth: number = globals.getMaxRecursionDepth()
): string[] => {
    if (depth > maxDepth || typeof url !== "string") return [];
    if (Date.now() > deadlineMs || capacity.remaining <= 0) return [url];
    const all = url.match(/\[param:([A-Za-z_$][\w$]*)\]/g);
    if (!all) return [url];

    // Pick the first placeholder; find the function in the chain that
    // declares it. Then substitute *every* placeholder owned by that same
    // function from a single caller's args, so multi-param URLs like
    // `…/[param:e]/[param:t]` stay consistent across one caller.
    const firstName = all[0].slice("[param:".length, -1);
    let owner: EnclosingFn | null | undefined = fn;
    while (owner && (!owner.bindingName || !(owner.paramNames ?? []).includes(firstName))) {
        owner = owner.parent ?? null;
    }
    if (!owner || !owner.bindingName) return [url];

    const ownerParams = owner.paramNames ?? [];
    const ownedNames = new Set<string>();
    for (const m of all) {
        const n = m.slice("[param:".length, -1);
        if (ownerParams.includes(n)) ownedNames.add(n);
    }

    const allCallers = getCallers(owner.bindingName, owner.file);
    if (!allCallers || allCallers.length === 0) return [url];
    // Cap callers per level to bound work; deeper levels still recurse but the
    // deadline/capacity guards above stop the explosion.
    const callers = allCallers.slice(0, 25);

    const out = new Set<string>();
    for (const caller of callers) {
        if (Date.now() > deadlineMs || capacity.remaining <= 0) break;
        let nextUrl = url;
        let hasArgs = false;
        for (const name of ownedNames) {
            const idx = ownerParams.indexOf(name);
            const arg = caller.args[idx];
            if (!arg) continue;
            hasArgs = true;
            let resolved: any;
            try {
                resolved = resolveNodeValue(arg, caller.scope, "", "fetch", caller.fileContent);
            } catch {
                continue;
            }
            if (resolved === null || resolved === undefined) continue;
            const resolvedStr = typeof resolved === "string" ? resolved : String(resolved);
            nextUrl = nextUrl.split(`[param:${name}]`).join(resolvedStr);
        }
        if (!hasArgs) continue;
        if (!/\[param:/.test(nextUrl)) {
            out.add(nextUrl);
            capacity.remaining--;
        } else {
            const subs = expandParamPlaceholders(
                nextUrl,
                caller.enclosingFn,
                getCallers,
                depth + 1,
                deadlineMs,
                capacity,
                maxDepth
            );
            for (const s of subs) {
                if (capacity.remaining <= 0) break;
                out.add(s);
                capacity.remaining--;
            }
        }
    }
    return out.size === 0 ? [url] : Array.from(out);
};

const UNRESOLVED_IDENT_RE = /\[unresolved: ([A-Za-z_$][\w$]*)\]/g;
const resolveFromAssignments = (s: string, scope: any, fileContent: string): string => {
    if (typeof s !== "string" || !s) return s;
    let prev: string | null = null;
    let out = s;
    let guard = 0;
    while (prev !== out && guard < 6) {
        prev = out;
        guard++;
        out = out.replace(UNRESOLVED_IDENT_RE, (orig, name: string) => {
            try {
                const binding = scope?.getBinding?.(name);
                if (!binding) return orig;
                for (const vp of binding.constantViolations ?? []) {
                    const n = vp.node;
                    if (n?.type !== "AssignmentExpression" || n.operator !== "=") continue;
                    if (n.left?.type !== "Identifier" || n.left.name !== name) continue;
                    const r = resolveNodeValue(n.right, vp.scope, "", "fetch", fileContent);
                    if (typeof r === "string" && r.length > 0 && !r.startsWith("[unresolved")) return r;
                }
            } catch {}
            return orig;
        });
    }
    return out;
};

/**
 * Generic HTTP-client call resolver for Vite/webpack bundles where the actual
 * `new XMLHttpRequest()` lives inside a transport library (axios's xhrAdapter,
 * Got, Ky, custom wrappers). At that depth the URL resolves only to
 * `[member:re.url]` from a dispatcher config object, which is useless on its
 * own.
 *
 * Instead we walk every `<obj>.<verb>(<url>, ...)` callsite where <verb> is a
 * known HTTP method name. The URL is resolved through the existing
 * resolveNodeValue + substituteVariablesInString machinery, and the
 * `looksLikeUrl` heuristic filters out unrelated method calls (Map.get,
 * Headers.delete, EventBus.post, …).
 *
 * A second-pass taint analysis walks back to each call's enclosing function
 * callers to substitute [param:X] / [member:P.X] / [urlsearchparams:P.X]
 * placeholders. This is the same chain `vue_resolveXhr` already uses.
 */
const vue_resolveHttpClient = async (directory: string, frameworkName = "Vue.JS"): Promise<void> => {
    printMsg(MSG.Header, `[i] Resolving ${frameworkName} HTTP client method calls`);

    let files: string[];
    try {
        files = fs.readdirSync(directory, { recursive: true, encoding: "utf8" }) as string[];
    } catch {
        printMsg(MSG.Err, `[!] Could not read directory: ${directory}`);
        return;
    }

    files = files
        .filter((f) => (f.endsWith(".js") || f.endsWith(".mjs")) && !f.includes("___subsequent_requests"))
        .filter((f) => !fs.lstatSync(path.join(directory, f)).isDirectory())
        .sort();

    const MAX_MAP_FILE_SIZE_BYTES = 1.5 * 1024 * 1024;
    const MAX_TOTAL_CALLER_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
    let callerTotalBytes = 0;
    const allFilePaths: string[] = [];
    for (const f of files) {
        const fp = path.join(directory, f);
        const sz = fs.statSync(fp).size;
        if (sz > MAX_MAP_FILE_SIZE_BYTES) continue;
        if (callerTotalBytes + sz > MAX_TOTAL_CALLER_SIZE_BYTES) {
            printMsg(
                MSG.Warn,
                `[!] HTTP-client caller lookup capped at 50 MB total — ${files.length - allFilePaths.length} file(s) excluded from taint analysis`
            );
            break;
        }
        callerTotalBytes += sz;
        allFilePaths.push(fp);
    }
    const getCallers = makeGetCallers(allFilePaths);

    const entries: HttpCallEntry[] = [];
    const verbPrefilter = /\.(?:get|post|put|delete|patch|head|options)\s*\(/;
    const scanStartTs = Date.now();
    printMsg(MSG.Header, `[i] Scanning ${files.length} ${frameworkName} JS file(s) for HTTP-client callsites`);
    let lastScanPct = -1;

    for (let _i = 0; _i < files.length; _i++) {
        if (_i > 0 && _i % 50 === 0) await new Promise<void>((r) => setImmediate(r));
        const scanPct = files.length === 0 ? 100 : Math.floor(((_i + 1) * 100) / files.length);
        if (scanPct !== lastScanPct && (scanPct % 10 === 0 || scanPct === 100)) {
            const elapsed = ((Date.now() - scanStartTs) / 1000).toFixed(1);
            printMsg(
                MSG.Info,
                `    [scan] ${scanPct}% (${_i + 1}/${files.length}) entries=${entries.length} elapsed=${elapsed}s`
            );
            lastScanPct = scanPct;
        }

        const file = files[_i];
        const filePath = path.join(directory, file);

        if (fs.statSync(filePath).size > MAX_MAP_FILE_SIZE_BYTES) {
            printMsg(
                MSG.Warn,
                `[!] Skipping ${file} (${(fs.statSync(filePath).size / 1024 / 1024).toFixed(1)} MB > 1.5 MB limit) — HTTP client coverage may be incomplete`
            );
            continue;
        }

        let fileContent: string;
        try {
            fileContent = fs.readFileSync(filePath, "utf-8");
        } catch {
            continue;
        }

        if (!verbPrefilter.test(fileContent)) continue;

        let fileAst: any;
        try {
            fileAst = parser.parse(fileContent, {
                sourceType: "unambiguous",
                plugins: ["jsx", "typescript"],
                errorRecovery: true,
            });
        } catch {
            continue;
        }

        traverse(fileAst, {
            CallExpression(p) {
                const callee = p.node.callee;
                if (callee.type !== "MemberExpression" || callee.computed) return;
                const prop = callee.property;
                if (prop.type !== "Identifier") return;
                const verb = prop.name;
                if (!HTTP_VERBS.has(verb)) return;

                const args = p.node.arguments;
                if (args.length === 0) return;

                const obj = callee.object;
                if (obj.type === "ThisExpression") return;
                if (obj.type === "StringLiteral" || obj.type === "TemplateLiteral") return;

                const rawUrl = resolveNodeValue(args[0], p.scope, "", "fetch", fileContent);
                let url = typeof rawUrl === "string" ? rawUrl : "";
                if (url.includes("[var ") || url.includes("[MemberExpression")) {
                    url = substituteVariablesInString(url, fileContent);
                }
                url = resolveFromAssignments(url, p.scope, fileContent);
                if (!looksLikeUrl(url)) return;

                let body = "";
                let bodyValue: any = undefined;
                const headers: Record<string, string> = {};
                const hasBody = verb === "post" || verb === "put" || verb === "patch";
                const configArgIndex = hasBody ? 2 : 1;

                if (hasBody && args.length >= 2) {
                    bodyValue = deepResolveValue(args[1], p.scope, fileContent);
                    body =
                        bodyValue === null || bodyValue === undefined
                            ? ""
                            : typeof bodyValue === "object"
                              ? JSON.stringify(bodyValue)
                              : String(bodyValue);
                }

                const configArg = args[configArgIndex];
                if (configArg && configArg.type === "ObjectExpression") {
                    for (const cp of configArg.properties) {
                        if (cp.type !== "ObjectProperty") continue;
                        const k =
                            cp.key.type === "Identifier"
                                ? cp.key.name
                                : cp.key.type === "StringLiteral"
                                  ? cp.key.value
                                  : null;
                        if (k !== "headers") continue;
                        if (cp.value.type !== "ObjectExpression") continue;
                        for (const hp of cp.value.properties) {
                            if (hp.type !== "ObjectProperty") continue;
                            const hk =
                                hp.key.type === "Identifier"
                                    ? hp.key.name
                                    : hp.key.type === "StringLiteral"
                                      ? hp.key.value
                                      : null;
                            if (!hk) continue;
                            const rawV = resolveNodeValue(hp.value, p.scope, "", "fetch", fileContent);
                            headers[hk] =
                                typeof rawV === "string"
                                    ? substituteVariablesInString(rawV, fileContent)
                                    : String(rawV ?? "");
                        }
                    }
                }

                const line = p.node.loc?.start.line ?? 0;
                const enclosingFn = stripAstNodes(inferEnclosingFn(p, filePath));

                entries.push({
                    file,
                    filePath,
                    fileLine: line,
                    url,
                    method: verb.toUpperCase(),
                    headers,
                    body,
                    bodyValue,
                    enclosingFn,
                });
            },
        });
    }

    // Taint-analysis second pass — same machinery as vue_resolveXhr.
    const MARKER_RE = /\[(urlsearchparams|member|param):/;
    const headersHaveMarkers = (h: Record<string, string>): boolean => {
        for (const [k, v] of Object.entries(h)) {
            if (k.startsWith("...") && v === "<spread>") return true;
            if (MARKER_RE.test(v)) return true;
        }
        return false;
    };

    // Apply caller-side substitution to every leaf string inside a structured
    // body. Then JSON.stringify the result so it round-trips through the
    // string-typed `body` field. Plain-string bodies fall back to the existing
    // single-pass substituter.
    const substituteBody = (
        entry: HttpCallEntry,
        enclosingFn: EnclosingFn | null
    ): { body: string; bodyValue: any } => {
        if (entry.bodyValue !== undefined && entry.bodyValue !== null && typeof entry.bodyValue === "object") {
            const next = deepSubstituteBodyValue(entry.bodyValue, enclosingFn, getCallers);
            return { body: JSON.stringify(next), bodyValue: next };
        }
        return {
            body: substituteCallerPlaceholders(entry.body, enclosingFn, getCallers),
            bodyValue: entry.bodyValue,
        };
    };

    // Per-caller fan-out: for each caller of the param-owning function,
    // substitute URL + body + headers from that caller's args so each emitted
    // entry carries the body/url pair that THAT specific caller passed
    // (instead of all expanded URLs sharing one body from "the first caller").
    interface Expanded {
        url: string;
        bodyValue: any;
        headers: Record<string, string>;
    }

    const collectParamNames = (s: string, set: Set<string>): void => {
        if (typeof s !== "string") return;
        const m = s.match(/\[param:([A-Za-z_$][\w$]*)\]/g);
        if (!m) return;
        for (const x of m) set.add(x.slice("[param:".length, -1));
    };

    const walkValueForParams = (v: any, set: Set<string>): void => {
        if (v === null || v === undefined) return;
        if (typeof v === "string") collectParamNames(v, set);
        else if (Array.isArray(v)) for (const x of v) walkValueForParams(x, set);
        else if (typeof v === "object") for (const x of Object.values(v)) walkValueForParams(x, set);
    };

    const substituteParamsDeep = (
        value: any,
        subStr: Record<string, string | null>,
        subVal: Record<string, any>,
        owned: Set<string>
    ): any => {
        if (value === null || value === undefined) return value;
        if (typeof value === "string") {
            const exact = value.match(/^\[param:([A-Za-z_$][\w$]*)\]$/);
            if (exact && owned.has(exact[1])) {
                const v = subVal[exact[1]];
                if (v !== undefined) return v;
            }
            let out = value;
            for (const [name, s] of Object.entries(subStr)) {
                if (s === null || s === undefined) continue;
                out = out.split(`[param:${name}]`).join(String(s));
            }
            return out;
        }
        if (Array.isArray(value)) return value.map((v) => substituteParamsDeep(v, subStr, subVal, owned));
        if (typeof value === "object") {
            const o: Record<string, any> = {};
            for (const [k, v] of Object.entries(value)) {
                o[k] = substituteParamsDeep(v, subStr, subVal, owned);
            }
            return o;
        }
        return value;
    };

    // Hard bounds to prevent exponential blowup.
    // depth=2 → up to (callers/level)² forwarding-wrapper chains, enabling
    // resolution through registry-export wrappers like `ae.request → Me`.
    const FANOUT_MAX_DEPTH = 2;
    const FANOUT_MAX_CALLERS_PER_LEVEL = 12;
    const FANOUT_MAX_EXPANSIONS_PER_ENTRY = 80;
    const FANOUT_BUDGET_MS_PER_ENTRY = 1200;

    // Lightweight arg resolver — avoids the deep recursive scope-walking that
    // makes `resolveNodeValue`/`deepResolveValue` expensive (5+s per entry).
    // Only handles the cheap patterns: literals, identifiers bound to literals,
    // simple member chains where the base is a local ObjectExpression literal.
    // Returns null for anything more complex; the outer loop falls back to
    // leaving the [param:X] placeholder unresolved for that caller.
    const lightResolveArg = (node: any, scope: any, depth = 0): { asString: string | null; asValue: any } => {
        if (!node || depth > 3) return { asString: null, asValue: null };
        if (node.type === "StringLiteral") return { asString: node.value, asValue: node.value };
        if (node.type === "NumericLiteral") return { asString: String(node.value), asValue: node.value };
        if (node.type === "BooleanLiteral") return { asString: String(node.value), asValue: node.value };
        if (node.type === "NullLiteral") return { asString: "null", asValue: null };
        if (node.type === "TemplateLiteral" && node.expressions.length === 0 && node.quasis.length === 1) {
            const v = node.quasis[0].value.cooked ?? node.quasis[0].value.raw ?? "";
            return { asString: v, asValue: v };
        }
        if (node.type === "ObjectExpression") {
            // Build a shallow plain-object representation for structured body subst.
            const o: Record<string, any> = {};
            for (const p of node.properties ?? []) {
                if (p.type !== "ObjectProperty") continue;
                const k =
                    p.key.type === "Identifier" ? p.key.name : p.key.type === "StringLiteral" ? p.key.value : null;
                if (!k) continue;
                o[k] = lightResolveArg(p.value, scope, depth + 1).asValue;
            }
            return { asString: null, asValue: o };
        }
        if (node.type === "ArrayExpression") {
            const arr: any[] = [];
            for (const e of node.elements ?? []) {
                arr.push(e ? lightResolveArg(e, scope, depth + 1).asValue : null);
            }
            return { asString: null, asValue: arr };
        }
        if (node.type === "Identifier") {
            try {
                const b = scope?.getBinding?.(node.name);
                const init = b?.path?.node?.init;
                if (init) {
                    return lightResolveArg(init, b.scope ?? scope, depth + 1);
                }
            } catch {}
            return { asString: null, asValue: null };
        }
        if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier") {
            const base = lightResolveArg(node.object, scope, depth + 1);
            if (base.asValue && typeof base.asValue === "object" && node.property.name in base.asValue) {
                const v = base.asValue[node.property.name];
                return { asString: typeof v === "string" ? v : v != null ? String(v) : null, asValue: v };
            }
        }
        return { asString: null, asValue: null };
    };

    const expandEntryAcrossCallers = (
        url: string,
        bodyValue: any,
        headers: Record<string, string>,
        fn: EnclosingFn | null,
        deadlineMs: number,
        capacity: { remaining: number },
        depth = 0
    ): Expanded[] => {
        if (depth > FANOUT_MAX_DEPTH || !fn) return [{ url, bodyValue, headers }];
        if (Date.now() > deadlineMs || capacity.remaining <= 0) return [{ url, bodyValue, headers }];
        const allNames = new Set<string>();
        collectParamNames(url, allNames);
        walkValueForParams(bodyValue, allNames);
        for (const v of Object.values(headers)) collectParamNames(v, allNames);
        for (const k of Object.keys(headers)) collectParamNames(k, allNames);
        if (allNames.size === 0) return [{ url, bodyValue, headers }];

        let owner: EnclosingFn | null | undefined = fn;
        while (owner) {
            const op = owner.paramNames ?? [];
            if (owner.bindingName && [...allNames].some((n) => op.includes(n))) break;
            owner = owner.parent ?? null;
        }
        if (!owner || !owner.bindingName) return [{ url, bodyValue, headers }];

        const ownerParams = owner.paramNames ?? [];
        const owned = new Set<string>([...allNames].filter((n) => ownerParams.includes(n)));
        const allCallers = getCallers(owner.bindingName, owner.file);
        if (!allCallers || allCallers.length === 0) return [{ url, bodyValue, headers }];
        const callers = allCallers.slice(0, FANOUT_MAX_CALLERS_PER_LEVEL);

        // Split owned params by where they appear: only call deepResolveValue
        // (which can walk deeply) when an owned param appears as a bare
        // `[param:X]` LEAF in the structured body. URL/header/string-body
        // substitution only needs resolveNodeValue (string).
        const bodyDeepOwned = new Set<string>();
        const walkBodyForLeaves = (v: any): void => {
            if (v === null || v === undefined) return;
            if (typeof v === "string") {
                const m = v.match(/^\[param:([A-Za-z_$][\w$]*)\]$/);
                if (m && owned.has(m[1])) bodyDeepOwned.add(m[1]);
            } else if (Array.isArray(v)) for (const x of v) walkBodyForLeaves(x);
            else if (typeof v === "object") for (const x of Object.values(v)) walkBodyForLeaves(x);
        };
        walkBodyForLeaves(bodyValue);

        const out: Expanded[] = [];
        for (const caller of callers) {
            if (Date.now() > deadlineMs || capacity.remaining <= 0) break;
            const subStr: Record<string, string | null> = {};
            const subVal: Record<string, any> = {};
            let hasAny = false;
            for (const name of owned) {
                const idx = ownerParams.indexOf(name);
                const arg = caller.args[idx];
                if (!arg) continue;
                hasAny = true;
                // String resolution: use full resolveNodeValue (handles template
                // literals, concat, identifier chains). It's fast — only
                // deepResolveValue is the perf hazard.
                try {
                    const s = resolveNodeValue(arg, caller.scope, "", "fetch", caller.fileContent);
                    subStr[name] = typeof s === "string" ? s : null;
                } catch {
                    subStr[name] = null;
                }
                // Structured body value: only call deepResolveValue if THIS
                // param appears as a bare `[param:X]` leaf in the body — and
                // only within the deadline. Otherwise fall back to the string.
                if (bodyDeepOwned.has(name) && Date.now() < deadlineMs) {
                    try {
                        subVal[name] = deepResolveValue(arg, caller.scope, caller.fileContent);
                    } catch {
                        subVal[name] = subStr[name];
                    }
                } else {
                    subVal[name] = subStr[name];
                }
            }
            if (!hasAny) continue;

            const urlSub = substituteParamsDeep(url, subStr, subVal, owned);
            const bodyValSub = substituteParamsDeep(bodyValue, subStr, subVal, owned);
            const headersSub: Record<string, string> = {};
            for (const [k, v] of Object.entries(headers)) {
                const nk = substituteParamsDeep(k, subStr, subVal, owned);
                const nv = substituteParamsDeep(v, subStr, subVal, owned);
                headersSub[typeof nk === "string" ? nk : k] = typeof nv === "string" ? nv : String(nv ?? "");
            }

            const stillHasParams =
                (typeof urlSub === "string" && /\[param:/.test(urlSub)) ||
                hasMarkers(bodyValSub) ||
                Object.values(headersSub).some((v) => typeof v === "string" && /\[param:/.test(v));

            if (stillHasParams && caller.enclosingFn && depth + 1 <= FANOUT_MAX_DEPTH) {
                const recursed = expandEntryAcrossCallers(
                    typeof urlSub === "string" ? urlSub : url,
                    bodyValSub,
                    headersSub,
                    caller.enclosingFn,
                    deadlineMs,
                    capacity,
                    depth + 1
                );
                for (const r of recursed) {
                    if (capacity.remaining <= 0) break;
                    out.push(r);
                    capacity.remaining--;
                }
            } else {
                out.push({
                    url: typeof urlSub === "string" ? urlSub : url,
                    bodyValue: bodyValSub,
                    headers: headersSub,
                });
                capacity.remaining--;
            }
        }
        return out.length === 0 ? [{ url, bodyValue, headers }] : out;
    };

    const expandedEntries: HttpCallEntry[] = [];
    const totalEntries = entries.length;
    let processedCount = 0;
    let lastProgressPct = -1;
    const progressStartTs = Date.now();
    printMsg(MSG.Header, `[i] Expanding ${totalEntries} ${frameworkName} HTTP-client callsite(s) across callers`);
    for (const entry of entries) {
        processedCount++;
        const pct = totalEntries === 0 ? 100 : Math.floor((processedCount * 100) / totalEntries);
        if (pct !== lastProgressPct && (pct % 10 === 0 || pct === 100)) {
            const elapsed = ((Date.now() - progressStartTs) / 1000).toFixed(1);
            printMsg(MSG.Info, `    [progress] ${pct}% (${processedCount}/${totalEntries}) elapsed=${elapsed}s`);
            lastProgressPct = pct;
        }
        if (
            enclosingFnChainHasBinding(entry.enclosingFn) &&
            (MARKER_RE.test(entry.url) ||
                MARKER_RE.test(entry.body) ||
                hasMarkers(entry.bodyValue) ||
                headersHaveMarkers(entry.headers))
        ) {
            // URL fan-out: use the original `expandParamPlaceholders` (string
            // resolveNodeValue per caller). This is the version that produced
            // varied URLs like `<service>/<module>/<method>`.
            //
            // Scale per-entry budget and capacity with maxDepth so deeper
            // recursion actually has room to produce more URLs. At depth=3
            // (default) we get ~10s/150caps. At depth=10 we get ~80s/1200caps
            // per entry.
            const maxDepth = globals.getMaxRecursionDepth();
            const depthFactor = maxDepth + 1;
            // Linear deadline scaling — empirically gives ~5min total runtime
            // at depth 8 once getCallers AST caching is in place.
            const perEntryDeadlineMs = Date.now() + Math.max(2000, (8000 * depthFactor) / 4);
            const perEntryCapacity = { remaining: Math.max(30, 50 * depthFactor) };
            const entryStartTs = Date.now();
            const urls = expandParamPlaceholders(
                entry.url,
                entry.enclosingFn,
                getCallers,
                0,
                perEntryDeadlineMs,
                perEntryCapacity,
                maxDepth
            );
            // Body+headers substitution: resolves [param:X] body leaves to the
            // first matching caller's structured value (credentials object,
            // etc.) via resolveParamToAnyValue.
            const subBody = substituteBody(entry, entry.enclosingFn);
            const headersSub = substituteCallerHeaders(entry.headers, entry.enclosingFn, getCallers);
            const entryElapsed = Date.now() - entryStartTs;
            if (entryElapsed > 200) {
                printMsg(
                    MSG.Info,
                    `    [expand] entry ${processedCount}/${totalEntries} took ${entryElapsed}ms (${urls.length} urls)`
                );
            }

            const expansions: Expanded[] =
                urls.length === 0
                    ? [
                          {
                              url: substituteCallerPlaceholders(entry.url, entry.enclosingFn, getCallers),
                              bodyValue: subBody.bodyValue,
                              headers: headersSub,
                          },
                      ]
                    : urls.map((u) => ({ url: u, bodyValue: subBody.bodyValue, headers: headersSub }));

            for (const exp of expansions) {
                // Cross-file pass (later) handles [member:X.Y] / [call:X.Y()].
                const urlFinal = exp.url;
                const headersFinal = exp.headers;
                const bodyValueFinal: any = exp.bodyValue;
                const bodyStr =
                    bodyValueFinal === null || bodyValueFinal === undefined
                        ? ""
                        : typeof bodyValueFinal === "object"
                          ? JSON.stringify(bodyValueFinal)
                          : String(bodyValueFinal);
                expandedEntries.push({
                    ...entry,
                    url: urlFinal,
                    body: bodyStr,
                    bodyValue: bodyValueFinal,
                    headers: headersFinal,
                });
            }
        } else {
            expandedEntries.push(entry);
        }
    }
    entries.length = 0;
    entries.push(...expandedEntries);

    // Final pass: cross-file resolution for [member:X.Y] and [call:X.Y.Z()]
    // markers that survived caller-chain substitution. These come from imports
    // of other Vite chunks, which the in-file resolver can't follow.
    printMsg(MSG.Header, `[i] Cross-file resolution pass for ${entries.length} entries`);
    const crossStartTs = Date.now();
    let lastCrossPct = -1;
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const pct = entries.length === 0 ? 100 : Math.floor(((i + 1) * 100) / entries.length);
        if (pct !== lastCrossPct && (pct % 20 === 0 || pct === 100)) {
            const elapsed = ((Date.now() - crossStartTs) / 1000).toFixed(1);
            printMsg(MSG.Info, `    [cross-file] ${pct}% (${i + 1}/${entries.length}) elapsed=${elapsed}s`);
            lastCrossPct = pct;
        }
        try {
            entry.url = substituteCrossFileMarkers(entry.url, entry.filePath, directory);
            const headersResolved: Record<string, string> = {};
            for (const [hk, hv] of Object.entries(entry.headers)) {
                const nk = substituteCrossFileMarkers(hk, entry.filePath, directory);
                const nv = substituteCrossFileMarkers(hv, entry.filePath, directory);
                headersResolved[nk] = nv;
            }
            entry.headers = headersResolved;
            if (entry.bodyValue !== undefined && entry.bodyValue !== null && typeof entry.bodyValue === "object") {
                entry.bodyValue = substituteCrossFileMarkersDeep(entry.bodyValue, entry.filePath, directory);
                entry.body = JSON.stringify(entry.bodyValue);
            } else if (typeof entry.body === "string" && entry.body) {
                entry.body = substituteCrossFileMarkers(entry.body, entry.filePath, directory);
            }
        } catch {
            // Cross-file resolution is best-effort; never block emission on failure.
        }
    }

    let emitted = 0;
    for (const entry of entries) {
        if (!looksLikeUrl(entry.url)) continue;
        printMsg(MSG.Info, `[+] Found ${entry.method} client call in "${entry.filePath}":${entry.fileLine}`);
        printMsg(MSG.Run, `    URL: ${entry.url}`);
        if (Object.keys(entry.headers).length > 0) {
            printMsg(MSG.Run, `    Headers: ${JSON.stringify(entry.headers)}`);
        }
        if (entry.body) printMsg(MSG.Run, `    Body: ${entry.body}`);

        globals.addOpenapiOutput({
            url: entry.url,
            method: entry.method,
            path: entry.url,
            headers: entry.headers,
            body: entry.body,
            chunkId: `${entry.file}:${entry.fileLine}`,
            functionFile: entry.filePath,
            functionFileLine: entry.fileLine,
        });
        emitted++;
    }

    printMsg(MSG.Run, `[✓] Emitted ${emitted} HTTP client call(s) across ${frameworkName} files`);
};

export default vue_resolveHttpClient;
