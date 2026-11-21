import fs from "fs";
import os from "os";
import path from "path";
import * as tar from "tar";
import type { PgqFinding, PgqLocation } from "@js-recon/taintwire";
import chalk from "chalk";
import cliProgress from "cli-progress";
import { printMsg, MSG } from "../utility/printMsg.js";
import { activateBarLogger, computeBarSize, watchBarResize, withProgressResources } from "../utility/progressLog.js";
import { listFilesRecursive, listJsFiles } from "../utility/listFiles.js";
import { initTaintwireQueries } from "../analyze/helpers/initRules.js";
import CONFIG from "../globalConfig.js";

// Same per-file cap as map's taintwire resolvers: bigger files are vendor bundles that cost more than they find.
const MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024;

/** The .pgq files at `queries` (one file, or a directory searched recursively). Exits 40 if there are none. */
const pgqFiles = (queries: string): string[] => {
    if (!fs.existsSync(queries)) {
        printMsg(MSG.Err, `[!] Queries ${queries} do not exist`);
        process.exit(40);
    }
    const files = fs.statSync(queries).isDirectory() ? listFilesRecursive(queries, [".pgq"]) : [queries];
    if (!files.length) {
        printMsg(MSG.Err, `[!] No .pgq files found in ${queries}`);
        process.exit(40);
    }
    return files;
};

/** Evaluate and validate `.pgq` files; prints every problem and exits 40 if there is one. */
const loadQueries = async (queries: string) => {
    const tw = await import("@js-recon/taintwire");
    const files = pgqFiles(queries);
    const { rules, errors } = await tw.loadPgq(files);
    for (const e of errors) printMsg(MSG.Err, `[!] ${e}`);
    if (errors.length) {
        printMsg(MSG.Err, `[!] ${errors.length} problem(s) in the .pgq files`);
        process.exit(40);
    }
    return { tw, files, rules };
};

// Visible characters of the bar's format around [{bar}], with a short label and detail.
const BAR_OVERHEAD = 60;

/** A progress bar while `work` runs; `work` gets `update(label, done, total, detail)`. Prints nothing off a TTY. */
const withBar = async <T>(
    work: (update: (label: string, done: number, total: number, detail?: string) => void) => Promise<T>
): Promise<T> => {
    const bar = new cliProgress.SingleBar(
        {
            format: chalk.cyan("[i] {label} ") + "[{bar}] {value}/{total} {detail}",
            barCompleteChar: "█",
            barIncompleteChar: "░",
            barsize: computeBarSize(BAR_OVERHEAD),
            hideCursor: false,
            clearOnComplete: false,
            stopOnComplete: false,
        },
        cliProgress.Presets.shades_classic
    );
    let label: string | undefined;
    const update = (l: string, done: number, total: number, detail = "") => {
        if (l !== label) {
            if (label !== undefined) bar.stop(); // keep the finished stage on its own line
            bar.start(total, done, { label: (label = l), detail });
        } else {
            bar.setTotal(total);
            bar.update(done, { detail });
        }
    };
    const stopWatcher = watchBarResize(bar, BAR_OVERHEAD);
    const releaseLogger = activateBarLogger(
        { log: (s: string) => process.stdout.write("\r\x1b[K" + s) },
        process.stdout.isTTY === true
    );
    return withProgressResources(
        () => work(update),
        () => label !== undefined && bar.stop(),
        stopWatcher,
        releaseLogger
    );
};

/** Ladybug's buffer pool (MB) and query threads; unset means taintwire's defaults. */
export type Limits = { bufferPoolMB?: number; threads?: number };

/** The JS files `names` (relative to `directory`) as addFiles() input. */
const readFiles = (directory: string, names: string[]) =>
    names.map((f) => ({ filename: f, code: fs.readFileSync(path.join(directory, f), "utf-8") }));

/** Write one linked PookieGraph of `files` to `pgPath`; removes it again on failure. */
export const writeGraph = async (
    pgPath: string,
    files: { filename: string; code: string }[],
    limits: Limits,
    unit = ""
) => {
    const { PookieGraph } = await import("@js-recon/taintwire");
    // On disk, not in memory: a whole app in memory takes about 10 KB of RAM per byte of minified source.
    const graph = await PookieGraph.open(pgPath, { parser: "babel", ...limits });
    try {
        await graph.query("CALL auto_checkpoint=false");
        // one call, so chunks are linked through the bundler's module registry
        const STAGES = { parse: "Parsing files", link: "Linking", load: "Loading graph rows" };
        await withBar((update) =>
            graph.addFiles(files, (stage, done, total) => update(unit + STAGES[stage], done, total))
        );
        await graph.query("CHECKPOINT");
        await graph.close();
    } catch (e) {
        await graph.close().catch(() => {});
        for (const f of [pgPath, `${pgPath}.wal`, `${pgPath}.shadow`]) fs.rmSync(f, { force: true });
        throw e;
    }
};

/**
 * Build `output` from every JS file under `directory`: one linked PookieGraph (.pg) of every file. A `.tw` output is
 * instead a tar of one PookieGraph per unit (a file plus the files it loads through the bundler's module registry, see
 * taintwire's planUnits) and a manifest.json. It only saves memory when no unit is close to the whole app: chunks
 * every unit loads, such as a framework or vendor chunk, are loaded again into each unit.
 */
export const build = async (directory: string, output: string, limits: Limits = {}) => {
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
        printMsg(MSG.Err, `[!] Directory ${directory} does not exist`);
        process.exit(37);
    }
    if (fs.existsSync(output)) {
        printMsg(MSG.Err, `[!] Output ${output} already exists`);
        process.exit(38);
    }

    const names: string[] = [];
    for (const file of listJsFiles(directory)) {
        const size = fs.statSync(path.join(directory, file)).size;
        if (size > MAX_FILE_SIZE_BYTES) {
            printMsg(MSG.Warn, `[!] Skipping ${file} (${(size / 1024 / 1024).toFixed(1)} MB > 8 MB limit)`);
            continue;
        }
        names.push(file);
    }
    if (!names.length) {
        printMsg(MSG.Err, `[!] No .js/.mjs files found in ${directory}`);
        process.exit(37);
    }

    const started = Date.now();
    if (!output.endsWith(".tw")) {
        printMsg(MSG.Header, `[i] Building a PookieGraph from ${names.length} file(s) into ${output}`);
        await writeGraph(output, readFiles(directory, names), limits);
    } else {
        const tw = await import("@js-recon/taintwire");
        // A fresh directory next to the output (same disk), so cleanup never touches anything else.
        const tmp = fs.mkdtempSync(path.join(path.dirname(path.resolve(output)), ".jsr-tw-"));
        try {
            // One file at a time: only its module ids are kept.
            const links = new Map(
                names.map((f) => [f, tw.moduleLinks(fs.readFileSync(path.join(directory, f), "utf-8"), f, "babel")])
            );
            const units = tw.planUnits(links);
            const largest = Math.max(...units.map((u) => u.length));
            printMsg(
                MSG.Header,
                `[i] Building ${units.length} PookieGraph(s) from ${names.length} file(s) into ${output} (largest: ${largest} file(s))`
            );
            const manifest = { format: 1, units: [] as { pg: string; files: string[] }[] };
            for (const [i, files] of units.entries()) {
                const pg = `unit-${i}.pg`;
                await writeGraph(
                    path.join(tmp, pg),
                    readFiles(directory, files),
                    limits,
                    `Unit ${i + 1}/${units.length}: `
                );
                manifest.units.push({ pg, files });
            }
            fs.writeFileSync(path.join(tmp, "manifest.json"), JSON.stringify(manifest));
            await tar.c({ file: output, cwd: tmp }, ["manifest.json", ...manifest.units.map((u) => u.pg)]);
        } catch (e) {
            fs.rmSync(output, { force: true });
            throw e;
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    }
    const mb = (fs.statSync(output).size / 1024 / 1024).toFixed(1);
    printMsg(MSG.Run, `[✓] Written to ${output} (${mb} MB, ${((Date.now() - started) / 1000).toFixed(1)}s)`);
};

/**
 * Run the .pgq rules at `queries` (default: the taintwire-queries pack, downloaded to ~/.js-recon) against `graphPath`, a PookieGraph (.pg) or a .tw of them; writes findings to
 * `output` as SARIF 2.1.0. A .tw's graphs are opened one at a time; a finding at the same place from a later graph is dropped.
 */
export const analyze = async (
    graphPath: string,
    queries: string | undefined,
    output: string,
    limits: Limits = {},
    disableQueriesVersionCheck = false
) => {
    if (!fs.existsSync(graphPath) || !fs.statSync(graphPath).isFile()) {
        printMsg(MSG.Err, `[!] PookieGraph ${graphPath} does not exist`);
        process.exit(39);
    }
    if (!queries) {
        await initTaintwireQueries(disableQueriesVersionCheck);
        queries = path.join(process.env.HOME, ".js-recon/taintwire-queries/rules");
    }
    const { tw, files, rules } = await loadQueries(queries);
    let dir: string | undefined;
    let graphs = [graphPath];
    const { toEngineOutput } = await import("../analyze/engine/taintwireEngine.js");
    const byId = new Map(rules.map((r) => [r.id, r]));
    const out: object[] = []; // SARIF results
    const seen = new Set<string>(); // findings of earlier graphs, by place
    const failed = new Set<string>();
    let cypherErrors: string[] = [];
    try {
        if (graphPath.endsWith(".tw")) {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), "jsr-tw-"));
            // Regular files only: a link entry could make a unit name a file outside the archive.
            await tar.x({ file: graphPath, cwd: dir, filter: (_p, e) => (e as { type?: string }).type === "File" });
            let pgs: unknown;
            try {
                pgs = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf-8")).units.map(
                    (u: { pg: unknown }) => u.pg
                );
            } catch {
                pgs = undefined;
            }
            // Each unit must be a file at the top of the archive, so nothing outside it is opened or deleted.
            const valid = (p: unknown) =>
                typeof p === "string" &&
                path.basename(p) === p &&
                p !== ".." &&
                fs.existsSync(path.join(dir!, p)) &&
                fs.lstatSync(path.join(dir!, p)).isFile();
            if (!Array.isArray(pgs) || !pgs.length || !pgs.every(valid)) {
                fs.rmSync(dir, { recursive: true, force: true }); // process.exit skips the finally below
                printMsg(MSG.Err, `[!] ${graphPath} is not a valid .tw file: its manifest.json must list its graphs`);
                process.exit(39);
            }
            graphs = (pgs as string[]).map((p) => path.join(dir!, p));
        }
        printMsg(MSG.Header, `[i] Running ${rules.length} rule(s) from ${files.length} .pgq file(s) on ${graphPath}`);
        for (const [i, pg] of graphs.entries()) {
            const graph = await tw.PookieGraph.open(pg, { readOnly: true, parser: "babel", ...limits });
            const here = new Set<string>();
            try {
                if (i === 0) {
                    cypherErrors = await tw.checkPgqCypher(graph, rules);
                    if (cypherErrors.length) break;
                }
                const label = graphs.length > 1 ? `Graph ${i + 1}/${graphs.length}: running rules` : "Running rules";
                const { findings, errors } = await withBar((update) => {
                    update(label, 0, rules.length);
                    return tw.runPgq(graph, rules, (done, r) => update(label, done, rules.length, r.id));
                });
                for (const e of errors) {
                    const msg = `[!] Rule ${e.ruleId} failed: ${e.message}`;
                    if (!failed.has(msg)) printMsg(MSG.Err, msg);
                    failed.add(msg);
                }
                for (const f of findings) {
                    const key = JSON.stringify([
                        f.ruleId,
                        f.file,
                        f.line,
                        f.col,
                        f.source?.file,
                        f.source?.line,
                        f.source?.col,
                    ]);
                    if (seen.has(key)) continue;
                    here.add(key);
                    const r = byId.get(f.ruleId)!;
                    // prints the finding; its findingLocation is the sink position, flow and code
                    const e = await toEngineOutput(graph, f, {
                        ruleName: r.name,
                        ruleType: "pgq",
                        ruleDescription: r.description ?? r.message,
                        ruleAuthor: r.author ?? "",
                        ruleTech: ["all"],
                    });
                    out.push(sarifResult(f, e.findingLocation.split("\n\n").slice(1).join("\n\n")));
                }
            } finally {
                await graph.close();
            }
            here.forEach((k) => seen.add(k));
            if (dir) fs.rmSync(pg, { force: true }); // free its disk as we go
        }
    } finally {
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
    for (const e of cypherErrors) printMsg(MSG.Err, `[!] ${e}`);
    if (cypherErrors.length) process.exit(40);
    printMsg(MSG.Run, `[✓] ${out.length} finding(s)`);
    const sarif = {
        $schema: "https://json.schemastore.org/sarif-2.1.0.json",
        version: "2.1.0",
        runs: [
            {
                tool: {
                    driver: {
                        name: "js-recon taintwire",
                        version: CONFIG.version,
                        informationUri: CONFIG.github,
                        rules: rules.map((r) => ({
                            id: r.id,
                            name: r.name,
                            shortDescription: { text: r.name },
                            fullDescription: { text: r.description ?? r.message },
                            defaultConfiguration: { level: SARIF_LEVEL[r.severity] ?? "warning" },
                            properties: { severity: r.severity, ...(r.author && { author: r.author }) },
                        })),
                    },
                },
                results: out,
            },
        ],
    };
    fs.writeFileSync(output, JSON.stringify(sarif, null, 2));
    printMsg(MSG.Run, `[✓] Written to ${output}`);
    // the findings of the other rules are written; 41 tells a caller they are incomplete
    if (failed.size) process.exitCode = 41;
};

const SARIF_LEVEL: Record<string, string> = {
    info: "note",
    low: "note",
    medium: "warning",
    high: "error",
    critical: "error",
};

// taintwire columns are 0-based (Babel); SARIF's are 1-based.
const sarifLocation = (l: PgqLocation, snippet?: string) => ({
    physicalLocation: {
        artifactLocation: { uri: l.file },
        region: { startLine: l.line, startColumn: l.col + 1, ...(snippet && { snippet: { text: snippet } }) },
    },
});

/** A runPgq finding as a SARIF result: the sink is the location; a source becomes a related location and a code flow. */
const sarifResult = (f: PgqFinding, code: string) => ({
    ruleId: f.ruleId,
    level: SARIF_LEVEL[f.severity] ?? "warning",
    message: { text: f.message },
    locations: [sarifLocation(f, code)],
    ...(f.source && {
        relatedLocations: [{ id: 1, message: { text: "source" }, ...sarifLocation(f.source) }],
        codeFlows: [
            {
                threadFlows: [
                    {
                        locations: [
                            { location: { message: { text: "source" }, ...sarifLocation(f.source) } },
                            { location: { message: { text: "sink" }, ...sarifLocation(f, code) } },
                        ],
                    },
                ],
            },
        ],
    }),
    properties: { severity: f.severity, ...(f.hops !== undefined && { hops: f.hops }) },
});

/** Evaluate, validate and compile the .pgq files at `queries`; exits 40 on any problem. */
export const validate = async (queries: string) => {
    const { tw, files, rules } = await loadQueries(queries);
    const graph = await tw.PookieGraph.open();
    try {
        const errors = await tw.checkPgqCypher(graph, rules);
        for (const e of errors) printMsg(MSG.Err, `[!] ${e}`);
        if (errors.length) process.exit(40);
    } finally {
        await graph.close();
    }
    printMsg(MSG.Run, `[✓] ${rules.length} rule(s) in ${files.length} .pgq file(s) are valid`);
};
