import path from "path";
import * as taintwire from "@js-recon/taintwire";
import { printMsg, MSG } from "../../../utility/printMsg.js";
import * as globals from "../../../utility/globals.js";
import { Chunks } from "../../../utility/interfaces.js";
import { isNextJsFrameworkChunk } from "../../babel-legacy/next_js/resolveFetch.js";
import { buildImportedBy, routeForChunk } from "../../babel-legacy/next_js/resolveServerActions.js";
import { ApiCall, GraphUnit, PREFILTER, emitApiCalls, forEachGraph, resolveApiCalls } from "../apiCalls.js";
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
    /** Module id the action is defined in. */
    file: string;
    line: number;
    actionId: string;
    actionName?: string;
    /** JSON array of argument hints (`<string:name>` or a literal), "" when no call site was found. */
    body: string;
    call?: { file: string; line: number };
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
export const resolveServerActions = async (graph: taintwire.TaintGraph): Promise<ServerAction[]> => {
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
            const site = call && { file: call.file, line: call.line };
            actions.push({ file, line, actionId, actionName: name, body, call: site });
        }
    }
    return actions;
};

/**
 * taintwire counterpart of the legacy Next.js resolvers (resolveFetch, resolveAxios,
 * resolveNewRequest, resolveServerActions): loads each webpack/turbopack module in `chunks` into a
 * taintwire graph under its module id, finds fetch / XHR / HTTP-client / config-object calls and
 * Server Actions with Cypher, and registers them with the OpenAPI output collector.
 */
const taintwire_next = async (chunks: Chunks, directory: string): Promise<void> => {
    printMsg(MSG.Header, "[i] Resolving Next.JS API calls and Server Actions with taintwire");

    // Next.js runtime modules (router, RSC, stylesheet loader) are skipped like the legacy resolver does.
    const units: GraphUnit[] = Object.values(chunks)
        .filter((c) => c.code && c.file && !isNextJsFrameworkChunk(c.code))
        .filter((c) => PREFILTER.test(c.code) || c.code.includes("createServerReference"))
        .map((c) => ({ name: c.id, size: c.code.length, code: () => c.code }));

    const calls: ApiCall[] = [];
    const actions: ServerAction[] = [];
    await forEachGraph(units, async (graph) => {
        calls.push(...(await resolveApiCalls(graph)));
        actions.push(...(await resolveServerActions(graph)));
    });

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
        `[✓] taintwire found ${calls.length} Next.JS API call(s) (${emitted} URL(s) registered) and ${seenActionIds.size} Server Action(s) across ${units.length} module(s)`
    );
};

export default taintwire_next;
