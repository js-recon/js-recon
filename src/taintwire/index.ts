import fs from "fs";
import path from "path";
import { printMsg, MSG } from "../utility/printMsg.js";
import { listFilesRecursive, listJsFiles } from "../utility/listFiles.js";
import { generateEngineOutput, EngineOutput } from "../analyze/helpers/outputHelper.js";

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

/** Load every JS file under `directory` into one linked PookieGraph written to `output` (.pg). */
export const build = async (directory: string, output: string) => {
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
        printMsg(MSG.Err, `[!] Directory ${directory} does not exist`);
        process.exit(37);
    }
    if (fs.existsSync(output)) {
        printMsg(MSG.Err, `[!] Output ${output} already exists`);
        process.exit(38);
    }

    const files: { filename: string; code: string }[] = [];
    for (const file of listJsFiles(directory)) {
        const filePath = path.join(directory, file);
        const size = fs.statSync(filePath).size;
        if (size > MAX_FILE_SIZE_BYTES) {
            printMsg(MSG.Warn, `[!] Skipping ${file} (${(size / 1024 / 1024).toFixed(1)} MB > 8 MB limit)`);
            continue;
        }
        files.push({ filename: file, code: fs.readFileSync(filePath, "utf-8") });
    }
    if (!files.length) {
        printMsg(MSG.Err, `[!] No .js/.mjs files found in ${directory}`);
        process.exit(37);
    }

    printMsg(MSG.Header, `[i] Building a PookieGraph from ${files.length} file(s) into ${output}`);
    const started = Date.now();
    const { PookieGraph } = await import("@js-recon/taintwire");
    // Built on disk, not in memory: a whole app in memory takes about 10 KB of RAM per byte of minified source.
    const graph = await PookieGraph.open(output, { parser: "babel" });
    try {
        await graph.query("CALL auto_checkpoint=false");
        await graph.addFiles(files); // one call, so chunks are linked through the bundler's module registry
        await graph.query("CHECKPOINT");
        await graph.close();
    } catch (e) {
        await graph.close().catch(() => {});
        for (const f of [output, `${output}.wal`, `${output}.shadow`]) fs.rmSync(f, { force: true });
        throw e;
    }
    const mb = (fs.statSync(output).size / 1024 / 1024).toFixed(1);
    printMsg(
        MSG.Run,
        `[✓] PookieGraph written to ${output} (${mb} MB, ${((Date.now() - started) / 1000).toFixed(1)}s)`
    );
};

/** Run the .pgq rules at `queries` against the PookieGraph at `graphPath`; writes findings to `output` as JSON. */
export const analyze = async (graphPath: string, queries: string, output: string) => {
    if (!fs.existsSync(graphPath) || !fs.statSync(graphPath).isFile()) {
        printMsg(MSG.Err, `[!] PookieGraph ${graphPath} does not exist`);
        process.exit(39);
    }
    const { tw, files, rules } = await loadQueries(queries);
    const graph = await tw.PookieGraph.open(graphPath, { readOnly: true, parser: "babel" });
    try {
        const cypherErrors = await tw.checkPgqCypher(graph, rules);
        for (const e of cypherErrors) printMsg(MSG.Err, `[!] ${e}`);
        if (cypherErrors.length) process.exit(40);

        printMsg(MSG.Header, `[i] Running ${rules.length} rule(s) from ${files.length} .pgq file(s) on ${graphPath}`);
        const { toEngineOutput } = await import("../analyze/engine/taintwireEngine.js");
        const { findings, errors } = await tw.runPgq(graph, rules);
        for (const e of errors) printMsg(MSG.Err, `[!] Rule ${e.ruleId} failed: ${e.message}`);
        const byId = new Map(rules.map((r) => [r.id, r]));
        const out: EngineOutput[] = [];
        for (const f of findings) {
            const r = byId.get(f.ruleId)!;
            out.push(
                await toEngineOutput(graph, f, {
                    ruleName: r.name,
                    ruleType: "pgq",
                    ruleDescription: r.description ?? r.message,
                    ruleAuthor: r.author ?? "",
                    ruleTech: ["all"],
                })
            );
        }
        printMsg(MSG.Run, `[✓] ${out.length} finding(s)`);
        generateEngineOutput(output, out);
    } finally {
        await graph.close();
    }
};

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
