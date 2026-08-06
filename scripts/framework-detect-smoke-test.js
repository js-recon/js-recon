#!/usr/bin/env node
/**
 * Smoke test: verifies that js-recon's `fingerprint` command detects the
 * correct front-end framework for every lab app in the framework-detection
 * matrix (js-recon-labs/detection/*).
 *
 * Usage:
 *   node scripts/framework-detect-smoke-test.js [path-to-fingerprint-result.json]
 *
 * Default path: /tmp/fingerprint-result.json
 */

import { readFileSync } from "fs";
import { resolve } from "path";

const resultPath = process.argv[2] || "/tmp/fingerprint-result.json";
const absolutePath = resolve(resultPath);

let results;
try {
    results = JSON.parse(readFileSync(absolutePath, "utf-8"));
} catch (err) {
    console.error(`[!] Could not read ${absolutePath}: ${err.message}`);
    console.error("    Make sure `js-recon fingerprint -f json` completed successfully before running this script.");
    process.exit(1);
}

// URL -> expected framework name, matching js-recon-labs/detection/* app ports.
const EXPECTED = {
    "http://localhost:3010": "next",
    "http://localhost:3011": "vue",
    "http://localhost:3012": "nuxt",
    "http://localhost:3013": "svelte",
    "http://localhost:3014": "angular",
    "http://localhost:3015": "react",
    "http://localhost:3016": "react",
};

const detected = new Map(results.map((r) => [r.url, r.framework]));
const rows = [];
let failed = false;

for (const [url, expected] of Object.entries(EXPECTED)) {
    const actual = detected.get(url) ?? "unknown";
    const ok = actual === expected;
    if (!ok) failed = true;
    rows.push({ url, expected, actual, ok });
}

console.log(`[i] Checked ${rows.length} lab apps.`);
console.log();
console.log("URL".padEnd(28), "Expected".padEnd(10), "Detected".padEnd(10), "Result");
for (const { url, expected, actual, ok } of rows) {
    console.log(url.padEnd(28), expected.padEnd(10), actual.padEnd(10), ok ? "OK" : "MISMATCH");
}
console.log();

if (failed) {
    const mismatches = rows.filter((r) => !r.ok).length;
    console.error(`[!] ${mismatches} / ${rows.length} apps failed framework detection. Smoke test FAILED.`);
    process.exit(1);
}

console.log(`[✓] All ${rows.length} apps detected correctly. Smoke test PASSED.`);
