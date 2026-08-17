import { printMsg, MSG } from "../../utility/printMsg.js";
import * as parser from "@babel/parser";
import traverse from "@babel/traverse";
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

interface XhrEntry {
    file: string;
    filePath: string;
    fileLine: number;
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
    enclosingFn: EnclosingFn | null;
}

/**
 * Scans all JS files in the given directory for XMLHttpRequest usage,
 * resolves the URL / method / headers / body from the .open() / .setRequestHeader()
 * / .send() call chain, and registers each call with the OpenAPI output collector.
 *
 * The resolution strategy tracks every binding assigned a `new XMLHttpRequest()`
 * instance and then collects the corresponding .open(), .setRequestHeader(), and
 * .send() calls on that same binding within the enclosing function scope.
 *
 * After the initial AST pass, a taint analysis second pass walks back to each
 * enclosing function's callers to substitute [param:X], [member:P.X], and
 * [urlsearchparams:P.X] placeholders in the URL, method, headers, and body.
 *
 * Memory design mirrors vue_resolveFetch: ASTs are parsed per-file and freed
 * immediately after each iteration; no persistent AST cache is maintained.
 */
const vue_resolveXhr = async (directory: string, frameworkName = "Vue.JS"): Promise<void> => {
    printMsg(MSG.Header, `[i] Resolving ${frameworkName} XMLHttpRequest instances`);

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

    // Build the full path list for caller lookup. XHR wrapper callers may live
    // in any file (not just those containing XMLHttpRequest), so we search all
    // JS files with a text pre-filter before parsing.
    //
    // Apply the same per-file size guard used in the scanning loop, plus a
    // cumulative total-size cap. Without this, sites that download hundreds of
    // third-party library source files cause buildAliasMap to parse all of them
    // at once, exhausting the V8 heap before any XHR entries are resolved.
    const MAX_MAP_FILE_SIZE_BYTES = 8 * 1024 * 1024;
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
                `[!] XHR caller lookup capped at 50 MB total — ${files.length - allFilePaths.length} file(s) excluded from taint analysis`
            );
            break;
        }
        callerTotalBytes += sz;
        allFilePaths.push(fp);
    }
    const getCallers = makeGetCallers(allFilePaths);

    let totalXhrCalls = 0;
    const entries: XhrEntry[] = [];

    for (let _i = 0; _i < files.length; _i++) {
        // Yield to the event loop every 50 files so V8 GC can reclaim ASTs
        // from completed iterations before the next batch begins.
        if (_i > 0 && _i % 50 === 0) await new Promise<void>((r) => setImmediate(r));

        const file = files[_i];
        const filePath = path.join(directory, file);

        if (fs.statSync(filePath).size > MAX_MAP_FILE_SIZE_BYTES) continue;

        let fileContent: string;
        try {
            fileContent = fs.readFileSync(filePath, "utf-8");
        } catch {
            continue;
        }

        // Fast pre-filter: skip files that can't possibly contain XHR usage.
        if (!fileContent.includes("XMLHttpRequest")) continue;

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

        // Pass 1: find every binding assigned `new XMLHttpRequest()`.
        const xhrBindingNames = new Set<string>();

        traverse(fileAst, {
            NewExpression(p) {
                const callee = p.node.callee;
                if (callee.type !== "Identifier" || callee.name !== "XMLHttpRequest") return;

                const parent = p.parent;
                if (parent.type === "VariableDeclarator" && parent.id.type === "Identifier") {
                    xhrBindingNames.add(parent.id.name);
                    return;
                }
                if (parent.type === "AssignmentExpression" && parent.left.type === "Identifier") {
                    xhrBindingNames.add(parent.left.name);
                    return;
                }
            },
        });

        if (xhrBindingNames.size === 0) continue;

        // Pass 2: for each XHR binding, collect .open(), .setRequestHeader(),
        // and .send() calls. We group them by binding name; one entry per .open() call.

        interface XhrCallData {
            method: string;
            url: string;
            line: number;
            headers: Record<string, string>;
            body: string;
            enclosingFn: EnclosingFn | null;
        }

        const xhrCallMap = new Map<string, XhrCallData[]>();
        const xhrAccum = new Map<
            string,
            { headers: Record<string, string>; body: string; enclosingFn: EnclosingFn | null }
        >();

        for (const name of xhrBindingNames) {
            xhrCallMap.set(name, []);
            xhrAccum.set(name, { headers: {}, body: "", enclosingFn: null });
        }

        traverse(fileAst, {
            CallExpression(p) {
                const callee = p.node.callee;
                if (callee.type !== "MemberExpression") return;
                const obj = callee.object;
                const prop = callee.property;
                if (obj.type !== "Identifier") return;
                if (!xhrBindingNames.has(obj.name)) return;
                if (prop.type !== "Identifier") return;

                const methodName = prop.name;
                const args = p.node.arguments;

                if (methodName === "open") {
                    if (args.length < 2) return;

                    const rawMethod = resolveNodeValue(args[0], p.scope, "", "fetch", fileContent);
                    const rawUrl = resolveNodeValue(args[1], p.scope, "", "fetch", fileContent);

                    let method = typeof rawMethod === "string" ? rawMethod.toUpperCase() : "GET";
                    if (!["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"].includes(method)) {
                        method = typeof rawMethod === "string" ? rawMethod : "GET";
                    }

                    let url = typeof rawUrl === "string" ? rawUrl : "";
                    if (url.includes("[var ") || url.includes("[MemberExpression")) {
                        url = substituteVariablesInString(url, fileContent);
                    }

                    const line = p.node.loc?.start.line ?? 0;

                    // Capture enclosing function (for taint analysis second pass) but
                    // null out the AST node ref to avoid pinning the file AST in memory.
                    const rawEnclosingFn = inferEnclosingFn(p, filePath);
                    const enclosingFn = rawEnclosingFn ? { ...rawEnclosingFn, node: null } : null;

                    const accum = xhrAccum.get(obj.name)!;
                    xhrCallMap.get(obj.name)!.push({
                        method,
                        url,
                        line,
                        headers: { ...accum.headers },
                        body: accum.body,
                        enclosingFn,
                    });
                    xhrAccum.set(obj.name, { headers: {}, body: "", enclosingFn: null });
                } else if (methodName === "setRequestHeader") {
                    if (args.length < 2) return;
                    const rawName = resolveNodeValue(args[0], p.scope, "", "fetch", fileContent);
                    const rawValue = resolveNodeValue(args[1], p.scope, "", "fetch", fileContent);
                    const headerName =
                        typeof rawName === "string"
                            ? substituteVariablesInString(rawName, fileContent)
                            : String(rawName ?? "");
                    const headerValue =
                        typeof rawValue === "string"
                            ? substituteVariablesInString(rawValue, fileContent)
                            : String(rawValue ?? "");
                    xhrAccum.get(obj.name)!.headers[headerName] = headerValue;
                } else if (methodName === "send") {
                    if (args.length > 0) {
                        const rawBody = resolveNodeValue(args[0], p.scope, "", "fetch", fileContent);
                        const bodyStr =
                            rawBody === null || rawBody === undefined
                                ? ""
                                : typeof rawBody === "object"
                                  ? JSON.stringify(rawBody)
                                  : String(rawBody);
                        xhrAccum.get(obj.name)!.body = bodyStr;
                    }
                }
            },
        });

        // Merge accumulated headers/body into each open() entry. Because we push
        // on .open() (before .send() is seen), we merge the final accumulator state
        // into the last entry.
        for (const [bindingName, calls] of xhrCallMap.entries()) {
            const accum = xhrAccum.get(bindingName)!;
            if (calls.length > 0) {
                const last = calls[calls.length - 1];
                for (const [k, v] of Object.entries(accum.headers)) {
                    if (!(k in last.headers)) last.headers[k] = v;
                }
                if (!last.body && accum.body) last.body = accum.body;
            }

            for (const call of calls) {
                totalXhrCalls++;
                entries.push({
                    file,
                    filePath,
                    fileLine: call.line,
                    url: call.url,
                    method: call.method,
                    headers: call.headers,
                    body: call.body,
                    enclosingFn: call.enclosingFn,
                });
            }
        }

        // fileAst and fileContent go out of scope here — GC can reclaim them.
    }

    // Taint analysis second pass: walk back to each XHR call's enclosing function
    // callers and substitute [param:X], [member:P.X], and [urlsearchparams:P.X]
    // placeholders. Also resolves [call:X.toUpperCase()] method placeholders.
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
            entry.enclosingFn?.bindingName &&
            entry.enclosingFn.bindingName.length > 2 &&
            (MARKER_RE.test(entry.url) ||
                MARKER_RE.test(entry.method) ||
                MARKER_RE.test(entry.body) ||
                headersHaveMarkers(entry.headers))
        ) {
            entry.url = substituteCallerPlaceholders(entry.url, entry.enclosingFn, getCallers);
            entry.body = substituteCallerPlaceholders(entry.body, entry.enclosingFn, getCallers);
            entry.headers = substituteCallerHeaders(entry.headers, entry.enclosingFn, getCallers);

            // [call:X.Y.toUpperCase()] → resolve the inner member chain, then uppercase
            const toUpperMatch = entry.method.match(/^\[call:([\w$.]+)\.toUpperCase\(\)\]$/);
            if (toUpperMatch) {
                const sub = substituteCallerPlaceholders(`[member:${toUpperMatch[1]}]`, entry.enclosingFn, getCallers);
                if (!sub.startsWith("[")) entry.method = sub.toUpperCase();
            }
        }
    }

    // Output and register with OpenAPI collector
    for (const entry of entries) {
        printMsg(MSG.Info, `[+] Found XHR call in "${entry.filePath}":${entry.fileLine}`);
        printMsg(MSG.Run, `    URL: ${entry.url}`);
        if (entry.method !== "GET" || Object.keys(entry.headers).length > 0 || entry.body) {
            printMsg(MSG.Run, `    Method: ${entry.method}`);
        }
        if (Object.keys(entry.headers).length > 0) {
            printMsg(MSG.Run, `    Headers: ${JSON.stringify(entry.headers)}`);
        }
        if (entry.body) printMsg(MSG.Run, `    Body: ${entry.body}`);

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

    printMsg(MSG.Run, `[✓] Found and resolved ${totalXhrCalls} XHR call(s) across ${frameworkName} files`);
};

export default vue_resolveXhr;
