import type { PGRule, PGSelector, PgqFinding, PgqLocation, PookieGraph } from "@js-recon/taintwire";
import { Rule } from "../types/index.js";
import { Chunks } from "../../utility/interfaces.js";
import { EngineInterceptor, EngineOutput } from "../helpers/outputHelper.js";
import { GraphUnit, withLinkedUnits } from "../../map/taintwire/apiCalls.js";
import { printMsg, MSG } from "../../utility/printMsg.js";
import { getTaintwireIncludeVendor } from "../../utility/globals.js";

// Characters of the sink expression kept in findingLocation.
const MAX_CODE = 300;

const SEVERITY_MSG = { info: MSG.Header, low: MSG.Warn, medium: MSG.Info, high: MSG.Err, critical: MSG.Err } as const;

// shortcut: a fixed list of popular unbundled library builds; add a name/banner when another one shows up slow in a scan.
const VENDOR_FILE =
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored, bounded optional groups
    /(?:^|\/)(?:react|react-dom|angular(?:[._-]\d+(?:[._-]\d+)*)?|jquery(?:-\d+(?:\.\d+)*)?|vue|lodash|moment)(?:\.(?:development|production|prod|global|runtime))*(?:\.min)?\.js$/i;
const VENDOR_BANNER =
    /@license React|AngularJS v\d|jQuery (?:JavaScript Library )?v\d|Vue\.js v\d|@license Lodash|\/\/! moment\.js/;

/**
 * True for a chunk that is a known vendor library build (React/ReactDOM/AngularJS/jQuery/Vue/lodash/moment),
 * by the file name on its `// File Source:` line or a banner in its first 2 KB. Such files are large, unminified
 * on sites without a bundler, and hold no app code, so taintwire skips them unless --taintwire-include-vendor.
 */
export const isVendorChunk = (code: string): boolean => {
    // TODO in addition to simple regex, have CS-MAST signatures for the vendor libraries
    const head = code.slice(0, 2048);
    const src = /^\/\/ File Source: (\S+)/.exec(head)?.[1];
    let file = src ?? "";
    try {
        if (src) file = new URL(src).pathname;
    } catch {
        // not a URL: match the raw value
    }
    return VENDOR_FILE.test(file) || VENDOR_BANNER.test(head);
};

/** Rule metadata for an EngineOutput. */
export type FindingMeta = Pick<EngineOutput, "ruleName" | "ruleType" | "ruleDescription" | "ruleAuthor" | "ruleTech">;

/**
 * Print a runPgq finding and turn it into an EngineOutput: the rule's own message (its diagnostic), and the location
 * plus up to 300 characters of the sink's code. The console line names the rule and the chunk.
 */
export const toEngineOutput = async (graph: PookieGraph, f: PgqFinding, meta: FindingMeta): Promise<EngineOutput> => {
    const at = (x: PgqLocation) => `${x.file}:${x.line}:${x.col}`;
    const message = `[+] "${meta.ruleName}" found in chunk ${f.file}`;
    const code = (await graph.code(f.id)).slice(0, MAX_CODE);
    const via = f.source ? ` <- ${at(f.source)} (${f.hops} hops)` : "";
    printMsg(SEVERITY_MSG[f.severity], message);
    printMsg(MSG.Plain, `${at(f)}${via}\n${code}`);
    const interceptors: EngineInterceptor[] = [];
    for (const i of f.interceptors ?? []) {
        const src = (await graph.code(i.id)).replace(/\s+/g, " ").slice(0, MAX_CODE);
        interceptors.push({ kind: i.kind, text: i.text, location: at(i), code: src });
    }
    if (interceptors.length) {
        // guards (if/ternary/and-or/early-exit) carry the polarity; the checks below them describe their parts
        const lines = interceptors.map((i) =>
            i.kind === "check"
                ? `      ${i.location} ${i.text}: ${i.code}`
                : `    ${i.location} ${i.kind}, ${i.text}: ${i.code}`
        );
        printMsg(MSG.Info, `[i] Conditions before the sink:\n${lines.join("\n")}`);
    }
    return {
        ruleId: f.ruleId,
        ...meta,
        severity: f.severity,
        message: f.message,
        findingLocation: `// ${at(f)}${via}\n\n${code}`,
        ...(interceptors.length ? { interceptors } : {}),
    };
};

/**
 * A YAML taintwire rule as a pgq rule. Steps run in order: each step's row ids are a Cypher parameter
 * (`$<step name>`) for the steps after it, so step k `uses` every earlier step (an empty one empties it, as a step
 * with no rows used to end the rule). `taintFrom` becomes `from`, with no hop limit unless the rule sets one. The
 * last step's rows are the findings. A `taintFrom` or `requires` that names no earlier step leaves the rule without
 * findings, as in the AST engine, where such a step never completes.
 */
export const toPgRule = (rule: Rule): PGRule => {
    // A Map, so a step name such as `toString` or `__proto__` can't resolve to an Object.prototype member.
    const steps = new Map<string, PGSelector>();
    let last: PGSelector | undefined;
    let broken = false;
    for (const step of rule.steps) {
        const tw = step.taintwire!;
        const sel: PGSelector = {
            cypher: [tw.query].flat().map((query) => ({ query })),
            uses: Object.fromEntries(steps),
        };
        if (step.requires?.some((r) => !steps.has(r))) broken = true;
        if (tw.taintFrom) {
            if (!steps.has(tw.taintFrom)) broken = true; // no such earlier step: nothing flows, so no findings
            sel.from = steps.get(tw.taintFrom);
            sel.mode = tw.mode ?? "deep";
            sel.maxHops = tw.maxHops ?? Number.POSITIVE_INFINITY;
        }
        steps.set(step.name, (last = sel));
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

/** Findings of a taintwire run, and the ids of the rules that failed (their findings are missing). */
export interface TaintwireRunResult {
    findings: EngineOutput[];
    failedRules: string[];
}

/**
 * Runs YAML taintwire `rules` on one graph through taintwire's pgq runner, one rule at a time so each prints its
 * progress and `onRule` can save findings as they come (selectors aren't shared across YAML rules, so nothing is lost).
 */
export const runTaintwireRules = async (
    graph: PookieGraph,
    rules: Rule[],
    onRule?: (run: TaintwireRunResult) => void
): Promise<TaintwireRunResult> => {
    const { runPgq } = await import("@js-recon/taintwire");
    const out: EngineOutput[] = [];
    const failedRules: string[] = [];
    for (const [i, r] of rules.entries()) {
        const start = Date.now();
        const { findings, errors } = await runPgq(graph, [toPgRule(r)]);
        for (const e of errors) printMsg(MSG.Err, `[!] taintwire rule ${e.ruleId} failed: ${e.message}`);
        const run: TaintwireRunResult = { findings: [], failedRules: errors.map((e) => e.ruleId) };
        for (const f of findings) {
            run.findings.push(
                await toEngineOutput(graph, f, {
                    ruleName: r.name,
                    ruleType: r.type,
                    ruleDescription: r.description,
                    ruleAuthor: r.author,
                    ruleTech: r.tech,
                })
            );
        }
        printMsg(
            MSG.Plain,
            `[i]   rule ${i + 1}/${rules.length} ${r.id}: ${run.findings.length} finding(s) in ${((Date.now() - start) / 1000).toFixed(1)}s`
        );
        for (const f of run.findings) out.push(f);
        for (const id of run.failedRules) failedRules.push(id);
        onRule?.(run);
    }
    return { findings: out, failedRules };
};

/**
 * Loads the chunks of `mapped.json` into ONE linked taintwire graph (on disk) and runs the rules on it, so a flow
 * can cross chunks: bundler module registries, ES imports, and the global scope classic scripts share. The prefilter
 * applies to that linked unit: a rule runs if its prefilter matches any chunk (or it has none), and every chunk is
 * loaded, since the sink can sit in a chunk with no source. Known vendor library chunks are skipped unless
 * --taintwire-include-vendor. A rule that fails is listed in `failedRules`. `onProgress` gets the findings so far
 * after each rule, so a caller can save partial results.
 */
const taintwireEngine = async (
    rules: Rule[],
    chunks: Chunks,
    onProgress?: (findings: EngineOutput[]) => void
): Promise<TaintwireRunResult> => {
    const vendor: string[] = [];
    const loaded = Object.values(chunks)
        .filter((c) => c.code)
        .filter((c) => getTaintwireIncludeVendor() || !isVendorChunk(c.code) || (vendor.push(c.id), false));
    if (vendor.length > 0)
        printMsg(
            MSG.Info,
            `[i] Skipped ${vendor.length} vendor chunk(s) for taintwire (${vendor.join(", ")}); pass --taintwire-include-vendor to scan them`
        );
    const active = rules.filter((r) => !r.prefilter || loaded.some((c) => new RegExp(r.prefilter!).test(c.code)));
    printMsg(
        MSG.Header,
        `[i] Running ${active.length} of ${rules.length} taintwire rule(s) on one linked graph of ${loaded.length} of ${Object.keys(chunks).length} chunk(s)`
    );

    const findings: EngineOutput[] = [];
    const failed = new Set<string>();
    if (active.length === 0) return { findings, failedRules: [] };
    const units: GraphUnit[] = loaded.map((c) => ({ name: c.id, size: c.code.length, code: () => c.code }));
    const start = Date.now();
    await withLinkedUnits(units, async (graph) => {
        printMsg(MSG.Plain, `[i]   loaded in ${((Date.now() - start) / 1000).toFixed(1)}s`);
        await runTaintwireRules(graph, active, (run) => {
            for (const f of run.findings) findings.push(f);
            for (const id of run.failedRules) failed.add(id);
            onProgress?.(findings);
        });
    });
    return { findings, failedRules: [...failed] };
};

export default taintwireEngine;
