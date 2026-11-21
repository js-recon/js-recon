import fs from "fs";
import os from "os";
import path from "path";
import * as taintwire from "@js-recon/taintwire";
import { printMsg, MSG } from "../../utility/printMsg.js";
import { listJsFiles } from "../../utility/listFiles.js";
import * as globals from "../../utility/globals.js";
import { looksLikeUrl, looksLikeStrictUrl } from "../../utility/urlUtils.js";
import { makeResolver } from "./valueResolver.js";
import { writeGraph } from "../../taintwire/index.js";

// Same per-file cap as the legacy fetch resolver: one unit's graph is never bigger than this much source.
const MAX_MAP_FILE_SIZE_BYTES = 8 * 1024 * 1024;

/** True (with a warning) when a unit of `size` bytes is too big to load into a graph. */
export const tooBigForGraph = (name: string, size: number): boolean => {
    if (size <= MAX_MAP_FILE_SIZE_BYTES) return false;
    printMsg(
        MSG.Warn,
        `[!] Skipping ${name} (${(size / 1024 / 1024).toFixed(1)} MB > ${MAX_MAP_FILE_SIZE_BYTES / 1024 / 1024} MB limit); taintwire results may be incomplete`
    );
    return true;
};
// Source bytes loaded into one in-memory graph. One graph per file would open Ladybug hundreds of
// times on large targets, and each open reserves address space that is only released on GC.
const MAX_GRAPH_BYTES = 2 * 1024 * 1024;
// `fetch(...)` / `$fetch(...)` (ofetch, Nuxt) and their aliases (`const f = fetch; f(...)`): the
// unresolved global reaching a callee position through value flow. Local wrappers resolve later
// through ARGUMENT_TO.
const FETCH_CALLS = `
MATCH (f:Identifier)-[:FLOWS_TO* ACYCLIC 0..6]->(callee)<-[k:SON]-(c:CallExpression)
WHERE f.name IN ['fetch', '$fetch'] AND k.key = 'callee' AND NOT EXISTS { MATCH (f)-[:REFERS_TO]->() }
RETURN DISTINCT c.id AS id, c.file AS file, c.line AS line`;

// A `fetch` handed in by destructuring (SvelteKit `load({ fetch })`, minified to `({fetch: t}) => t(...)`):
// the binding the pattern declares, flowing to a callee.
const DESTRUCTURED_FETCH_CALLS = `
MATCH (p:ObjectProperty)-[pk:SON]->(k:Identifier), (p)-[pv:SON]->(d:Identifier),
      (d)-[:FLOWS_TO* ACYCLIC 1..6]->(callee)<-[ck:SON]-(c:CallExpression)
WHERE pk.key = 'key' AND pv.key = 'value' AND k.name = 'fetch' AND ck.key = 'callee'
RETURN DISTINCT c.id AS id, c.file AS file, c.line AS line`;

// Nuxt's compiled `useFetch(url, opts)` / `useLazyFetch`: the compiler appends a `"$<hash>"` key
// argument, and the composable itself is an anonymous import by then.
const NUXT_FETCH_CALLS = `
MATCH (c:CallExpression)-[a:SON]->(key:StringLiteral)
WHERE a.key = 'arguments' AND a.idx > 0 AND key.value =~ '[$][A-Za-z0-9_-]{8,12}'
  AND NOT EXISTS { MATCH (c)-[b:SON]->() WHERE b.key = 'arguments' AND b.idx > a.idx }
RETURN DISTINCT c.id AS id, c.file AS file, c.line AS line, a.idx AS keyIdx`;

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

// `<obj>.<verb>(url, ...)` on anything but `this` or a string (same matcher as vue_resolveHttpClient).
const CLIENT_CALLS = `
MATCH (c:CallExpression)-[k:SON]->(m:MemberExpression)-[p:SON]->(v:Identifier), (m)-[o:SON]->(obj), (c)-[a:SON]->(arg)
WHERE k.key = 'callee' AND p.key = 'property' AND o.key = 'object' AND a.key = 'arguments' AND a.idx = 0
  AND v.name IN ['get', 'post', 'put', 'delete', 'patch', 'head', 'options']
  AND m.props CONTAINS '"computed":false'
  AND NOT obj.type IN ['ThisExpression', 'StringLiteral', 'TemplateLiteral']
RETURN c.id AS id, c.file AS file, c.line AS line, v.name AS verb, obj.id AS client, arg.id AS arg`;

// Client calls are kept only if a string literal containing `/` can reach their first argument:
// the literal itself or a node at most 4 levels above it, or anything those flow into. That drops
// the Map.get(e)-style calls that fill vendor bundles. It's computed once per graph, forward from
// the (few) URL-ish literals: a per-call EXISTS subquery took from seconds to a minute on one graph.
// The literals are returned on their own because Ladybug returns no zero-hop path from a node
// type with no edges of that kind (a StringLiteral has no SON children).
const URL_TEXT = ["StringLiteral", "TemplateElement"].map(
    (label) => `
MATCH (t:${label}) WHERE t.value CONTAINS '/'
OPTIONAL MATCH (s)-[:SON*1..4]->(t)
RETURN DISTINCT t.id AS literal, s.id AS ancestor`
);

const URL_FLOWS = `
MATCH (s)-[:FLOWS_TO|ARGUMENT_TO|RETURNS_TO* ACYCLIC 1..8]->(x)
WHERE s.id IN $ids
RETURN DISTINCT x.id AS id`;

// The `X.create(config)` call (axios and lookalikes) a client object flows from, for its `baseURL`.
const CLIENT_FACTORY = (label: string) => `
MATCH (cr:CallExpression)-[:FLOWS_TO* ACYCLIC 1..6]->(o:\`${label}\`),
      (cr)-[k:SON]->(m:MemberExpression)-[p:SON]->(prop:Identifier)
WHERE o.id = $id AND k.key = 'callee' AND p.key = 'property' AND prop.name = 'create'
RETURN cr.id AS id LIMIT 1`;

// A call or `new` whose first argument is an object literal with a `url` key: `axios({url, method})`,
// `axios.request({...})`, `$.ajax({url, type})`, request-wrapper classes `new X({url, method})`.
const CONFIG_CALLS = `
MATCH (c)-[a:SON]->(o:ObjectExpression)-[ps:SON]->(p:ObjectProperty)-[pk:SON]->(k)
WHERE c.type IN ['CallExpression', 'NewExpression'] AND a.key = 'arguments' AND a.idx = 0
  AND ps.key = 'properties' AND pk.key = 'key' AND (k.name = 'url' OR k.value = 'url')
RETURN DISTINCT c.id AS id, c.file AS file, c.line AS line, o.id AS config, p.id AS urlProp`;

// An object with a `url` is an HTTP request config if it also has headers/data/body, or a `method` / `type` (jQuery)
// that is an HTTP verb or not a literal. SvelteKit's navigation objects carry `type: "link" | "popstate" | ...`.
const HTTP_VERB = /^(?:get|post|put|patch|delete|head|options)$/i;
const isRequestConfig = (o: Record<string, unknown>): boolean =>
    ["headers", "data", "body"].some((k) => k in o) ||
    [o.method, o.type].some((m) => typeof m === "string" && (HTTP_VERB.test(m) || m.startsWith("[")));

export interface ApiCall {
    kind: "fetch" | "XHR" | "client" | "config";
    /** The call's node id in the graph. */
    id: string;
    /** The graph file (a file path relative to the scanned directory, or a module id). */
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

const asObject = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};

const withBase = (base: string, url: string): string =>
    !base || /^https?:\/\//.test(url) ? url : `${base.replace(/\/$/, "")}/${url.replace(/^\//, "")}`;

/** Every fetch, XHR, HTTP-client and config-object call in a taintwire graph, with its URL variants, method, headers and body. */
export const resolveApiCalls = async (graph: taintwire.PookieGraph): Promise<ApiCall[]> => {
    const { query, kids, values, render } = makeResolver(graph);
    const calls: ApiCall[] = [];
    const calleeCode = async (id: string): Promise<string> => {
        const [c] = await kids(id, "callee");
        return c ? graph.code(c) : "";
    };

    // fetch-shaped calls: (url, { method, headers, body })
    const fetchLike = async (id: string, file: string, line: number, optionsIdx = 1): Promise<void> => {
        const args = await kids(id, "arguments");
        if (!args[0]) return;
        const o = asObject(args[optionsIdx] ? await render(args[optionsIdx]) : {});
        calls.push({
            kind: "fetch",
            id,
            file,
            line,
            urls: await values(args[0]),
            method: asMethod(asText(o.method)),
            headers: asHeaders(o.headers),
            body: asText(o.body),
        });
    };
    const seen = new Set<string>();
    for (const { id, file, line } of [...(await query(FETCH_CALLS)), ...(await query(DESTRUCTURED_FETCH_CALLS))]) {
        if (!seen.has(id)) await fetchLike(id, file, line);
        seen.add(id);
    }
    for (const { id, file, line, keyIdx } of await query(NUXT_FETCH_CALLS)) {
        if (!seen.has(id)) await fetchLike(id, file, line, keyIdx > 1 ? 1 : -1);
        seen.add(id);
    }

    // ponytail: one XHR instance's headers/body are merged into every open() on it, not split per request.
    const xhrs = new Map<string, { opens: ApiCall[]; headers: Record<string, string>; body: string }>();
    for (const { xhr, id, file, line, op } of await query(XHR_CALLS)) {
        if (!xhrs.has(xhr)) xhrs.set(xhr, { opens: [], headers: {}, body: "" });
        const inst = xhrs.get(xhr)!;
        const args = await kids(id, "arguments");
        if (op === "open" && args.length >= 2) {
            const method = asMethod((await values(args[0]))[0]);
            inst.opens.push({
                kind: "XHR",
                id,
                file,
                line,
                urls: await values(args[1]),
                method,
                headers: {},
                body: "",
            });
        } else if (op === "setRequestHeader" && args.length >= 2) {
            inst.headers[(await values(args[0]))[0] ?? ""] = (await values(args[1]))[0] ?? "";
        } else if (op === "send" && args.length > 0) {
            inst.body = asText(await render(args[0]));
        }
    }
    for (const { opens, headers, body } of xhrs.values()) {
        for (const call of opens) calls.push({ ...call, headers, body });
    }

    const candidates = await query(CLIENT_CALLS);
    const urlReachable = new Set<string>();
    if (candidates.length > 0) {
        for (const cypher of URL_TEXT) {
            for (const { literal, ancestor } of await query(cypher)) {
                urlReachable.add(literal);
                if (ancestor) urlReachable.add(ancestor);
            }
        }
        if (urlReachable.size > 0) {
            for (const { id } of await query(URL_FLOWS, { ids: [...urlReachable] })) urlReachable.add(id);
        }
    }
    for (const { id, file, line, verb, client, arg } of candidates) {
        if (!urlReachable.has(arg)) continue;
        const args = await kids(id, "arguments");
        // Drops Map.get / Headers.delete / EventBus.post lookalikes before they're logged, and keys
        // made only of placeholders around a `/` (`${a}/${b}`), which looksLikeUrl alone accepts.
        // Text that only has a `/` (`"<b>Hi</b> there"`) reaches Map/WeakMap .get() in framework code through linked
        // chunks: a URL has no raw whitespace, `<`, `>` or `"` outside placeholders.
        let urls = (await values(args[0])).filter((u) => {
            const literal = u.replace(/\[[^\]]*\]/g, "");
            return looksLikeUrl(u) && /\w/.test(literal) && !/[\s<>"]/.test(literal);
        });
        if (urls.length === 0) continue;
        const [factory] = await query(CLIENT_FACTORY(client.slice(0, client.lastIndexOf("_"))), { id: client });
        if (factory) {
            const [config] = await kids(factory.id, "arguments");
            const base = config ? asText(asObject(await render(config)).baseURL) : "";
            urls = urls.map((u) => withBase(base, u));
        }
        const hasBody = verb === "post" || verb === "put" || verb === "patch";
        const config = args[hasBody ? 2 : 1];
        calls.push({
            kind: "client",
            id,
            file,
            line,
            urls,
            method: verb.toUpperCase(),
            headers: config ? asHeaders(asObject(await render(config)).headers) : {},
            body: hasBody && args[1] ? asText(await render(args[1])) : "",
        });
    }

    for (const { id, file, line, config, urlProp } of await query(CONFIG_CALLS)) {
        if (seen.has(id)) continue;
        const [urlValue] = await kids(urlProp, "value");
        const o = asObject(await render(config));
        // A request config carries more than a url (`{url, method}`, `$.ajax({url, type})`). Framework runtimes pass
        // navigation state as `{url, params, route, ...}`, and with cross-chunk flow the app's route paths reach it.
        if (!isRequestConfig(o) && !/\.(?:request|ajax)$/.test(await calleeCode(id))) continue;
        calls.push({
            kind: "config",
            id,
            file,
            line,
            urls: urlValue ? await values(urlValue) : [],
            method: asMethod(asText(o.method ?? o.type)),
            headers: asHeaders(o.headers),
            body: asText(o.data ?? o.body),
        });
    }

    return calls;
};

/** Something to load into a graph: a file, or a bundler module. */
export interface GraphUnit {
    /** The graph filename; it must be unique and is what `ApiCall.file` reports. */
    name: string;
    size: number;
    code: () => string;
}

/**
 * Loads `units` into in-memory taintwire graphs of about MAX_GRAPH_BYTES each and calls `use` on
 * each graph before closing it. A unit over MAX_MAP_FILE_SIZE_BYTES is skipped: a graph's memory grows
 * with its source, and a lone oversized unit would still get a graph of its own.
 */
export const forEachGraph = async (
    units: GraphUnit[],
    use: (graph: taintwire.PookieGraph) => Promise<void>
): Promise<void> => {
    const batches: GraphUnit[][] = [[]];
    let batchBytes = 0;
    for (const unit of units) {
        if (tooBigForGraph(unit.name, unit.size)) continue;
        if (batchBytes + unit.size > MAX_GRAPH_BYTES && batches[batches.length - 1].length > 0) {
            batches.push([]);
            batchBytes = 0;
        }
        batches[batches.length - 1].push(unit);
        batchBytes += unit.size;
    }
    const nonEmpty = batches.filter((b) => b.length > 0);
    for (const [i, batch] of nonEmpty.entries()) {
        const kb = Math.ceil(batch.reduce((n, u) => n + u.size, 0) / 1024);
        printMsg(
            MSG.Info,
            `[i] taintwire graph ${i + 1}/${nonEmpty.length}: loading ${batch.map((u) => u.name).join(", ")} (${kb} KB)`
        );
        const start = Date.now();
        // The babel parser builds the same tree as cs-mast, recovers from syntax errors like
        // js-recon's own parser, and skips the per-node hash nothing here uses.
        const graph = await taintwire.PookieGraph.open(":memory:", { parser: "babel" });
        try {
            for (const unit of batch) {
                try {
                    await graph.add(unit.code(), unit.name);
                } catch (e) {
                    printMsg(MSG.Warn, `[!] taintwire could not load ${unit.name}: ${(e as Error).message}`);
                }
            }
            printMsg(MSG.Plain, `[i]   loaded in ${((Date.now() - start) / 1000).toFixed(1)}s`);
            await use(graph);
        } finally {
            await graph.close();
        }
    }
};

/**
 * Prints each call and registers every URL variant that passes the legacy filters (strict for
 * fetch/XHR/config objects, placeholder-tolerant for HTTP clients) with the OpenAPI collector.
 * Returns how many URLs were registered.
 */
export const emitApiCalls = (
    calls: ApiCall[],
    locate: (call: ApiCall) => { chunkId: string; functionFile: string; label: string }
): number => {
    let emitted = 0;
    for (const call of calls) {
        const { chunkId, functionFile, label } = locate(call);
        printMsg(MSG.Info, `[+] Found ${call.kind} call in ${label}`);
        for (const url of call.urls) printMsg(MSG.Run, `    URL: ${url}`);
        if (call.method !== "GET" || Object.keys(call.headers).length > 0 || call.body) {
            printMsg(MSG.Run, `    Method: ${call.method}`);
        }
        if (Object.keys(call.headers).length > 0) printMsg(MSG.Run, `    Headers: ${JSON.stringify(call.headers)}`);
        if (call.body) printMsg(MSG.Run, `    Body: ${call.body}`);

        const urlFilter = call.kind === "client" ? looksLikeUrl : looksLikeStrictUrl;
        for (const url of new Set(call.urls)) {
            if (!urlFilter(url)) continue;
            emitted++;
            globals.addOpenapiOutput({
                url,
                method: call.method,
                path: url,
                headers: call.headers,
                body: call.body,
                chunkId,
                functionFile,
                functionFileLine: call.line,
            });
        }
    }
    return emitted;
};

/**
 * Loads every file in `names` (relative to `directory`) into ONE linked taintwire graph with a single
 * addFiles() call, so values flow across chunks (bundler module registries, ES imports), and calls
 * `use` on it. The graph is on disk in a temp dir: a whole app in memory is too big. Files over
 * MAX_MAP_FILE_SIZE_BYTES are left out.
 */
export const withLinkedGraph = async (
    directory: string,
    names: string[],
    use: (graph: taintwire.PookieGraph) => Promise<void>
): Promise<void> => {
    const files = names.filter((f) => !tooBigForGraph(f, fs.statSync(path.join(directory, f)).size));
    if (files.length === 0) return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jsr-map-tw-"));
    try {
        const pgPath = path.join(tmp, "map.pg");
        await writeGraph(pgPath, directory, files, {});
        const graph = await taintwire.PookieGraph.open(pgPath, { parser: "babel" });
        try {
            await use(graph);
        } finally {
            await graph.close();
        }
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
};

/**
 * taintwire counterpart of the legacy directory-scan resolvers (vue_resolveFetch, vue_resolveXhr,
 * vue_resolveHttpClient), used for React, Vue/Nuxt, Svelte/Astro and Angular: loads every JS file
 * under `directory` into one linked taintwire graph, finds the calls with Cypher and registers each
 * URL variant with the OpenAPI output collector.
 */
const taintwire_resolveApiCalls = async (directory: string, frameworkName: string): Promise<void> => {
    printMsg(MSG.Header, `[i] Resolving ${frameworkName} API calls with taintwire`);

    let files: string[];
    try {
        files = listJsFiles(directory);
    } catch {
        printMsg(MSG.Err, `[!] Could not read directory: ${directory}`);
        return;
    }

    const calls: ApiCall[] = [];
    await withLinkedGraph(directory, files, async (graph) => {
        calls.push(...(await resolveApiCalls(graph)));
    });

    const emitted = emitApiCalls(calls, (call) => {
        const functionFile = path.join(directory, call.file);
        return { chunkId: `${call.file}:${call.line}`, functionFile, label: `"${functionFile}":${call.line}` };
    });
    printMsg(
        MSG.Run,
        `[✓] taintwire found ${calls.length} ${frameworkName} API call(s), ${emitted} URL(s) registered across ${files.length} file(s)`
    );
};

export default taintwire_resolveApiCalls;
