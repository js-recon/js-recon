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
} from "./taint_utils.js";
import { deepSubstituteBodyValue } from "./bodyResolver.js";

const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;

/**
 * Checks whether invoking the given function body would directly execute a
 * `fetch(...)` call (as a bare Identifier callee). Used to recognise functions
 * that wrap the native fetch API so destructured aliases of those wrappers can
 * be resolved as fetch calls.
 *
 * The walk stops at nested function boundaries so a factory function that
 * RETURNS a fetch-wrapping arrow isn't itself classified as a wrapper — only
 * the arrow it returns is.
 */
const NESTED_FN_TYPES = new Set(["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"]);

/**
 * A function is treated as a "transparent" fetch wrapper only if its first
 * argument is forwarded as-is to fetch as the URL. Wrappers that construct the
 * URL from a property of their input object have a different calling convention
 * than `fetch(url, options)` — treating callsites of those as fetch calls
 * produces garbage URLs. So we require that fetch's first arg is the function's
 * first param (an Identifier match).
 */
const bodyCallsFetch = (functionNode: any): boolean => {
    if (!functionNode || typeof functionNode !== "object") return false;
    const params = Array.isArray(functionNode.params) ? functionNode.params : [];
    const firstParamName =
        params[0] && params[0].type === "Identifier"
            ? params[0].name
            : params[0] && params[0].type === "AssignmentPattern" && params[0].left?.type === "Identifier"
              ? params[0].left.name
              : null;
    if (!firstParamName) return false;

    let found = false;
    const visit = (n: any, depth: number) => {
        if (found || !n || typeof n !== "object") return;
        if (Array.isArray(n)) {
            for (const child of n) visit(child, depth);
            return;
        }
        if (typeof n.type !== "string") return;
        // Don't descend into nested functions — they have their own invocation context.
        if (depth > 0 && NESTED_FN_TYPES.has(n.type)) return;
        if (
            n.type === "CallExpression" &&
            n.callee &&
            n.callee.type === "Identifier" &&
            n.callee.name === "fetch" &&
            Array.isArray(n.arguments) &&
            n.arguments.length > 0 &&
            n.arguments[0].type === "Identifier" &&
            n.arguments[0].name === firstParamName
        ) {
            found = true;
            return;
        }
        for (const key of Object.keys(n)) {
            if (
                key === "loc" ||
                key === "start" ||
                key === "end" ||
                key === "leadingComments" ||
                key === "trailingComments"
            ) {
                continue;
            }
            visit(n[key], depth + 1);
        }
    };
    visit(functionNode, 0);
    return found;
};

const isFunctionLike = (node: any): boolean =>
    !!node &&
    (node.type === "ArrowFunctionExpression" ||
        node.type === "FunctionExpression" ||
        node.type === "FunctionDeclaration");

interface FetchEntry {
    file: string;
    filePath: string;
    fileContent: string;
    fileLine: number;
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
    enclosingFn: EnclosingFn | null;
}

/**
 * Scans all JS files in the given directory for fetch() calls,
 * resolves their URL / method / headers / body, and registers each
 * call with the OpenAPI output collector.
 *
 * Designed for Vite-bundled Vue.JS applications where HTTP calls are
 * made with the native fetch() API rather than via webpack chunks.
 */
const vue_resolveFetch = async (directory: string, frameworkName = "Vue.JS"): Promise<void> => {
    printMsg(MSG.Header, `[i] Resolving ${frameworkName} fetch instances`);

    let files: string[];
    try {
        files = fs.readdirSync(directory, { recursive: true, encoding: "utf8" }) as string[];
    } catch {
        printMsg(MSG.Err, `[!] Could not read directory: ${directory}`);
        return;
    }

    files = files
        .filter((f) => (f.endsWith(".js") || f.endsWith(".mjs")) && !f.includes("___subsequent_requests"))
        .filter((f) => !fs.lstatSync(path.join(directory, f)).isDirectory());

    const MAX_MAP_FILE_SIZE_BYTES = 1.5 * 1024 * 1024;

    // Pre-pass: scan every file for object-literal properties whose value is a
    // function that ultimately calls fetch(). Their property names are the
    // fetch-wrapper keys downstream code destructures and invokes in place of
    // fetch — so we need to recognise those aliases.
    //
    // ASTs are parsed on-demand and discarded after each file — only
    // `wrapperKeyNames` (a small string set) and `fetchFilePaths` (a path list)
    // are retained so that the full pre-pass AST set never lives in memory
    // simultaneously.
    const wrapperKeyNames = new Set<string>();
    const fetchFilePaths: string[] = [];

    for (let _pi = 0; _pi < files.length; _pi++) {
        // Yield to the event loop every 50 files so V8 GC can reclaim ASTs
        // from completed iterations before the next batch begins.
        if (_pi > 0 && _pi % 50 === 0) await new Promise<void>((r) => setImmediate(r));
        const file = files[_pi];
        const filePath = path.join(directory, file);
        if (fs.statSync(filePath).size > MAX_MAP_FILE_SIZE_BYTES) continue;
        let fileContent: string;
        try {
            fileContent = fs.readFileSync(filePath, "utf-8");
        } catch {
            continue;
        }
        if (!fileContent.includes("fetch")) continue;
        fetchFilePaths.push(filePath);
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
            ObjectProperty(p) {
                const key = p.node.key;
                const value: any = p.node.value;
                if (!isFunctionLike(value)) return;
                if (!bodyCallsFetch(value)) return;
                const keyName = key.type === "Identifier" ? key.name : key.type === "StringLiteral" ? key.value : null;
                if (keyName) wrapperKeyNames.add(keyName);
            },
        });
        // fileAst and fileContent go out of scope here — GC can reclaim them.
    }

    const getCallers = makeGetCallers(fetchFilePaths);

    let totalFetchCalls = 0;
    // Counter for per-callsite uniqueness so two callsites at the same path+method
    // are kept distinct in mapped.json and downstream specs.
    let callsiteCounter = 0;
    const entries: FetchEntry[] = [];

    for (let _mi = 0; _mi < files.length; _mi++) {
        // Yield every 50 files so V8 GC can run between batches.
        if (_mi > 0 && _mi % 50 === 0) await new Promise<void>((r) => setImmediate(r));
        const file = files[_mi];
        const filePath = path.join(directory, file);
        if (fs.statSync(filePath).size > MAX_MAP_FILE_SIZE_BYTES) {
            printMsg(
                MSG.Warn,
                `[!] Skipping ${file} (${(fs.statSync(filePath).size / 1024 / 1024).toFixed(1)} MB > 1.5 MB limit) — fetch coverage may be incomplete`
            );
            continue;
        }
        // Parse each file fresh — no persistent cache. The AST goes out of scope
        // at the end of this loop body so the GC can reclaim it.
        let fileContent: string;
        let fileAst: any;
        try {
            fileContent = fs.readFileSync(filePath, "utf-8");
        } catch {
            continue;
        }
        if (!fileContent.includes("fetch")) continue;
        try {
            fileAst = parser.parse(fileContent, {
                sourceType: "unambiguous",
                plugins: ["jsx", "typescript"],
                errorRecovery: true,
            });
        } catch {
            continue;
        }

        // Collect fetch aliases:
        //   1. `const x = fetch` (direct identifier aliasing)
        //   2. `const x = (i, l) => fetch(i, l)` (function-literal wrappers)
        //   3. `const { wrapperKey: x } = factory({...})` (destructured wrapper keys)
        const fetchAliases = new Set<any>();
        traverse(fileAst, {
            VariableDeclarator(p) {
                const { id, init } = p.node;
                if (!init) return;

                if (id.type === "Identifier") {
                    if (init.type === "Identifier" && init.name === "fetch") {
                        const binding = p.scope.getBinding(id.name);
                        if (binding) fetchAliases.add(binding);
                        return;
                    }
                    if (isFunctionLike(init) && bodyCallsFetch(init)) {
                        const binding = p.scope.getBinding(id.name);
                        if (binding) fetchAliases.add(binding);
                        return;
                    }
                }

                if (id.type === "ObjectPattern") {
                    for (const prop of id.properties) {
                        if (prop.type !== "ObjectProperty") continue;
                        const keyName =
                            prop.key.type === "Identifier"
                                ? prop.key.name
                                : prop.key.type === "StringLiteral"
                                  ? prop.key.value
                                  : null;
                        if (!keyName || !wrapperKeyNames.has(keyName)) continue;
                        const valueName = prop.value.type === "Identifier" ? prop.value.name : null;
                        if (!valueName) continue;
                        const binding = p.scope.getBinding(valueName);
                        if (binding) fetchAliases.add(binding);
                    }
                }
            },
        });

        // Resolve each fetch call
        traverse(fileAst, {
            CallExpression(callPath) {
                const callee = callPath.node.callee;
                let isFetchCall = false;

                if (callee.type === "Identifier" && callee.name === "fetch") {
                    isFetchCall = true;
                } else if (callee.type === "Identifier") {
                    const binding = callPath.scope.getBinding(callee.name);
                    if (binding && fetchAliases.has(binding)) isFetchCall = true;
                }

                if (!isFetchCall) return;

                const args = callPath.node.arguments;
                if (args.length === 0) return;

                const fileLine = callPath.node.loc?.start.line ?? 0;
                totalFetchCalls++;

                // Resolve URL (first argument)
                const urlArgCode = fileContent
                    .slice((args[0] as any).start, (args[0] as any).end)
                    .replace(/\n\s*/g, "");

                let url: any = resolveNodeValue(args[0], callPath.scope, urlArgCode, "fetch", fileContent);

                if (typeof url === "string" && (url.includes("[var ") || url.includes("[MemberExpression"))) {
                    const substituted = substituteVariablesInString(url, fileContent);
                    if (substituted !== url) {
                        printMsg(MSG.Header, `    [i] Resolved variables in URL: ${url} -> ${substituted}`);
                        url = substituted;
                    }
                }

                let method = "GET";
                let headers: Record<string, string> = {};
                let body = "";

                if (args.length > 1) {
                    const options: any = resolveNodeValue(args[1], callPath.scope, "", "fetch", fileContent);

                    if (typeof options === "object" && options !== null) {
                        method = options.method || "GET";

                        if (options.headers && typeof options.headers === "object") {
                            const resolvedHeaders: Record<string, string> = {};
                            for (const [k, v] of Object.entries(options.headers)) {
                                const rk =
                                    typeof k === "string" ? substituteVariablesInString(k, fileContent) : String(k);
                                const rv =
                                    typeof v === "string" ? substituteVariablesInString(v, fileContent) : String(v);
                                resolvedHeaders[rk] = rv;
                            }
                            headers = resolvedHeaders;
                        }

                        if (options.body) {
                            body =
                                typeof options.body === "object" ? JSON.stringify(options.body) : String(options.body);
                        }
                    }
                }

                const rawEnclosingFn = inferEnclosingFn(callPath, filePath);
                // Null out the AST node reference — it is never read in the
                // second pass, but keeping it alive would pin the entire file
                // AST in memory through the entries array.
                const enclosingFn = rawEnclosingFn ? { ...rawEnclosingFn, node: null } : null;

                entries.push({
                    file,
                    filePath,
                    // fileContent is not used in the second pass; store an empty
                    // string so the full file content is not kept alive in memory
                    // through the entries array.
                    fileContent: "",
                    fileLine,
                    url: typeof url === "string" ? url : "",
                    method,
                    headers,
                    body,
                    enclosingFn,
                });
            },
        });
    }

    // Second pass: walk back to each fetch's enclosing function callers and
    // substitute markers we couldn't resolve in the first pass. This is where
    // `?[urlsearchparams:p.q]` turns into `?k1={k1}&k2={k2}`, and where
    // `...p.q: <spread>` gets expanded if a literal object was passed.
    //
    const MARKER_RE = /\[(urlsearchparams|member|param):/;
    const headersHaveMarkers = (h: Record<string, string>): boolean => {
        for (const [k, v] of Object.entries(h)) {
            if (k.startsWith("...") && v === "<spread>") return true;
            if (MARKER_RE.test(v)) return true;
        }
        return false;
    };

    for (const entry of entries) {
        if (
            entry.enclosingFn &&
            entry.enclosingFn.bindingName &&
            entry.enclosingFn.firstParamName &&
            entry.enclosingFn.bindingName.length > 2 &&
            (MARKER_RE.test(entry.url) || MARKER_RE.test(entry.body) || headersHaveMarkers(entry.headers))
        ) {
            entry.url = substituteCallerPlaceholders(entry.url, entry.enclosingFn, getCallers);
            entry.headers = substituteCallerHeaders(entry.headers, entry.enclosingFn, getCallers);
            entry.body = substituteCallerPlaceholders(entry.body, entry.enclosingFn, getCallers);
        }

        // Deep body resolution: when the body JSON contains [param:X] string
        // values that map to structured objects at the call site, replace them.
        // This runs even for short binding names (e.g. single-char minifier
        // locals) because makeGetCallers uses the alias map internally and will
        // find callers via a meaningful exported name (e.g. postSOA → O).
        if (entry.enclosingFn && entry.enclosingFn.bindingName && /\[param:/.test(entry.body)) {
            try {
                const parsed = JSON.parse(entry.body);
                if (parsed !== null && typeof parsed === "object") {
                    const substituted = deepSubstituteBodyValue(parsed, entry.enclosingFn, getCallers);
                    entry.body = JSON.stringify(substituted);
                }
            } catch {
                // body is not valid JSON; fall back to string-level substitution
                if (entry.enclosingFn.bindingName.length <= 2) {
                    entry.body = substituteCallerPlaceholders(entry.body, entry.enclosingFn, getCallers);
                }
            }
        }

        printMsg(MSG.Info, `[+] Found fetch call in "${entry.filePath}":${entry.fileLine}`);
        printMsg(MSG.Run, `    URL: ${entry.url}`);
        if (entry.method !== "GET" || Object.keys(entry.headers).length > 0 || entry.body) {
            printMsg(MSG.Run, `    Method: ${entry.method}`);
        }
        if (Object.keys(entry.headers).length > 0) printMsg(MSG.Run, `    Headers: ${JSON.stringify(entry.headers)}`);
        if (entry.body) printMsg(MSG.Run, `    Body: ${entry.body}`);

        // Skip the openapi/postman registration for callsites where the URL
        // never resolved to anything URL-shaped. Examples:
        //   - inner wrapper bodies like `fetch(i, l)` where `i` is a param
        //   - non-string AST nodes (objects, member expressions) that have
        //     no chance of being a real path
        const urlStr = entry.url;
        const looksLikeUrl =
            urlStr.length > 0 &&
            !urlStr.startsWith("[") &&
            urlStr !== "[object Object]" &&
            (urlStr.startsWith("http://") ||
                urlStr.startsWith("https://") ||
                urlStr.startsWith("/") ||
                /^[A-Za-z0-9_\-.]+\//.test(urlStr));
        if (!looksLikeUrl) continue;

        callsiteCounter++;
        globals.addOpenapiOutput({
            url: urlStr,
            method: entry.method,
            path: urlStr,
            headers: entry.headers,
            body: entry.body,
            chunkId: `${entry.file}:${entry.fileLine}`,
            functionFile: entry.filePath,
            functionFileLine: entry.fileLine,
        });
    }

    printMsg(MSG.Run, `[✓] Found and resolved ${totalFetchCalls} fetch call(s) across ${frameworkName} files`);
};

export default vue_resolveFetch;
