import type { TaintGraph } from "@js-recon/taintwire";
import { Rule, TaintwireStep } from "../types/index.js";
import { Chunks } from "../../utility/interfaces.js";
import { EngineOutput } from "../helpers/outputHelper.js";
import { GraphUnit, forEachGraph } from "../../map/taintwire/apiCalls.js";
import { makeResolver } from "../../map/taintwire/valueResolver.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

// Value-flow queries shared by every taintwire rule. FLOWS_TO
// doesn't cross unresolved calls or member reads (`new URLSearchParams(location.search).get("q")`,
// `location.hash.slice(1)`), so lenient/deep widen a source to the expressions wrapping it and a
// sink to the expressions inside it, up to 3 levels.
const WRAP = "['object', 'callee', 'arguments', 'argument', 'expression', 'expressions', 'quasis']";
const WIDEN_SOURCE = `MATCH (s)-[e:SON*0..3]->(m) WHERE m.id IN $S AND all(r IN rels(e) WHERE r.key IN ${WRAP})
RETURN DISTINCT m.id AS anchor, s.id AS id`;
const WIDEN_SINK = `MATCH (x)-[e:SON*0..3]->(y) WHERE x.id IN $X AND all(r IN rels(e) WHERE r.key IN ${WRAP} OR r.key IN ['left', 'right', 'consequent', 'alternate'])
RETURN DISTINCT x.id AS anchor, y.id AS id`;
const FLOW = `MATCH p = (s)-[:FLOWS_TO|ARGUMENT_TO|RETURNS_TO* SHORTEST 1..30]->(x)
WHERE s.id IN $S AND x.id IN $X
RETURN s.id AS s, x.id AS x, length(p) AS hops`;
const REACH = `MATCH p = (s)-[:FLOWS_TO|ARGUMENT_TO|RETURNS_TO* SHORTEST 1..30]->(x)
WHERE s.id IN $S
RETURN s.id AS s, x.id AS x, length(p) AS hops`;
// Deep mode rounds: each one gets a value past one more opaque call or member read.
const DEEP_ROUNDS = 4;
// Characters of the sink expression kept in findingLocation.
const MAX_CODE = 300;

type Row = Record<string, any>;
type Query = (cypher: string | string[], params?: Record<string, unknown>) => Promise<Row[]>;
interface Hit {
    source: string;
    sink: string;
    hops: number;
}

const SEVERITY_MSG = { info: MSG.Header, low: MSG.Warn, medium: MSG.Info, high: MSG.Err } as const;

/** `ids` mapped to themselves, plus every node the widening query returns for them (node -> the id it widens). */
const widen = async (q: Query, cypher: string, key: string, ids: string[]): Promise<Map<string, string>> => {
    const m = new Map(ids.map((id) => [id, id]));
    for (const r of await q(cypher, { [key]: ids })) if (!m.has(r.id)) m.set(r.id, r.anchor);
    return m;
};

/** Every sink in `sinks` that a source in `sources` reaches, with the shortest hop count found. */
export const flows = async (
    q: Query,
    sources: string[],
    sinks: string[],
    mode: NonNullable<TaintwireStep["mode"]>
): Promise<Hit[]> => {
    const best = new Map<string, Hit>();
    const add = (source: string, sink: string, hops: number) => {
        if (!best.has(sink) || best.get(sink)!.hops > hops) best.set(sink, { source, sink, hops });
    };
    if (!sources.length || !sinks.length) return [];
    const X = mode === "strict" ? new Map(sinks.map((id) => [id, id])) : await widen(q, WIDEN_SINK, "X", sinks);

    if (mode !== "deep") {
        const S =
            mode === "strict" ? new Map(sources.map((id) => [id, id])) : await widen(q, WIDEN_SOURCE, "S", sources);
        for (const [id, source] of S) if (X.has(id)) add(source, X.get(id)!, 0); // source inside the sink expression
        for (const r of await q(FLOW, { S: [...S.keys()], X: [...X.keys()] })) add(S.get(r.s)!, X.get(r.x)!, r.hops);
        return [...best.values()];
    }

    // deep: widen whatever the previous round reached and flow again, so
    // `p = new URLSearchParams(location.search); t = p.get("k"); sink(t)` survives both opaque steps
    const origin = new Map(sources.map((id) => [id, { source: id, hops: 0 }]));
    let frontier = [...sources];
    for (let i = 0; i < DEEP_ROUNDS && frontier.length; i++) {
        for (const r of await q(WIDEN_SOURCE, { S: frontier })) {
            if (!origin.has(r.id)) {
                origin.set(r.id, origin.get(r.anchor)!);
                frontier.push(r.id);
            }
        }
        const next: string[] = [];
        for (const r of await q(REACH, { S: frontier })) {
            if (!origin.has(r.x)) {
                const o = origin.get(r.s)!;
                origin.set(r.x, { source: o.source, hops: o.hops + r.hops });
                next.push(r.x);
            }
        }
        frontier = next;
    }
    for (const [id, sink] of X) {
        const o = origin.get(id);
        if (o) add(o.source, sink, o.hops);
    }
    return [...best.values()];
};

/**
 * Runs `rules` on one graph. Steps run in order; each step's row ids are a Cypher parameter
 * (`$<step name>`) for the steps after it, a step with `taintFrom` keeps only the rows a value
 * from that step flows into, and a step with no rows ends the rule. The last step's rows are the
 * findings.
 */
export const runTaintwireRules = async (graph: TaintGraph, rules: Rule[]): Promise<EngineOutput[]> => {
    const { query } = makeResolver(graph);
    const q: Query = async (cypher, params = {}) => {
        // concat, not push(...rows): a large graph's flow query can return more rows than fit in an argument list
        let rows: Row[] = [];
        for (const c of [cypher].flat()) rows = rows.concat(await query(c, params));
        return rows;
    };
    await query("CALL var_length_extend_max_depth=60");

    const findings: EngineOutput[] = [];
    for (const rule of rules) {
        try {
            const ids: Record<string, string[]> = {};
            const rowById = new Map<string, Row>();
            const hits = new Map<string, Hit>();
            let rows: Row[] = [];
            for (const step of rule.steps) {
                const tw = step.taintwire!;
                rows = [...new Map((await q(tw.query, ids)).map((r) => [r.id, r])).values()];
                if (tw.taintFrom) {
                    for (const h of await flows(
                        q,
                        ids[tw.taintFrom] ?? [],
                        rows.map((r) => r.id),
                        tw.mode ?? "deep"
                    )) {
                        if (tw.maxHops === undefined || h.hops <= tw.maxHops) hits.set(h.sink, h);
                    }
                    rows = rows.filter((r) => hits.has(r.id));
                }
                for (const r of rows) rowById.set(r.id, r);
                ids[step.name] = rows.map((r) => r.id);
                if (!rows.length) break;
            }

            for (const r of rows) {
                const at = (x: Row) => `${x.file}:${x.line}:${x.col}`;
                const hit = hits.get(r.id);
                const source = hit && rowById.get(hit.source);
                const message = `[+] "${rule.name}" found in chunk ${r.file}`;
                const code = (await graph.code(r.id)).slice(0, MAX_CODE);
                const via = source ? ` <- ${at(source)} (${hit!.hops} hops)` : "";
                printMsg(SEVERITY_MSG[rule.severity], message);
                printMsg(MSG.Plain, `${at(r)}${via}\n${code}`);
                findings.push({
                    ruleId: rule.id,
                    ruleName: rule.name,
                    ruleType: rule.type,
                    ruleDescription: rule.description,
                    ruleAuthor: rule.author,
                    ruleTech: rule.tech,
                    severity: rule.severity,
                    message,
                    findingLocation: `// ${at(r)}${via}\n\n${code}`,
                });
            }
        } catch (e) {
            printMsg(MSG.Err, `[!] taintwire rule ${rule.id} failed: ${(e as Error).message}`);
        }
    }
    return findings;
};

/**
 * Loads the chunks of `mapped.json` into taintwire graphs (one graph file per chunk, about 2 MB of
 * source per graph) and runs every rule on each. A chunk is loaded only if some rule's prefilter
 * matches it, or some rule has none: taintwire builds no cross-chunk edges, so a chunk without a
 * source can't produce a finding.
 */
const taintwireEngine = async (rules: Rule[], chunks: Chunks): Promise<EngineOutput[]> => {
    const filters = rules.map((r) => (r.prefilter ? new RegExp(r.prefilter) : null));
    const units: GraphUnit[] = Object.values(chunks)
        .filter((c) => c.code && filters.some((f) => !f || f.test(c.code)))
        .map((c) => ({ name: c.id, size: c.code.length, code: () => c.code }));
    printMsg(
        MSG.Header,
        `[i] Running ${rules.length} taintwire rule(s) on ${units.length} of ${Object.keys(chunks).length} chunk(s)`
    );

    const findings: EngineOutput[] = [];
    await forEachGraph(units, async (graph) => {
        for (const f of await runTaintwireRules(graph, rules)) findings.push(f);
    });
    return findings;
};

export default taintwireEngine;
