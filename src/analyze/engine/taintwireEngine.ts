import type { PGRule, PGSelector, PgqFinding, PgqLocation, PookieGraph } from "@js-recon/taintwire";
import { Rule } from "../types/index.js";
import { Chunks } from "../../utility/interfaces.js";
import { EngineOutput } from "../helpers/outputHelper.js";
import { GraphUnit, forEachGraph } from "../../map/taintwire/apiCalls.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

// Characters of the sink expression kept in findingLocation.
const MAX_CODE = 300;

const SEVERITY_MSG = { info: MSG.Header, low: MSG.Warn, medium: MSG.Info, high: MSG.Err, critical: MSG.Err } as const;

/** Rule metadata for an EngineOutput. */
export type FindingMeta = Pick<EngineOutput, "ruleName" | "ruleType" | "ruleDescription" | "ruleAuthor" | "ruleTech">;

/** Print a runPgq finding and turn it into an EngineOutput (the location plus up to 300 characters of the sink's code). */
export const toEngineOutput = async (graph: PookieGraph, f: PgqFinding, meta: FindingMeta): Promise<EngineOutput> => {
    const at = (x: PgqLocation) => `${x.file}:${x.line}:${x.col}`;
    const message = `[+] "${meta.ruleName}" found in chunk ${f.file}`;
    const code = (await graph.code(f.id)).slice(0, MAX_CODE);
    const via = f.source ? ` <- ${at(f.source)} (${f.hops} hops)` : "";
    printMsg(SEVERITY_MSG[f.severity], message);
    printMsg(MSG.Plain, `${at(f)}${via}\n${code}`);
    return { ruleId: f.ruleId, ...meta, severity: f.severity, message, findingLocation: `// ${at(f)}${via}\n\n${code}` };
};

/**
 * A YAML taintwire rule as a pgq rule. Steps run in order: each step's row ids are a Cypher parameter
 * (`$<step name>`) for the steps after it, so step k `uses` every earlier step (an empty one empties it, as a step
 * with no rows used to end the rule). `taintFrom` becomes `from`, with no hop limit unless the rule sets one. The
 * last step's rows are the findings.
 */
export const toPgRule = (rule: Rule): PGRule => {
    const steps: Record<string, PGSelector> = {};
    let last: PGSelector | undefined;
    let broken = false;
    for (const step of rule.steps) {
        const tw = step.taintwire!;
        const sel: PGSelector = { cypher: [tw.query].flat().map((query) => ({ query })), uses: { ...steps } };
        if (tw.taintFrom) {
            if (!steps[tw.taintFrom]) broken = true; // no such earlier step: nothing flows, so no findings
            sel.from = steps[tw.taintFrom];
            sel.mode = tw.mode ?? "deep";
            sel.maxHops = tw.maxHops ?? Number.POSITIVE_INFINITY;
        }
        steps[step.name] = last = sel;
    }
    const lastStep = rule.steps[rule.steps.length - 1];
    return {
        id: rule.id,
        name: rule.name,
        severity: rule.severity,
        message: lastStep?.message ?? rule.name,
        return: last && !broken ? [last] : [],
    };
};

/** Runs YAML taintwire `rules` on one graph through taintwire's pgq runner. */
export const runTaintwireRules = async (graph: PookieGraph, rules: Rule[]): Promise<EngineOutput[]> => {
    const { runPgq } = await import("@js-recon/taintwire");
    const byId = new Map(rules.map((r) => [r.id, r]));
    const { findings, errors } = await runPgq(graph, rules.map(toPgRule));
    for (const e of errors) printMsg(MSG.Err, `[!] taintwire rule ${e.ruleId} failed: ${e.message}`);
    const out: EngineOutput[] = [];
    for (const f of findings) {
        const r = byId.get(f.ruleId)!;
        out.push(
            await toEngineOutput(graph, f, {
                ruleName: r.name,
                ruleType: r.type,
                ruleDescription: r.description,
                ruleAuthor: r.author,
                ruleTech: r.tech,
            })
        );
    }
    return out;
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
