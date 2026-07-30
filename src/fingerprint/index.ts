import chalk from "chalk";
import fs from "fs";
import path from "path";
import * as cliProgress from "cli-progress";
import frameworkDetect from "../lazyLoad/techDetect/index.js";
import {
    activateBarLogger,
    computeBarSize,
    progressLog,
    watchBarResize,
    withProgressResources,
} from "../utility/progressLog.js";
import * as globalsUtil from "../utility/globals.js";

type OutputFormat = "text" | "csv" | "json" | "jsonl";

interface FingerprintResult {
    url: string;
    framework: string | null;
}

const FRAMEWORK_LABELS: Record<string, string> = {
    next: "next.js",
    vue: "vue.js",
    nuxt: "nuxt.js",
    svelte: "svelte",
    angular: "angular",
    react: "react",
};

const parseUrls = (urlArg: string): string[] => {
    if (fs.existsSync(urlArg)) {
        return fs
            .readFileSync(urlArg, "utf-8")
            .split("\n")
            .map((u) => u.trim())
            .filter((u) => u.length > 0);
    }
    return [urlArg];
};

export const deriveOutputPath = (outputFile: string, format: OutputFormat): string => {
    const ext = path.extname(outputFile);
    const base = ext ? outputFile.slice(0, -ext.length) : outputFile;
    if (format === "csv") return `${base}.csv`;
    if (format === "json") return `${base}.json`;
    if (format === "jsonl") return `${base}.jsonl`;
    return `${base}.txt`;
};

const initOutputFiles = (outputFile: string, formats: OutputFormat[]): void => {
    for (const format of formats) {
        const filePath = deriveOutputPath(outputFile, format);
        fs.writeFileSync(filePath, format === "csv" ? "framework,url\n" : "");
    }
};

const appendResult = (
    result: FingerprintResult,
    completedResults: FingerprintResult[],
    outputFile: string,
    formats: OutputFormat[]
): void => {
    for (const format of formats) {
        const filePath = deriveOutputPath(outputFile, format);
        if (format === "csv") {
            fs.appendFileSync(filePath, `${result.framework ?? "unknown"},${result.url}\n`);
        } else if (format === "json") {
            const data = completedResults.map((r) => ({ url: r.url, framework: r.framework ?? "unknown" }));
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
        } else if (format === "jsonl") {
            fs.appendFileSync(
                filePath,
                JSON.stringify({ url: result.url, framework: result.framework ?? "unknown" }) + "\n"
            );
        } else {
            fs.appendFileSync(filePath, `[${result.framework ?? "unknown"}] ${result.url}\n`);
        }
    }
};

const logOutputFiles = (outputFile: string, formats: OutputFormat[]): void => {
    for (const format of formats) {
        const filePath = deriveOutputPath(outputFile, format);
        console.log(chalk.green(`[✓] Results written to ${filePath}`));
    }
};

const fingerprint = async (
    urlArg: string,
    outputFile: string | undefined,
    formatArg: string,
    threads = 5
): Promise<void> => {
    const urls = parseUrls(urlArg);
    const concurrency = Math.max(1, threads);

    const rawFormats = formatArg
        .split(",")
        .map((f) => f.trim().toLowerCase())
        .filter((f) => f === "text" || f === "csv" || f === "json" || f === "jsonl") as OutputFormat[];
    const formats: OutputFormat[] = rawFormats.length > 0 ? rawFormats : ["text"];

    const results: FingerprintResult[] = new Array(urls.length);
    const completedResults: FingerprintResult[] = [];

    if (outputFile) {
        initOutputFiles(outputFile, formats);
    }

    const overhead = 52;
    const multiBar = new cliProgress.MultiBar(
        {
            format: chalk.cyan("[i] Fingerprinting ") + "[{bar}] {value}/{total} | {url}",
            barCompleteChar: "█",
            barIncompleteChar: "░",
            barsize: computeBarSize(overhead),
            hideCursor: true,
            clearOnComplete: false,
            stopOnComplete: false,
        },
        cliProgress.Presets.shades_classic
    );

    const bar = multiBar.create(urls.length, 0, { url: "" });
    const stopWatcher = watchBarResize(bar, overhead);
    const releaseBarLogger = activateBarLogger(multiBar, process.stdout.isTTY === true);

    let nextIdx = 0;

    const worker = async (): Promise<void> => {
        while (true) {
            const idx = nextIdx++;
            if (idx >= urls.length) return;
            const url = urls[idx];

            const displayUrl = url.length > 50 ? url.slice(0, 47) + "..." : url;
            bar.update({ url: displayUrl });

            let framework: string | null = null;
            try {
                const tech = await frameworkDetect(url);
                framework = tech ? tech.name : null;
            } catch {
                // detection failure — treat as unknown
            }

            const entry: FingerprintResult = { url, framework };
            results[idx] = entry;
            completedResults.push(entry);

            if (outputFile) {
                appendResult(entry, completedResults, outputFile, formats);
            }

            const label = framework ? (FRAMEWORK_LABELS[framework] ?? framework) : "unknown";
            const line = framework ? chalk.green(`[${label}] ${url}`) : chalk.dim(`[unknown] ${url}`);
            progressLog(line);

            bar.increment(1);
        }
    };

    await withProgressResources(
        async () => {
            globalsUtil.setQuiet(true);
            await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
        },
        () => globalsUtil.setQuiet(false),
        () => multiBar.stop(),
        stopWatcher,
        releaseBarLogger
    );

    const detected = results.filter((r) => r.framework !== null).length;
    console.log(chalk.cyan(`\n[i] ${detected}/${results.length} URLs fingerprinted`));

    if (outputFile) {
        logOutputFiles(outputFile, formats);
    }
};

export default fingerprint;
