#!/usr/bin/env node
/**
 * Benchmarks js-recon's dev-server lazyload coverage (e.g. `vue-dev`, `next-dev`) against an
 * independent ground truth crawl from katana, for one or more live dev-server targets.
 *
 * Generalizes the one-off shell-script pipeline used for the #183 Svelte benchmark
 * (js-recon-tests/run_svelte_katana_benchmark_driver.sh + set-diff-normalize.mjs) into
 * reusable tooling shipped with js-recon itself, so dev-server discovery coverage can be
 * re-checked as a regression test whenever the crawler changes (js-recon-internal-docs#190).
 *
 * Requires the `katana` binary on PATH (https://github.com/projectdiscovery/katana).
 *
 * Usage:
 *   node scripts/dev-server-benchmark.mjs <targets-file> [options]
 *   node scripts/dev-server-benchmark.mjs --url <single-target> [options]
 *
 * Options:
 *   --url <url>          Benchmark a single target instead of reading a targets file.
 *   --threads <n>         Threads passed to js-recon's lazyload (default: 2 — a higher thread
 *                          count was observed to trigger a response-cache race against Vite dev
 *                          servers under concurrent load; see the vue-dev-server-support.md doc).
 *   --output <file>       Write the full JSON report to this file (default: stdout summary only).
 *   --insecure             Pass -k (ignore TLS errors) to both katana and js-recon.
 *   --keep-output-dirs     Don't delete the per-target js-recon output directories afterward.
 *
 * Targets file format: one dev-server URL per line, blank lines and #-comments ignored.
 */

import { spawnSync } from "child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { normalize, normalizeSet } from "./dev-server-benchmark-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const jsReconEntry = join(__dirname, "..", "build", "index.js");

const JS_FILE_RE = /\.(m?js|jsx|tsx?|vue)(\?|$)/i;

const args = process.argv.slice(2);
const opts = { threads: "2", output: null, insecure: false, keepOutputDirs: false, url: null, targetsFile: null };
for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--url") opts.url = args[++i];
    else if (a === "--threads") opts.threads = args[++i];
    else if (a === "--output") opts.output = args[++i];
    else if (a === "--insecure") opts.insecure = true;
    else if (a === "--keep-output-dirs") opts.keepOutputDirs = true;
    else if (!a.startsWith("--")) opts.targetsFile = a;
}

if (!opts.url && !opts.targetsFile) {
    console.error("Usage: node scripts/dev-server-benchmark.mjs <targets-file> [options]");
    console.error("       node scripts/dev-server-benchmark.mjs --url <single-target> [options]");
    process.exit(1);
}

if (!existsSync(jsReconEntry)) {
    console.error(`[!] ${jsReconEntry} not found. Run \`npm run cleanup\` (or \`tsc\`) first.`);
    process.exit(1);
}

const katanaCheck = spawnSync("katana", ["-version"], { stdio: "ignore" });
if (katanaCheck.error) {
    console.error("[!] katana binary not found on PATH. Install it: https://github.com/projectdiscovery/katana");
    process.exit(1);
}

function readTargets() {
    if (opts.url) return [opts.url];
    return readFileSync(opts.targetsFile, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"));
}

function runKatana(target) {
    const outFile = join(tmpdir(), `jsr-katana-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    try {
        const katanaArgs = [
            "-u",
            target,
            "-hl",
            "-jsl",
            "-jc",
            "-fs",
            "fqdn",
            "-d",
            "3",
            "-mdp",
            "300",
            "-ct",
            "5m",
            "-silent",
            "-o",
            outFile,
        ];
        if (opts.insecure) katanaArgs.push("-tlsi");
        const result = spawnSync("katana", katanaArgs, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
        if (result.error) throw new Error(`katana failed to run: ${result.error.message}`);
        if (result.status !== 0) {
            throw new Error(`katana exited with status ${result.status}: ${(result.stderr || "").trim()}`);
        }
        if (!existsSync(outFile)) return [];
        const lines = readFileSync(outFile, "utf8")
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
        return lines.filter((l) => JS_FILE_RE.test(l));
    } finally {
        rmSync(outFile, { force: true });
    }
}

function runJsRecon(target) {
    const outputDir = mkdtempSync(join(tmpdir(), "jsr-devbench-"));
    try {
        const researchOutput = join(outputDir, "research.json");
        const jsReconArgs = [
            jsReconEntry,
            "lazyload",
            "-u",
            target,
            "-y",
            "--no-sandbox",
            "-t",
            opts.threads,
            "--research",
            "--research-output",
            researchOutput,
            "-o",
            outputDir,
            // Isolate the response cache per run — without this, successive benchmark runs
            // against the same host:port (e.g. piloting Vite then webpack, both on
            // localhost:3000) share the CWD-default .resp_cache.db and the second run silently
            // serves the first run's cached HTML/responses instead of the new server's.
            "--cache-file",
            join(outputDir, ".resp_cache.db"),
        ];
        if (opts.insecure) jsReconArgs.push("-k");
        const result = spawnSync("node", jsReconArgs, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
        if (result.error) throw new Error(`js-recon lazyload failed to run: ${result.error.message}`);
        if (result.status !== 0) {
            throw new Error(`js-recon lazyload exited with status ${result.status}: ${(result.stderr || "").trim()}`);
        }

        let urls = [];
        if (existsSync(researchOutput)) {
            const research = JSON.parse(readFileSync(researchOutput, "utf8"));
            urls = Object.values(research).flat();
        }
        return { urls, outputDir: opts.keepOutputDirs ? outputDir : null };
    } finally {
        if (!opts.keepOutputDirs) rmSync(outputDir, { recursive: true, force: true });
    }
}

const report = { generatedAt: null, targets: [] };
const failedTargets = [];

for (const target of readTargets()) {
    console.log(`\n[i] Benchmarking ${target}`);
    let katanaUrls, jsReconResult;
    try {
        katanaUrls = runKatana(target);
    } catch (err) {
        console.error(`[!] katana failed for ${target}: ${err.message}`);
        failedTargets.push(target);
        continue;
    }
    try {
        jsReconResult = runJsRecon(target);
    } catch (err) {
        console.error(`[!] js-recon lazyload failed for ${target}: ${err.message}`);
        failedTargets.push(target);
        continue;
    }

    const katanaSet = normalizeSet(katanaUrls);
    const jsReconSet = normalizeSet(jsReconResult.urls);

    const missedByJsRecon = [...katanaSet].filter((u) => !jsReconSet.has(u));
    const foundOnlyByJsRecon = [...jsReconSet].filter((u) => !katanaSet.has(u));
    const intersection = [...katanaSet].filter((u) => jsReconSet.has(u));

    console.log(
        `    katana: ${katanaSet.size} JS URL(s) | js-recon: ${jsReconSet.size} URL(s) | overlap: ${intersection.length} | js-recon missed: ${missedByJsRecon.length} | js-recon only: ${foundOnlyByJsRecon.length}`
    );
    if (missedByJsRecon.length > 0) {
        console.log("    Missed by js-recon:");
        for (const u of missedByJsRecon) console.log(`      - ${u}`);
    }
    if (opts.keepOutputDirs && jsReconResult.outputDir) {
        console.log(`    js-recon output kept at: ${jsReconResult.outputDir}`);
    }

    report.targets.push({
        target,
        katanaCount: katanaSet.size,
        jsReconCount: jsReconSet.size,
        overlapCount: intersection.length,
        missedByJsRecon,
        foundOnlyByJsRecon,
    });
}

if (opts.output) {
    report.generatedAt = new Date().toISOString();
    writeFileSync(opts.output, JSON.stringify(report, null, 4));
    console.log(`\n[✓] Full report written to ${opts.output}`);
}

if (failedTargets.length > 0) {
    console.error(`\n[!] ${failedTargets.length} target(s) failed to run: ${failedTargets.join(", ")}`);
}

const totalMissed = report.targets.reduce((sum, t) => sum + t.missedByJsRecon.length, 0);
if (totalMissed > 0) {
    console.error(`\n[!] ${totalMissed} URL(s) missed by js-recon across ${report.targets.length} target(s).`);
}
if (totalMissed > 0 || failedTargets.length > 0) {
    process.exit(1);
}
console.log(`\n[✓] No discovery gaps found across ${report.targets.length} target(s).`);
