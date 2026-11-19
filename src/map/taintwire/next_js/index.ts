import fs from "fs";
import path from "path";
import * as taintwire from "@js-recon/taintwire";
import { printMsg, MSG } from "../../../utility/printMsg.js";
import * as globals from "../../../utility/globals.js";
import { Chunk, Chunks } from "../../../utility/interfaces.js";
import { isNextJsFrameworkChunk } from "../../babel-legacy/next_js/resolveFetch.js";
import { buildImportedBy, routeForChunk } from "../../babel-legacy/next_js/resolveServerActions.js";
import { ApiCall, emitApiCalls, resolveApiCalls, withLinkedGraph } from "../apiCalls.js";
import { makeResolver } from "../valueResolver.js";

// `createServerReference(actionId, callServer, …, actionName)`: called directly, as
// `X.createServerReference(...)`, or as `(0, X.createServerReference)(...)`. One fixed-shape pattern
// per callee form, anchored on the identifier: a single pattern with a variable-length SON hop
// joined every call with every string argument first and took minutes on a 360 KB graph.
const SERVER_ACTIONS = [
    `MATCH (c:CallExpression)-[k:SON]->(i:Identifier)
     WHERE i.name = 'createServerReference' AND k.key = 'callee'
     RETURN c.id AS id, c.file AS file, c.line AS line`,
    `MATCH (c:CallExpression)-[k:SON]->(m:MemberExpression)-[pk:SON]->(i:Identifier)
     WHERE i.name = 'createServerReference' AND pk.key = 'property' AND k.key = 'callee'
     RETURN c.id AS id, c.file AS file, c.line AS line`,
    `MATCH (c:CallExpression)-[k:SON]->(:SequenceExpression)-[e:SON]->(m:MemberExpression)-[pk:SON]->(i:Identifier)
     WHERE i.name = 'createServerReference' AND pk.key = 'property' AND e.key = 'expressions' AND k.key = 'callee'
     RETURN c.id AS id, c.file AS file, c.line AS line`,
];

// Where the action reference is called: the createServerReference(...) result flowing to a callee.
const ACTION_CALLS = `
MATCH (r:CallExpression)-[:FLOWS_TO* ACYCLIC 1..6]->(callee)<-[k:SON]-(c:CallExpression)
WHERE r.id = $id AND k.key = 'callee'
RETURN c.id AS id, c.file AS file, c.line AS line LIMIT 1`;

export interface ServerAction {
    /** The createServerReference call's node id. */
    id: string;
    /** The graph file the action is defined in. */
    file: string;
    line: number;
    actionId: string;
    actionName?: string;
    /** JSON array of argument hints (`<string:name>` or a literal), "" when no call site was found. */
    body: string;
    call?: { id: string; file: string; line: number };
}

// Same hint format as the legacy resolver: literals as-is, anything unresolved as `<string:name>`.
const hint = (value: string | undefined): string => {
    if (value === undefined) return "<string:arg>";
    if (!value.startsWith("[")) return value;
    const name = /([\w$]+)(?:\(\))?\]$/.exec(value)?.[1];
    return `<string:${name ?? "arg"}>`;
};

/**
 * Every `createServerReference(...)` in a taintwire graph, with its call-site argument hints when
 * the reference is called in the same module (cross-module calls aren't followed).
 */
export const resolveServerActions = async (graph: taintwire.PookieGraph): Promise<ServerAction[]> => {
    const { query, kids, values } = makeResolver(graph);
    const actions: ServerAction[] = [];
    for (const cypher of SERVER_ACTIONS) {
        for (const { id, file, line } of await query(cypher)) {
            const args = await kids(id, "arguments");
            const actionId = args[0]?.startsWith("StringLiteral_") ? (await values(args[0]))[0] : "";
            if (!/^[0-9a-f]{40,}$/i.test(actionId)) continue;
            const name = args[4]?.startsWith("StringLiteral_") ? (await values(args[4]))[0] : undefined;
            const [call] = await query(ACTION_CALLS, { id });
            let body = "";
            if (call) {
                const hints: string[] = [];
                for (const a of await kids(call.id, "arguments")) hints.push(hint((await values(a))[0]));
                if (hints.length > 0) body = JSON.stringify(hints);
            }
            const site = call && { id: call.id, file: call.file, line: call.line };
            actions.push({ id, file, line, actionId, actionName: name, body, call: site });
        }
    }
    return actions;
};

/** A module's span in its chunk file. */
interface ModuleSpan {
    chunk: Chunk;
    start: number;
    end: number;
}

/**
 * Where each module of `chunks` sits in its chunk file. The legacy extractors store a factory's own
 * source behind a rewritten prefix (`func_<id> = ` or `function webpack_<id> `), so the rest of it is
 * found verbatim in the file.
 */
export const moduleSpans = (chunks: Chunks, directory: string): Map<string, ModuleSpan[]> => {
    const byFile = new Map<string, ModuleSpan[]>();
    const texts = new Map<string, string>();
    for (const chunk of Object.values(chunks)) {
        if (!chunk.code || !chunk.file) continue;
        if (!texts.has(chunk.file)) {
            const p = path.join(directory, chunk.file);
            texts.set(chunk.file, fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "");
        }
        const body = chunk.code.replace(/^(?:func_[\w$]+ = |function webpack_[\w$]+ )/, "");
        const start = texts.get(chunk.file)!.indexOf(body);
        if (start < 0) continue;
        if (!byFile.has(chunk.file)) byFile.set(chunk.file, []);
        byFile.get(chunk.file)!.push({ chunk, start, end: start + body.length });
    }
    return byFile;
};

/** The innermost module of `spans` containing `offset` of `file`. */
const moduleAt = (spans: Map<string, ModuleSpan[]>, file: string, offset: number): Chunk | undefined => {
    let best: ModuleSpan | undefined;
    for (const s of spans.get(file) ?? [])
        if (s.start <= offset && offset < s.end && (!best || s.end - s.start < best.end - best.start)) best = s;
    return best?.chunk;
};

const startOffset = async (graph: taintwire.PookieGraph, id: string): Promise<number> => {
    const label = id.slice(0, id.lastIndexOf("_"));
    const [r] = await graph.query(`MATCH (n:\`${label}\`) WHERE n.id = $id RETURN n.startOffset AS o`, { id });
    return Number(r?.o ?? -1);
};

/**
 * taintwire counterpart of the legacy Next.js resolvers (resolveFetch, resolveAxios,
 * resolveNewRequest, resolveServerActions): loads the chunk files the modules of `chunks` come from
 * into one linked taintwire graph, so values flow between modules through the webpack/Turbopack
 * registry, finds fetch / XHR / HTTP-client / config-object calls and Server Actions with Cypher,
 * maps each back to the module it's in and registers it with the OpenAPI output collector.
 */
const taintwire_next = async (chunks: Chunks, directory: string): Promise<void> => {
    printMsg(MSG.Header, "[i] Resolving Next.JS API calls and Server Actions with taintwire");

    const spans = moduleSpans(chunks, directory);
    const files = [...new Set(Object.values(chunks).map((c) => c.file))].filter(
        (f) => f && fs.existsSync(path.join(directory, f))
    );

    // Each result is re-keyed to the module it sits in. Calls outside every module (webpack runtime) and
    // inside Next.js runtime modules (router, RSC, stylesheet loader) are dropped like the legacy resolver does.
    const calls: ApiCall[] = [];
    const actions: ServerAction[] = [];
    let dropped = 0;
    const rekey = async (graph: taintwire.PookieGraph, id: string, file: string): Promise<string | undefined> => {
        const chunk = moduleAt(spans, file, await startOffset(graph, id));
        if (!chunk || isNextJsFrameworkChunk(chunk.code)) return undefined;
        return chunk.id;
    };
    await withLinkedGraph(directory, files, async (graph) => {
        for (const call of await resolveApiCalls(graph)) {
            const mod = await rekey(graph, call.id, call.file);
            if (mod === undefined) dropped++;
            else calls.push({ ...call, file: mod });
        }
        for (const action of await resolveServerActions(graph)) {
            const mod = await rekey(graph, action.id, action.file);
            if (mod === undefined) {
                dropped++;
                continue;
            }
            const callMod = action.call && (await rekey(graph, action.call.id, action.call.file));
            const call = action.call && callMod !== undefined ? { ...action.call, file: callMod } : undefined;
            actions.push({ ...action, file: mod, call });
        }
    });
    if (dropped > 0) printMsg(MSG.Info, `[i] Skipped ${dropped} call(s) in Next.js runtime code`);

    const emitted = emitApiCalls(calls, (call) => {
        const functionFile = path.join(directory, chunks[call.file].file);
        return { chunkId: call.file, functionFile, label: `chunk ${call.file} ("${functionFile}":${call.line})` };
    });

    const importedBy = buildImportedBy(chunks);
    const seenActionIds = new Set<string>();
    for (const action of actions) {
        if (seenActionIds.has(action.actionId)) continue;
        seenActionIds.add(action.actionId);
        const chunk = chunks[action.file];
        const route = routeForChunk(chunks, importedBy, chunk);
        const label = action.actionName ? `${action.actionName} (${action.actionId})` : action.actionId;
        printMsg(MSG.Info, `[+] Server Action '${label}' at route '${route}' (chunk ${chunk.id})`);
        if (action.body) printMsg(MSG.Run, `    Args: ${action.body}`);
        globals.addOpenapiOutput({
            url: route,
            method: "POST",
            path: route,
            headers: {
                Accept: "text/x-component",
                "next-action": action.actionId,
                "Content-Type": "text/plain;charset=UTF-8",
            },
            body: action.body,
            chunkId: chunk.id,
            functionFile: path.resolve(directory, chunk.file),
            functionFileLine: action.line,
            summary: action.actionName,
            serverActionCallChunkId: action.call?.file,
            serverActionCallFile: action.call ? path.resolve(directory, chunks[action.call.file].file) : undefined,
            serverActionCallLine: action.call?.line,
        });
    }

    printMsg(
        MSG.Run,
        `[✓] taintwire found ${calls.length} Next.JS API call(s) (${emitted} URL(s) registered) and ${seenActionIds.size} Server Action(s) across ${files.length} chunk file(s)`
    );
};

export default taintwire_next;
