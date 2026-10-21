import fs from "fs";
import path from "path";
import * as taintwire from "@js-recon/taintwire";
import { printMsg, MSG } from "../../../utility/printMsg.js";
import * as globals from "../../../utility/globals.js";
import { looksLikeUrl, looksLikeStrictUrl } from "../../../utility/urlUtils.js";
import { makeResolver } from "../valueResolver.js";

// Same per-file cap as the legacy fetch resolver.
const MAX_MAP_FILE_SIZE_BYTES = 8 * 1024 * 1024;
// Source bytes loaded into one in-memory graph. One graph per file would open Ladybug hundreds of
// times on large targets, and each open reserves address space that is only released on GC.
const MAX_GRAPH_BYTES = 2 * 1024 * 1024;
// Files that can't contain any of the three sinks are never loaded.
const PREFILTER = /\bfetch\b|XMLHttpRequest|\.(?:get|post|put|delete|patch|head|options)\s*\(/;

// `fetch(...)` and its aliases (`const f = fetch; f(...)`): the unresolved global `fetch` reaching
// a callee position through value flow. Local wrappers resolve later through ARGUMENT_TO.
const FETCH_CALLS = `
MATCH (f:Identifier)-[:FLOWS_TO* ACYCLIC 0..6]->(callee)<-[k:SON]-(c:CallExpression)
WHERE f.name = 'fetch' AND k.key = 'callee' AND NOT EXISTS { MATCH (f)-[:REFERS_TO]->() }
RETURN DISTINCT c.id AS id, c.file AS file, c.line AS line`;

// `.open()` / `.setRequestHeader()` / `.send()` on a binding that a `new XMLHttpRequest()` flows into.
const XHR_CALLS = `
MATCH (n:NewExpression)-[k:SON]->(x:Identifier)
WHERE k.key = 'callee' AND x.name = 'XMLHttpRequest'
MATCH (n)-[:FLOWS_TO* ACYCLIC 1..6]->(o:Identifier)<-[s:SON]-(m:MemberExpression)-[p:SON]->(op:Identifier),
      (m)<-[cs:SON]-(c:CallExpression)
WHERE s.key = 'object' AND p.key = 'property' AND cs.key = 'callee'
  AND op.name IN ['open', 'setRequestHeader', 'send']
RETURN DISTINCT n.id AS xhr, c.id AS id, c.file AS file, c.line AS line, c.startOffset AS pos, op.name AS op
ORDER BY pos`;

// `<obj>.<verb>(url, ...)` on anything but `this` or a string (same matcher as vue_resolveHttpClient),
// kept only if a string literal containing `/` can reach the first argument (flowing into it, or in
// the subtree of something that does). That drops the Map.get(e)-style calls that fill vendor
// bundles in one query, instead of resolving each one and rejecting it with looksLikeUrl.
// The argument's own subtree is a separate EXISTS: Ladybug returns no zero-hop flow path from a
// node type that has no FLOWS_TO edges in the graph, so `api.get("/x")` alone would be missed.
const CLIENT_CALLS = `
MATCH (c:CallExpression)-[k:SON]->(m:MemberExpression)-[p:SON]->(v:Identifier), (m)-[o:SON]->(obj), (c)-[a:SON]->(arg)
WHERE k.key = 'callee' AND p.key = 'property' AND o.key = 'object' AND a.key = 'arguments' AND a.idx = 0
  AND v.name IN ['get', 'post', 'put', 'delete', 'patch', 'head', 'options']
  AND m.props CONTAINS '"computed":false'
  AND NOT obj.type IN ['ThisExpression', 'StringLiteral', 'TemplateLiteral']
  AND (
    EXISTS {
      MATCH (arg)-[:SON*0..4]->(t)
      WHERE t.type IN ['StringLiteral', 'TemplateElement'] AND t.value CONTAINS '/'
    }
    OR EXISTS {
      MATCH (s)-[:FLOWS_TO|ARGUMENT_TO|RETURNS_TO* ACYCLIC 1..8]->(arg), (s)-[:SON*0..4]->(t)
      WHERE t.type IN ['StringLiteral', 'TemplateElement'] AND t.value CONTAINS '/'
    }
  )
RETURN c.id AS id, c.file AS file, c.line AS line, v.name AS verb`;

export interface ApiCall {
    kind: "fetch" | "XHR" | "client";
    file: string;
    line: number;
    urls: string[];
    method: string;
    headers: Record<string, string>;
    body: string;
}

const asText = (v: unknown): string =>
    v === undefined || v === "" ? "" : typeof v === "string" ? v : JSON.stringify(v);

// Placeholders like `[call:x.method.toUpperCase()]` keep their case.
const asMethod = (m: string | undefined): string => (!m ? "GET" : m.startsWith("[") ? m : m.toUpperCase());

const asHeaders = (v: unknown): Record<string, string> =>
    v !== null && typeof v === "object"
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, asText(x)]))
        : {};

/** Every fetch, XHR and HTTP-client call in a taintwire graph, with its URL variants, method, headers and body. */
export const resolveApiCalls = async (graph: taintwire.TaintGraph): Promise<ApiCall[]> => {
    const { query, kids, values, render } = makeResolver(graph);
    const calls: ApiCall[] = [];

    for (const { id, file, line } of await query(FETCH_CALLS)) {
        const [url, options] = await kids(id, "arguments");
        if (!url) continue;
        const o = (options ? await render(options) : {}) as Record<string, unknown>;
        calls.push({
            kind: "fetch",
            file,
            line,
            urls: await values(url),
            method: asMethod(asText(o?.method)),
            headers: asHeaders(o?.headers),
            body: asText(o?.body),
        });
    }

    // ponytail: one XHR instance's headers/body are merged into every open() on it, not split per request.
    const xhrs = new Map<string, { opens: ApiCall[]; headers: Record<string, string>; body: string }>();
    for (const { xhr, id, file, line, op } of await query(XHR_CALLS)) {
        if (!xhrs.has(xhr)) xhrs.set(xhr, { opens: [], headers: {}, body: "" });
        const inst = xhrs.get(xhr)!;
        const args = await kids(id, "arguments");
        if (op === "open" && args.length >= 2) {
            const method = asMethod((await values(args[0]))[0]);
            inst.opens.push({ kind: "XHR", file, line, urls: await values(args[1]), method, headers: {}, body: "" });
        } else if (op === "setRequestHeader" && args.length >= 2) {
            inst.headers[(await values(args[0]))[0] ?? ""] = (await values(args[1]))[0] ?? "";
        } else if (op === "send" && args.length > 0) {
            inst.body = asText(await render(args[0]));
        }
    }
    for (const { opens, headers, body } of xhrs.values()) {
        for (const call of opens) calls.push({ ...call, headers, body });
    }

    for (const { id, file, line, verb } of await query(CLIENT_CALLS)) {
        const args = await kids(id, "arguments");
        if (args.length === 0) continue;
        // Drops Map.get / Headers.delete / EventBus.post lookalikes before they're logged.
        const urls = (await values(args[0])).filter(looksLikeUrl);
        if (urls.length === 0) continue;
        const hasBody = verb === "post" || verb === "put" || verb === "patch";
        const config = args[hasBody ? 2 : 1];
        calls.push({
            kind: "client",
            file,
            line,
            urls,
            method: verb.toUpperCase(),
            headers: config ? asHeaders(((await render(config)) as Record<string, unknown>)?.headers) : {},
            body: hasBody && args[1] ? asText(await render(args[1])) : "",
        });
    }

    return calls;
};

/**
 * taintwire counterpart of the legacy React resolvers (react_resolveFetch + vue_resolveXhr +
 * vue_resolveHttpClient): loads the JS files under `directory` into taintwire graphs, finds the
 * calls with Cypher and registers each URL variant with the OpenAPI output collector.
 */
const taintwire_react = async (directory: string): Promise<void> => {
    printMsg(MSG.Header, "[i] Resolving React API calls with taintwire");

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

    // Group the files that pass the prefilter into graphs of about MAX_GRAPH_BYTES.
    const batches: string[][] = [[]];
    let batchBytes = 0;
    for (const file of files) {
        const filePath = path.join(directory, file);
        const size = fs.statSync(filePath).size;
        if (size > MAX_MAP_FILE_SIZE_BYTES) {
            printMsg(
                MSG.Warn,
                `[!] Skipping ${file} (${(size / 1024 / 1024).toFixed(1)} MB > ${MAX_MAP_FILE_SIZE_BYTES / 1024 / 1024} MB limit) — API call coverage may be incomplete`
            );
            continue;
        }
        if (!PREFILTER.test(fs.readFileSync(filePath, "utf-8"))) continue;
        if (batchBytes + size > MAX_GRAPH_BYTES && batches[batches.length - 1].length > 0) {
            batches.push([]);
            batchBytes = 0;
        }
        batches[batches.length - 1].push(file);
        batchBytes += size;
    }

    const calls: ApiCall[] = [];
    for (const batch of batches.filter((b) => b.length > 0)) {
        // The babel parser builds the same tree as cs-mast, recovers from syntax errors like
        // js-recon's own parser, and skips the per-node hash nothing here uses.
        const graph = await taintwire.TaintGraph.open(":memory:", { parser: "babel" });
        try {
            for (const file of batch) {
                try {
                    await graph.add(fs.readFileSync(path.join(directory, file), "utf-8"), file);
                } catch (e) {
                    printMsg(MSG.Warn, `[!] taintwire could not load ${file}: ${(e as Error).message}`);
                }
            }
            calls.push(...(await resolveApiCalls(graph)));
        } finally {
            await graph.close();
        }
    }

    let emitted = 0;
    for (const call of calls) {
        const filePath = path.join(directory, call.file);
        printMsg(MSG.Info, `[+] Found ${call.kind} call in "${filePath}":${call.line}`);
        for (const url of call.urls) printMsg(MSG.Run, `    URL: ${url}`);
        if (call.method !== "GET" || Object.keys(call.headers).length > 0 || call.body) {
            printMsg(MSG.Run, `    Method: ${call.method}`);
        }
        if (Object.keys(call.headers).length > 0) printMsg(MSG.Run, `    Headers: ${JSON.stringify(call.headers)}`);
        if (call.body) printMsg(MSG.Run, `    Body: ${call.body}`);

        // Same filters as legacy: strict for fetch/XHR, the placeholder-tolerant one for clients.
        const urlFilter = call.kind === "client" ? looksLikeUrl : looksLikeStrictUrl;
        for (const url of call.urls) {
            if (!urlFilter(url)) continue;
            emitted++;
            globals.addOpenapiOutput({
                url,
                method: call.method,
                path: url,
                headers: call.headers,
                body: call.body,
                chunkId: `${call.file}:${call.line}`,
                functionFile: filePath,
                functionFileLine: call.line,
            });
        }
    }

    printMsg(
        MSG.Run,
        `[✓] taintwire found ${calls.length} React API call(s), ${emitted} URL(s) registered across ${files.length} file(s)`
    );
};

export default taintwire_react;
