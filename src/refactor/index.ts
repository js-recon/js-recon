import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { Chunks } from "../utility/interfaces.js";
import prettier from "prettier";
import { printMsg, MSG } from "../utility/printMsg.js";

// Next.js
import refactorNext, { refactorNextWebpack } from "./next/index.js";
// React
import refactorReact, { RefactorReactResult } from "./react/index.js";
import type { LibraryModuleInfo } from "./react/library-classify.js";
// React (Vite)
import refactorVite from "./react-vite/index.js";
// Vue
import refactorVueWebpack from "./vue/index.js";
import { refactorVueVite } from "./vue/vite.js";

// Remote HuggingFace client + cache
import {
    TECH_TO_BRANCH,
    getHfRawUrl,
    fetchCollisionsJson,
    listCollisionsFiles,
    listCollisionsFileHashes,
    validateRemoteBranch,
    validateRemotePath,
    getSampleSize,
    getTechnology,
    CollisionRecord,
} from "./remote/hf-client.js";
import {
    loadRefactorConfig,
    validateRefactorConfig,
    purgeDynamicVersionDetectionScatConfig,
    saveDynamicVersionDetectionScatConfig,
} from "./remote/config.js";
import {
    loadListCache,
    saveListCache,
    shouldRefreshListCache,
    loadCachedSignature,
    saveSignatureToCache,
    isSignatureCacheFresh,
    validateCaches,
} from "./remote/cache.js";
import {
    detectReactVersion,
    VersionDetectionResult,
    VERSION_TECH_TO_BUNDLER,
    listAvailableVersions,
    selectDynamicScatConfigs,
    validateStaticScatConfig,
} from "./remote/version-detect.js";

/**
 * Locates the assets directory holding vendor chunk files not present in `mapped.json`.
 * `explicitAssetsDir` (the actual download dir + host, known by the `run` orchestrator)
 * is used when given — `mapped.json` isn't always co-located with the downloaded assets
 * (e.g. single-target `run` writes `mapped.json` to cwd but assets to `<-o>/<host>/assets`).
 * Falls back to `<mapped.json's dir>/assets`, which holds for manual/CLI refactor
 * invocations where `-m` points at a `mapped.json` living inside the host output dir.
 * Returns null if the resolved directory does not exist.
 */
export function findAssetsDir(mappedJsonPath: string, explicitAssetsDir?: string): string | null {
    const assetsDir = explicitAssetsDir ?? path.join(path.dirname(path.resolve(mappedJsonPath)), "assets");
    try {
        return fs.statSync(assetsDir).isDirectory() ? assetsDir : null;
    } catch {
        return null;
    }
}

/**
 * Returns paths to .js files in `assetsDir` that are NOT covered by any chunk in `chunks`.
 * Chunks cover a file when `path.basename(chunk.file)` matches the assets filename.
 */
function findVendorChunkFiles(chunks: Chunks, assetsDir: string): string[] {
    const coveredFiles = new Set<string>();
    for (const chunk of Object.values(chunks)) {
        if (chunk.file) coveredFiles.add(path.basename(chunk.file));
    }
    return fs
        .readdirSync(assetsDir)
        .filter((f) => f.endsWith(".js") && !coveredFiles.has(f))
        .map((f) => path.join(assetsDir, f));
}

// Maps a refactor tech to the scat-combo directory name in a baseline tree.
// The directory name is the scat categories joined by "-" in the order they appear in
// ALL_SCAT_CATEGORIES (matching the naming convention used by jsr-cs-mast-s-gen/experiment/csmast.mjs).
const BASELINE_SCAT_DIR: Record<string, string> = {
    "react-webpack": "lit-decl-loop-cond",
    "react-vite": "lit-decl-loop-cond",
    "next-webpack": "lit-decl-loop-cond",
};

// Canonical ordering of scat categories (matches ALL_SCAT_CATEGORIES in csmast.mjs).
// Used when converting a user-supplied --scat list to a bucket directory name.
const ALL_SCAT_CATEGORIES = ["lit", "id", "op", "decl", "loop", "cond", "name", "val", "op_name"] as const;

// Converts a scat list to the bucket directory name, preserving canonical category order.
export const scatToDir = (scat: string[]): string => {
    const scatSet = new Set(scat);
    return ALL_SCAT_CATEGORIES.filter((c) => scatSet.has(c)).join("-") || scat.join("-");
};

type LibSigsResult = { sigs: Set<string>; desc: string };

export type RemoteLibSigsOptions = {
    signatureQuality: number; // 0-100; default 100
    refreshCache: boolean;
    skipCacheChecks: boolean;
    scat?: string[]; // override CS-MAST scat categories; if omitted, uses BASELINE_SCAT_DIR[tech]
    remoteCollisions?: string; // explicit HF bucket path; overrides TECH_TO_BRANCH lookup
    detectVersion?: boolean; // detect the React version used in the bundle
    // "dynamic" (default) = auto-select reliable scat configs; otherwise comma-separated scat categories.
    detectVersionConfig?: string;
    // Number of scat configs to use in dynamic mode (default: 3).
    detectVersionDynamicThreshold?: number;
    // When true, clear the cached dynamic scat config and recompute.
    detectVersionDynamicConfPurge?: boolean;
};

// Parses a collisions.json file and returns signatures whose count equals the maximum.
export const loadCollisionsFile = (filePath: string): Set<string> => {
    const records = JSON.parse(fs.readFileSync(filePath, "utf8")) as Array<{
        signature: string;
        count: number;
    }>;
    const maxCount = records.reduce((m, r) => (r.count > m ? r.count : m), 0);
    return new Set(records.filter((r) => r.count >= maxCount).map((r) => r.signature));
};

// Resolves `--collisions <path>` to a library signature set. Accepts:
//   - a file path → reads directly (max-count signatures)
//   - a standard directory → tries known candidate paths in order:
//       <dir>/baselines/<tech>/<scat>/collisions.json
//       <dir>/<tech>/<scat>/collisions.json
//       <dir>/<scat>/collisions.json
//       <dir>/collisions.json
//   - a per-feature results directory → detects <dir>/<feature>/<scat>/collisions.json
//       and intersects max-count signatures across all feature subdirs (reads only
//       the relevant scat files, not the full dataset tree)
const buildLibSigs = (input: string, tech: string, scatOverride?: string[]): LibSigsResult | null => {
    if (!fs.existsSync(input)) return null;
    const stat = fs.statSync(input);
    const scat = scatOverride ? scatToDir(scatOverride) : BASELINE_SCAT_DIR[tech];

    // Case 1: direct file path
    if (stat.isFile()) {
        return { sigs: loadCollisionsFile(input), desc: input };
    }

    // Case 2: standard directory candidates (existing layout)
    const candidates = [
        scat ? path.join(input, "baselines", tech, scat, "collisions.json") : null,
        scat ? path.join(input, tech, scat, "collisions.json") : null,
        scat ? path.join(input, scat, "collisions.json") : null,
        path.join(input, "collisions.json"),
    ].filter(Boolean) as string[];
    for (const c of candidates) {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) {
            return { sigs: loadCollisionsFile(c), desc: c };
        }
    }

    // Case 3: per-feature results directory — <dir>/<feature>/<scat>/collisions.json
    // Only the scat-relevant files are read (one per feature subdir), so memory usage
    // stays low even when the full dataset tree is hundreds of gigabytes.
    if (scat) {
        const featureFiles: string[] = [];
        for (const entry of fs.readdirSync(input, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const p = path.join(input, entry.name, scat, "collisions.json");
            if (fs.existsSync(p)) featureFiles.push(p);
        }
        if (featureFiles.length > 0) {
            // Intersect max-count signatures across all feature subdirs.
            // A signature present in every feature's max-count set must come from
            // code shared by all apps — i.e. library code.
            let intersection: Set<string> | null = null;
            for (const p of featureFiles) {
                const sigs = loadCollisionsFile(p);
                if (intersection === null) {
                    intersection = sigs;
                } else {
                    for (const sig of intersection) {
                        if (!sigs.has(sig)) intersection.delete(sig);
                    }
                }
            }
            if (intersection && intersection.size > 0) {
                return {
                    sigs: intersection,
                    desc: `${input} (intersection of ${featureFiles.length} feature dirs)`,
                };
            }
        }
    }

    return null;
};

// Loads library signatures from the remote HuggingFace dataset.
// Returns null if the branch is not configured for `tech` or if validation fails.
// When opts.remoteCollisions is provided it is used directly as the bucket path,
// bypassing the TECH_TO_BRANCH lookup and metadata-file validation.
// Exits with code 25 if opts.remoteCollisions is set but the path does not exist.
const loadRemoteLibSigs = async (tech: string, opts: RemoteLibSigsOptions): Promise<LibSigsResult | null> => {
    const branch = opts.remoteCollisions ?? TECH_TO_BRANCH[tech];
    if (!branch) return null;

    const scatDir = opts.scat ? scatToDir(opts.scat) : BASELINE_SCAT_DIR[tech];
    if (!scatDir) return null;

    // Load and validate config.
    const config = loadRefactorConfig();
    const configWarnings = validateRefactorConfig(config);
    for (const w of configWarnings) {
        printMsg(MSG.Warn, `[!] Refactor config warning: ${w}`);
    }

    // Validate cache files.
    const cacheWarnings = validateCaches();
    for (const w of cacheWarnings) {
        printMsg(MSG.Warn, `[!] Cache validation warning: ${w} (will refresh)`);
    }

    if (opts.remoteCollisions) {
        // User-supplied path: validate it exists in the HF bucket.
        printMsg(MSG.Header, `[i] Validating remote dataset path "${branch}"...`);
        const pathExists = await validateRemotePath(branch);
        if (!pathExists) {
            printMsg(
                MSG.Err,
                `[!] Remote dataset path "${branch}" not found in the shriyanss/cs-mast-s-dataset bucket.`
            );
            process.exit(25);
        }
    } else {
        // Auto-detected branch: validate metadata files exist.
        printMsg(MSG.Header, `[i] Validating remote bucket prefix "${branch}"...`);
        const branchOk = await validateRemoteBranch(branch);
        if (!branchOk) {
            printMsg(
                MSG.Err,
                `[!] Remote bucket prefix "${branch}" is missing required metadata (sample_size / technology). Skipping remote signatures.`
            );
            return null;
        }

        // Verify the bucket prefix technology matches.
        const remoteTech = await getTechnology(branch);
        if (remoteTech !== tech) {
            printMsg(
                MSG.Err,
                `[!] Remote bucket prefix "${branch}" is for technology "${remoteTech}", not "${tech}". Skipping remote signatures.`
            );
            return null;
        }
    }

    // Try to load the sample size for quality filtering.
    // Custom paths may not have a sample_size file; fall back to 0 (skip quality filter).
    let sampleSize = 0;
    if (opts.remoteCollisions) {
        try {
            sampleSize = await getSampleSize(branch);
        } catch {
            // Custom path may not have sample_size; quality filter will be skipped (sampleSize=0)
        }
    } else {
        sampleSize = await getSampleSize(branch);
    }

    // Build / refresh file list cache.
    // Also refresh if the specific branch is not yet in the cache (e.g. first run
    // with a new --remote-collisions path, or a new tech added after initial cache).
    let listCache = cacheWarnings.length > 0 ? null : loadListCache();
    const branchMissingFromCache = !listCache?.branches[branch];
    if (shouldRefreshListCache(listCache, opts) || branchMissingFromCache) {
        printMsg(MSG.Header, `[i] Refreshing remote file list cache for bucket prefix "${branch}"...`);
        const paths = await listCollisionsFiles(branch, scatDir);
        const now = Date.now();
        const branches: Record<string, string[]> = listCache?.branches ?? {};
        branches[branch] = paths;
        listCache = { generatedAt: now, branches };
        saveListCache(listCache);
        printMsg(MSG.Header, `[i] File list cache updated: ${paths.length} files found`);
    }

    const filePaths: string[] = listCache?.branches[branch] ?? [];
    // Filter to only paths that match <something>/<scatDir>/collisions.json
    const matchingPaths = filePaths.filter((p) => p.endsWith(`/${scatDir}/collisions.json`));

    if (matchingPaths.length === 0) {
        printMsg(MSG.Warn, `[!] No remote collisions files found for scat "${scatDir}" in branch "${branch}"`);
        return null;
    }

    printMsg(
        MSG.Header,
        `[i] Loading ${matchingPaths.length} remote signature files (quality threshold: ${opts.signatureQuality}%)...`
    );

    // Content-based cache validation: fetch the upstream tree's per-file hashes once per
    // branch so each cache entry below can be checked against current dataset content
    // instead of trusting its local age alone. Skipped entirely under --skip-cache-checks.
    // A failure here (e.g. HF rate-limiting under concurrent load) must never abort the
    // whole refactor run — fall back to an empty map, which degrades each cache-freshness
    // check below to the pre-existing age-based TTL.
    let remoteHashes = new Map<string, string>();
    if (!opts.skipCacheChecks) {
        try {
            remoteHashes = await listCollisionsFileHashes(branch, scatDir);
        } catch (e) {
            printMsg(
                MSG.Warn,
                `[!] Could not fetch upstream content hashes for cache validation (${(e as Error).message}) — falling back to age-based cache checks.`
            );
        }
    }

    let intersection: Set<string> | null = null;
    let loadedCount = 0;

    for (const relPath of matchingPaths) {
        let records: CollisionRecord[] | null = null;
        const remoteHash = remoteHashes.get(relPath) ?? null;

        // Check local signature cache first.
        if (isSignatureCacheFresh(branch, relPath, opts.skipCacheChecks, remoteHash)) {
            records = loadCachedSignature(branch, relPath);
        }

        if (records === null) {
            // Fetch from remote.
            const url = getHfRawUrl(branch, relPath);
            records = await fetchCollisionsJson(url);

            if (records === null) {
                // 404 or network error.
                // For user-specified --remote-collisions paths the list is stable;
                // just skip this file and continue without poisoning the list cache.
                // For auto-detected branches, invalidate the list cache so a stale
                // entry (e.g. a deleted file) is not tried again on the next run.
                if (!opts.remoteCollisions && !opts.skipCacheChecks) {
                    printMsg(MSG.Warn, `[!] Could not fetch ${relPath} (404 or error) — refreshing list cache`);
                    const freshPaths = await listCollisionsFiles(branch, scatDir);
                    const updatedBranches = listCache?.branches ?? {};
                    updatedBranches[branch] = freshPaths;
                    saveListCache({ generatedAt: Date.now(), branches: updatedBranches });
                    listCache = { generatedAt: Date.now(), branches: updatedBranches };
                } else {
                    printMsg(MSG.Warn, `[!] Could not fetch ${relPath} — skipping`);
                }
                continue;
            }

            saveSignatureToCache(branch, relPath, records, config.maxCacheSizeMb, remoteHash);
        }

        // Apply signature quality filter: (count / sampleSize) * 100 >= threshold.
        // When sampleSize is 0 (no sample_size file on the remote path), skip quality
        // filtering and include all records.
        const filtered =
            sampleSize === 0 ? records : records.filter((r) => (r.count / sampleSize) * 100 >= opts.signatureQuality);

        // Skip feature dirs with no records — they indicate missing/empty dataset
        // entries and would collapse the intersection to zero if included.
        if (filtered.length === 0) continue;

        // Intersect with previous sets.
        const sigSet = new Set(filtered.map((r) => r.signature));
        if (intersection === null) {
            intersection = sigSet;
        } else {
            for (const sig of intersection) {
                if (!sigSet.has(sig)) intersection.delete(sig);
            }
        }
        loadedCount++;
    }

    if (!intersection || intersection.size === 0) {
        printMsg(
            MSG.Err,
            `[!] Remote signatures loaded but intersection is empty — library stripping will find nothing to skip ` +
                `(quality threshold may be too high, or every dataset entry fetched 0 records). ` +
                `If this is unexpected, purge ~/.js-recon/refactor/{signature_cache,cs-mast-s-list-cache.json} and retry.`
        );
        return null;
    }

    printMsg(
        MSG.Header,
        `[i] Loaded ${intersection.size} library signatures from remote (${loadedCount} files, bucket prefix: ${branch})`
    );
    return { sigs: intersection, desc: `remote:${branch} (${loadedCount} files, quality>=${opts.signatureQuality}%)` };
};

const availableTechs = {
    "next-turbopack": "Next.js (Turbopack)",
    "next-webpack": "Next.js (webpack)",
    "react-webpack": "React (webpack)",
    "react-vite": "React (Vite)",
    "vue-webpack": "Vue.js (webpack)",
    "vue-vite": "Vue.js (Vite)",
};

/**
 * Scaffolds a minimal webpack project in `outputDir` (package.json,
 * webpack.config.js, index.html), then runs `npm install` + `npm run build`
 * as a build check.  Uses babel-loader so JSX in .js files is handled without
 * renaming.
 *
 * The entry file is the first written file that contains `createRoot(` — i.e.
 * the app entry point.  If no such file is found, the first written file is used.
 */
function runBuildCheck(outputDir: string, writtenFiles: string[], detectedVersion?: VersionDetectionResult): void {
    if (writtenFiles.length === 0) return;

    // Find the entry file: the module that calls createRoot().
    const entryFile =
        writtenFiles.find((f) => {
            try {
                return fs.readFileSync(f, "utf8").includes("createRoot(");
            } catch {
                return false;
            }
        }) ?? writtenFiles[0];
    const entryRelative = `./${path.basename(entryFile)}`;

    printMsg(MSG.Header, `[i] Setting up webpack build check in ${outputDir}/ (entry: ${entryRelative})`);

    // Use detected React version when available, fall back to React 18.
    const reactVersion = detectedVersion ? `^${detectedVersion.reactNpm}` : "^18.3.1";
    const reactDomVersion = detectedVersion?.reactDomNpm
        ? `^${detectedVersion.reactDomNpm}`
        : detectedVersion
          ? undefined // pre-0.14: no react-dom
          : "^18.3.1";

    if (detectedVersion) {
        printMsg(
            MSG.Header,
            `[i] Using detected React version ${detectedVersion.versionKey} in package.json (react@${reactVersion})`
        );
    }

    const dependencies: Record<string, string> = {
        react: reactVersion,
        ...(reactDomVersion ? { "react-dom": reactDomVersion } : {}),
        "react-router-dom": "^6.27.0",
    };

    // package.json — no "type": "module" so webpack.config.js can use CommonJS require
    const pkg = {
        name: "refactored-app",
        version: "1.0.0",
        scripts: { build: "webpack" },
        dependencies,
        devDependencies: {
            "@babel/core": "^7.25.0",
            "@babel/preset-env": "^7.25.0",
            "@babel/preset-react": "^7.25.0",
            "babel-loader": "^9.2.1",
            "html-webpack-plugin": "^5.6.0",
            webpack: "^5.95.0",
            "webpack-cli": "^5.1.4",
        },
    };
    fs.writeFileSync(path.join(outputDir, "package.json"), JSON.stringify(pkg, null, 2));

    // webpack.config.js — babel-loader with preset-react handles JSX in .js files
    const webpackConfig = `const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
module.exports = {
  mode: 'production',
  entry: '${entryRelative}',
  output: { path: path.resolve(__dirname, 'dist'), filename: 'bundle.js', clean: true },
  module: {
    rules: [{
      test: /\\.jsx?$/,
      exclude: /node_modules/,
      use: {
        loader: 'babel-loader',
        options: {
          presets: [
            ['@babel/preset-env', { targets: 'defaults' }],
            ['@babel/preset-react', { runtime: 'automatic' }],
          ],
        },
      },
    }],
  },
  resolve: { extensions: ['.js', '.jsx'] },
  plugins: [new HtmlWebpackPlugin({ template: './index.html' })],
};
`;
    fs.writeFileSync(path.join(outputDir, "webpack.config.js"), webpackConfig);

    // index.html — HtmlWebpackPlugin injects the bundle script automatically
    const indexHtml = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Refactored App</title></head>
  <body><div id="root"></div></body>
</html>
`;
    fs.writeFileSync(path.join(outputDir, "index.html"), indexHtml);

    printMsg(MSG.Header, "[i] Installing dependencies...");
    try {
        execSync("npm install", { cwd: outputDir, stdio: "inherit" });
    } catch {
        printMsg(MSG.Err, "[!] npm install failed — skipping build check");
        return;
    }

    printMsg(MSG.Header, "[i] Running build check...");
    try {
        execSync("npm run build", { cwd: outputDir, stdio: "inherit" });
        printMsg(MSG.Run, "[✓] Build check passed");
    } catch {
        printMsg(MSG.Err, "[!] Build check failed — review output above");
    }
}

/**
 * Scaffolds a minimal Vite project in `outputDir` and runs `npm install` + `npm run build`
 * as a build check. Uses @vitejs/plugin-react so JSX in .js files is handled.
 *
 * The entry file is the first written file that contains `createRoot(`.
 */
function runViteBuildCheck(outputDir: string, writtenFiles: string[], detectedVersion?: VersionDetectionResult): void {
    if (writtenFiles.length === 0) return;

    // Deduplicate — callers should not pass duplicates, but guard here too so a
    // duplicate does not cause the renameSync below to throw ENOENT on the
    // second occurrence of the same path.
    const uniqueFiles = [...new Set(writtenFiles)];

    // Rename .js files to .jsx — Vite's import analysis can't parse JSX in .js files,
    // and refactored Vite chunks always contain JSX. The original source files were .jsx.
    const jsxFiles = uniqueFiles.map((f) => {
        if (!f.endsWith(".js")) return f;
        const jsxPath = f.replace(/\.js$/, ".jsx");
        fs.renameSync(f, jsxPath);
        return jsxPath;
    });

    // After renaming to .jsx, update relative dynamic imports inside each file:
    // import('./Foo.js') → import('./Foo.jsx') — only for same-dir relative imports.
    const outputFileBasenames = new Set(jsxFiles.map((f) => path.basename(f)));
    for (const f of jsxFiles) {
        let content = fs.readFileSync(f, "utf8");
        // Replace ./Foo.js with ./Foo.jsx only when Foo.jsx exists as an output file.
        content = content.replace(/(import\([`'"])(\.\/[^`'"]+?)\.js([`'"]\))/g, (_match, open, stem, close) => {
            const candidate = path.basename(stem) + ".jsx";
            return outputFileBasenames.has(candidate) ? `${open}${stem}.jsx${close}` : _match;
        });
        fs.writeFileSync(f, content);
    }

    const entryFile =
        jsxFiles.find((f) => {
            try {
                return fs.readFileSync(f, "utf8").includes("createRoot(");
            } catch {
                return false;
            }
        }) ?? jsxFiles[0];
    const entryRelative = `./${path.basename(entryFile)}`;

    printMsg(MSG.Header, `[i] Setting up Vite build check in ${outputDir}/ (entry: ${entryRelative})`);

    // Use detected React version when available, fall back to React 18.
    const reactVersion = detectedVersion ? `^${detectedVersion.reactNpm}` : "^18.3.1";
    const reactDomVersion = detectedVersion?.reactDomNpm
        ? `^${detectedVersion.reactDomNpm}`
        : detectedVersion
          ? undefined
          : "^18.3.1";

    if (detectedVersion) {
        printMsg(
            MSG.Header,
            `[i] Using detected React version ${detectedVersion.versionKey} in package.json (react@${reactVersion})`
        );
    }

    const dependencies: Record<string, string> = {
        react: reactVersion,
        ...(reactDomVersion ? { "react-dom": reactDomVersion } : {}),
        "react-router-dom": "^6.27.0",
    };

    const pkg = {
        name: "refactored-app",
        version: "1.0.0",
        type: "module",
        scripts: { build: "vite build" },
        dependencies,
        devDependencies: {
            "@vitejs/plugin-react": "^4.3.1",
            vite: "^5.4.0",
        },
    };
    fs.writeFileSync(path.join(outputDir, "package.json"), JSON.stringify(pkg, null, 2));

    const viteConfig = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  build: { rollupOptions: { input: '${entryRelative}' } },
});
`;
    fs.writeFileSync(path.join(outputDir, "vite.config.js"), viteConfig);

    const indexHtml = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Refactored App</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="${entryRelative}"></script>
  </body>
</html>
`;
    fs.writeFileSync(path.join(outputDir, "index.html"), indexHtml);

    printMsg(MSG.Header, "[i] Installing dependencies...");
    try {
        execSync("npm install", { cwd: outputDir, stdio: "inherit" });
    } catch {
        printMsg(MSG.Err, "[!] npm install failed — skipping build check");
        return;
    }

    printMsg(MSG.Header, "[i] Running Vite build check...");
    try {
        execSync("npm run build", { cwd: outputDir, stdio: "inherit" });
        printMsg(MSG.Run, "[✓] Vite build check passed");
    } catch {
        printMsg(MSG.Err, "[!] Vite build check failed — review output above");
    }
}

/**
 * Resolves the scat dir list to use for version detection based on the user's options.
 * Returns an empty array when version detection should be skipped (e.g., invalid static config).
 *
 * Dynamic mode (default):
 *   - Reads cached dynamic scat configs from ~/.js-recon/refactor/config.json.
 *   - If --detect-version-dynamic-conf-purge is set, clears the cache first.
 *   - If no cached configs exist, runs selectDynamicScatConfigs() and saves the result.
 *
 * Static mode (user passes comma-separated categories):
 *   - Validates that reliable_signatures.json is non-empty for all known versions.
 *   - Exits with code 26 if the config is invalid or empty for any version.
 */
async function resolveVersionDetectionScatDirs(bundler: string, opts: RemoteLibSigsOptions): Promise<string[]> {
    const detectConfig = opts.detectVersionConfig ?? "dynamic";

    if (detectConfig === "dynamic") {
        if (opts.detectVersionDynamicConfPurge) {
            printMsg(MSG.Header, "[i] Version detection: purging cached dynamic scat config...");
            purgeDynamicVersionDetectionScatConfig();
        }

        const cfg = loadRefactorConfig();
        if (cfg.dynamicVersionDetectionScatConfig && cfg.dynamicVersionDetectionScatConfig.length > 0) {
            printMsg(
                MSG.Header,
                `[i] Version detection: using cached dynamic scat config (${cfg.dynamicVersionDetectionScatConfig.join(", ")})`
            );
            return cfg.dynamicVersionDetectionScatConfig;
        }

        // No cached config — discover versions and run dynamic selection.
        let versions: string[];
        try {
            versions = await listAvailableVersions(bundler);
        } catch (e) {
            printMsg(MSG.Warn, `[!] Version detection: could not list versions (${String(e)})`);
            return [];
        }
        if (versions.length === 0) {
            printMsg(MSG.Warn, `[!] Version detection: no version data found for ${bundler}`);
            return [];
        }

        const threshold = Math.max(1, opts.detectVersionDynamicThreshold ?? 3);
        const selected = await selectDynamicScatConfigs(bundler, versions, threshold);
        if (selected.length > 0) {
            saveDynamicVersionDetectionScatConfig(selected);
        } else {
            printMsg(MSG.Warn, `[!] Version detection: dynamic selection found no valid scat configs`);
        }
        return selected;
    }

    // Static config: parse comma-separated scat categories and convert to bucket dir name.
    const categories = detectConfig
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    const scatDir = scatToDir(categories);
    if (!scatDir) {
        printMsg(
            MSG.Err,
            `[!] --detect-version-config "${detectConfig}" produced an empty scat dir; check category names`
        );
        process.exit(26);
    }

    // Validate by checking that reliable_signatures.json is non-empty for all versions.
    let versions: string[];
    try {
        versions = await listAvailableVersions(bundler);
    } catch (e) {
        printMsg(MSG.Warn, `[!] Version detection: could not list versions to validate static config (${String(e)})`);
        return [];
    }

    const valid = await validateStaticScatConfig(bundler, versions, scatDir);
    if (!valid) {
        printMsg(
            MSG.Err,
            `[!] --detect-version-config "${detectConfig}" (scat dir: "${scatDir}") has empty reliable_signatures.json for one or more versions. Cannot use for version detection.`
        );
        process.exit(26);
    }

    return [scatDir];
}

/**
 * Refactors JavaScript code chunks based on technology-specific patterns.
 *
 * This function takes mapped code chunks and applies technology-specific refactoring
 * rules to improve code readability, remove obfuscation, and standardize formatting.
 * The refactored code is written to individual files in the output directory.
 *
 * @param mappedJson - Path to the mapped JSON file containing code chunks
 * @param outputDir - Directory where refactored code files will be written
 * @param tech - Technology stack identifier (e.g., 'next' for Next.js)
 * @param list - Whether to list available technologies instead of running refactoring
 * @param assetsDir - Directory holding downloaded vendor chunk files not present in
 *   `mapped.json` (react-webpack/react-vite only). Defaults to `<mapped.json's dir>/assets`
 *   when omitted; pass explicitly when `mapped.json` isn't co-located with the assets dir.
 * @returns Promise that resolves when refactoring is complete
 */
const refactor = async (
    mappedJson: string,
    outputDir: string,
    tech: string,
    list: boolean,
    collisionsFile?: string,
    remoteOpts?: RemoteLibSigsOptions & { noRemote?: boolean },
    assetsDir?: string
): Promise<void> => {
    printMsg(MSG.Header, "[i] Loading refactor module...");

    if (list) {
        printMsg(MSG.Header, "[i] Listing available technologies");
        for (const key of Object.keys(availableTechs) as Array<keyof typeof availableTechs>) {
            printMsg(MSG.Run, `- ${key}: ${availableTechs[key]}`);
        }
        return;
    }

    // check if the file exists
    if (!fs.existsSync(mappedJson)) {
        printMsg(MSG.Err, "[!] Mapped JSON file does not exist");
        process.exit(7);
    }

    // verify if the tech provided is valid
    if (!Object.keys(availableTechs).includes(tech)) {
        printMsg(MSG.Err, "[!] Invalid technology provided");
        process.exit(8);
    }

    // check if the output directory already exists
    if (fs.existsSync(outputDir)) {
        printMsg(MSG.Err, "[!] Output directory already exists");
        process.exit(9);
    } else {
        fs.mkdirSync(outputDir);
    }

    // read the mapped JSON file
    const chunks: Chunks = JSON.parse(fs.readFileSync(mappedJson, "utf8"));

    // Load CS-MAST cross-app baseline signatures.
    // Priority: --collisions (local path) > remote HF (default) > none.
    let libSigs: Set<string> | undefined;
    let libStrippingSkipped: { tech: string; scat: string; branch: string } | null = null;
    if (collisionsFile) {
        // Explicit local path — use existing resolver unchanged.
        const result = buildLibSigs(collisionsFile, tech, remoteOpts?.scat);
        if (!result) {
            printMsg(MSG.Err, `[!] Could not resolve library signatures from: ${collisionsFile}`);
            const scat = BASELINE_SCAT_DIR[tech];
            if (scat) {
                printMsg(
                    MSG.Err,
                    `    accepted layouts:\n` +
                        `      <file>                                           (direct collisions.json)\n` +
                        `      <dir>/baselines/${tech}/${scat}/collisions.json\n` +
                        `      <dir>/${tech}/${scat}/collisions.json\n` +
                        `      <dir>/${scat}/collisions.json\n` +
                        `      <dir>/collisions.json\n` +
                        `      <dir>/<feature>/${scat}/collisions.json          (per-feature results dir)`
                );
            }
            process.exit(10);
        }
        libSigs = result.sigs;
        printMsg(MSG.Header, `[i] Loaded ${libSigs.size} library signatures from ${result.desc}`);
    } else if (remoteOpts?.remoteCollisions || (!remoteOpts?.noRemote && TECH_TO_BRANCH[tech])) {
        // Load from remote HuggingFace dataset.
        // --remote-collisions uses the explicit path; otherwise falls back to TECH_TO_BRANCH.
        const opts: RemoteLibSigsOptions = {
            signatureQuality: remoteOpts?.signatureQuality ?? 100,
            refreshCache: remoteOpts?.refreshCache ?? false,
            skipCacheChecks: remoteOpts?.skipCacheChecks ?? false,
            remoteCollisions: remoteOpts?.remoteCollisions,
            scat: remoteOpts?.scat,
        };
        const result = await loadRemoteLibSigs(tech, opts);
        if (result) {
            libSigs = result.sigs;
        } else {
            printMsg(MSG.Warn, `[~] Remote signatures unavailable — proceeding without library stripping`);
            const branch = opts.remoteCollisions ?? TECH_TO_BRANCH[tech] ?? "unknown";
            const scatDir = opts.scat ? scatToDir(opts.scat) : (BASELINE_SCAT_DIR[tech] ?? "unknown");
            libStrippingSkipped = { tech, scat: scatDir, branch };
        }
    }

    // iterate through the chunks
    if (tech === "next-turbopack") {
        for (const [, value] of Object.entries(chunks)) {
            const moduleFiles = await refactorNext(value);
            for (const [moduleId, rawCode] of Object.entries(moduleFiles)) {
                const formatted = await prettier.format(rawCode, {
                    parser: "babel",
                    singleQuote: true,
                    trailingComma: "none",
                });
                // Skip writing empty files
                if (formatted.trim().length === 0) {
                    printMsg(MSG.Info, `[~] Module ${moduleId} is empty after stripping — skipping`);
                    continue;
                }
                const filePath = `${outputDir}/${moduleId}.js`;
                fs.writeFileSync(filePath, formatted);
                printMsg(MSG.Run, `[✓] Module ${moduleId} written to ${filePath}`);
            }
        }
    } else if (tech === "next-webpack") {
        if (remoteOpts?.scat) {
            printMsg(MSG.Header, `[i] Using custom scat config: ${remoteOpts.scat.join(",")}`);
        }
        for (const [, value] of Object.entries(chunks)) {
            const moduleFiles = await refactorNextWebpack(
                value,
                libSigs,
                remoteOpts?.scat as import("@shriyanss/cs-mast").ScatCategory[] | undefined
            );
            for (const [moduleId, rawCode] of Object.entries(moduleFiles)) {
                let formatted: string;
                try {
                    formatted = await prettier.format(rawCode, {
                        parser: "babel",
                        singleQuote: true,
                        trailingComma: "none",
                    });
                } catch {
                    formatted = rawCode;
                }
                if (formatted.trim().length === 0) {
                    printMsg(MSG.Info, `[~] Module ${moduleId} is empty after stripping — skipping`);
                    continue;
                }
                const filePath = `${outputDir}/${moduleId}.js`;
                fs.writeFileSync(filePath, formatted);
                printMsg(MSG.Run, `[✓] Module ${moduleId} written to ${filePath}`);
            }
        }
    } else if (tech === "react-webpack") {
        // Sort chunks so the main bundle (contains library module definitions) is processed
        // first.  Its libModuleMap is then available when processing lazy chunks that import
        // those same library module IDs (e.g. 540=React, 848=jsx-runtime, 671=react-router-dom).
        const sortedEntries = Object.entries(chunks).sort(([a], [b]) => {
            const aIsLazy = /^\d+_/.test(a);
            const bIsLazy = /^\d+_/.test(b);
            if (!aIsLazy && bIsLazy) return -1; // main bundle first
            if (aIsLazy && !bIsLazy) return 1;
            return 0;
        });

        // Accumulated library module map — grows as main bundles are processed.
        // Passed to each subsequent chunk so lazy chunks can rewrite library imports.
        const accLibModuleMap = new Map<string, LibraryModuleInfo>();

        // Pre-scan vendor chunks from the assets directory that are not in mapped.json.
        // These files (e.g. vendor-router.*.js, vendor-react-dom.*.js) contain library
        // modules whose export maps must be classified before processing application chunks.
        const preScanAssetsDir = findAssetsDir(mappedJson, assetsDir);
        if (preScanAssetsDir) {
            const vendorFiles = findVendorChunkFiles(chunks, preScanAssetsDir);
            for (const vendorFile of vendorFiles) {
                printMsg(MSG.Header, `[i] Pre-scanning vendor chunk: ${path.basename(vendorFile)}`);
                const vendorCode = fs.readFileSync(vendorFile, "utf8");
                const vendorChunk = {
                    id: path.basename(vendorFile, ".js"),
                    description: "",
                    loadedOn: [] as [],
                    containsFetch: false,
                    isAxiosLibrary: false,
                    exports: [] as string[],
                    callStack: [] as [],
                    code: vendorCode,
                    imports: [] as string[],
                    file: vendorFile,
                };
                const vendorResult = await refactorReact(vendorChunk, undefined, undefined, true);
                for (const [id, info] of vendorResult.libModuleMap) {
                    accLibModuleMap.set(id, info);
                    printMsg(MSG.Info, `  [-] Vendor module ${id} → ${info.type} (${info.exportMap.size} exports)`);
                }
            }
        }

        if (remoteOpts?.scat) {
            printMsg(MSG.Header, `[i] Using custom scat config: ${remoteOpts.scat.join(",")}`);
        }
        const writtenFiles: string[] = [];
        for (const [, value] of sortedEntries) {
            const result: RefactorReactResult = await refactorReact(
                value,
                libSigs,
                accLibModuleMap,
                false,
                remoteOpts?.scat as import("@shriyanss/cs-mast").ScatCategory[] | undefined
            );
            // Merge this chunk's library classifications into the accumulator.
            for (const [id, info] of result.libModuleMap) {
                accLibModuleMap.set(id, info);
            }
            for (const [moduleId, rawCode] of Object.entries(result.files)) {
                const formatted = await prettier.format(rawCode, {
                    parser: "babel",
                    singleQuote: true,
                    trailingComma: "none",
                });
                // Skip writing empty files (e.g. index.js after webpack runtime stripping).
                if (formatted.trim().length === 0) {
                    printMsg(MSG.Info, `[~] Module ${moduleId} is empty after stripping — skipping`);
                    continue;
                }
                const filePath = `${outputDir}/${moduleId}.js`;
                fs.writeFileSync(filePath, formatted);
                writtenFiles.push(filePath);
                printMsg(MSG.Run, `[✓] Module ${moduleId} written to ${outputDir}/${moduleId}.js`);
            }
        }

        // Version detection — run before build check so the detected version can be
        // written into package.json by runBuildCheck.
        let detectedVersion: VersionDetectionResult | undefined;
        if (remoteOpts?.detectVersion && VERSION_TECH_TO_BUNDLER[tech]) {
            const bundler = VERSION_TECH_TO_BUNDLER[tech];
            const vScatDirs = await resolveVersionDetectionScatDirs(bundler, remoteOpts);
            if (vScatDirs.length > 0) {
                // Include vendor chunk file contents (e.g. vendor-react-dom.*.js) that hold
                // React library code but are not present in mapped.json.  Without these, the
                // signature set contains only app-level code and misses version-specific React
                // library signatures.
                const vendorCodes: string[] = [];
                const vDetectAssetsDir = findAssetsDir(mappedJson, assetsDir);
                if (vDetectAssetsDir) {
                    for (const vendorFile of findVendorChunkFiles(chunks, vDetectAssetsDir)) {
                        try {
                            vendorCodes.push(fs.readFileSync(vendorFile, "utf8"));
                        } catch {
                            // non-fatal
                        }
                    }
                }

                const vResult = await detectReactVersion(
                    chunks,
                    tech,
                    vScatDirs,
                    vendorCodes.length > 0 ? vendorCodes : undefined
                );
                if (vResult) {
                    printMsg(
                        MSG.Run,
                        `[✓] Detected React version: ${vResult.versionKey} (${vResult.matchCount} signature matches)`
                    );
                    detectedVersion = vResult;
                } else {
                    printMsg(MSG.Warn, `[!] Version detection: no matching version found`);
                }
            }
        }

        // Build check — scaffold a minimal webpack project and verify the refactored
        // code compiles.
        runBuildCheck(outputDir, writtenFiles, detectedVersion);
    } else if (tech === "react-vite") {
        // Pre-scan vendor chunks from the assets directory that are not in mapped.json.
        // Vendor chunks (vendor-react-*.js) are referenced by app chunks but are typically
        // absent from mapped.json. Without them, vendorExportMaps is empty and vendor
        // import statements are never rewritten — leaving unresolvable references in output.
        const vitAssetsDir = findAssetsDir(mappedJson, assetsDir);
        if (vitAssetsDir) {
            const missingFiles = findVendorChunkFiles(chunks, vitAssetsDir);
            for (const vendorFile of missingFiles) {
                const basename = path.basename(vendorFile);
                if (!/vendor[-_]react/i.test(basename) && !/rolldown[-_]runtime/i.test(basename)) continue;
                printMsg(MSG.Header, `[i] Including missing vendor chunk: ${basename}`);
                const key = basename.replace(/\.js$/, "");
                chunks[key] = {
                    id: basename,
                    description: "",
                    loadedOn: [],
                    containsFetch: false,
                    isAxiosLibrary: false,
                    exports: [],
                    callStack: [],
                    code: fs.readFileSync(vendorFile, "utf8"),
                    imports: [],
                    file: `assets/${basename}`,
                };
            }
        }

        const viteFiles = await refactorVite(
            chunks,
            libSigs,
            remoteOpts?.scat as import("@shriyanss/cs-mast").ScatCategory[] | undefined
        );

        // Group chunk outputs by their output file path before writing.
        // Multiple mapped.json sub-chunks can originate from the same Vite source
        // file (one per top-level function detected by `map`). Writing each
        // sub-chunk independently would overwrite previous writes so only the last
        // sub-chunk would survive. Grouping and concatenating avoids the overwrite:
        // all sub-chunks for the same file are merged into one formatted output.
        const fileGroups = new Map<string, { codes: string[]; keys: string[] }>();
        for (const [chunkKey, rawCode] of Object.entries(viteFiles)) {
            // Use the original chunk basename so dynamic imports (which reference
            // the original Vite filenames) resolve correctly in the build check.
            const chunkInfo = chunks[chunkKey];
            const originalFile = chunkInfo ? (chunkInfo.file ?? chunkInfo.id) : null;
            const outputBasename = originalFile
                ? path.basename(originalFile)
                : chunkKey.replace(/[/\\]/g, "_").replace(/\.js$/, "") + ".js";
            const filePath = `${outputDir}/${outputBasename}`;
            if (!fileGroups.has(filePath)) {
                fileGroups.set(filePath, { codes: [], keys: [] });
            }
            fileGroups.get(filePath)!.codes.push(rawCode);
            fileGroups.get(filePath)!.keys.push(chunkKey);
        }

        const writtenFiles: string[] = [];
        for (const [filePath, { codes, keys }] of fileGroups) {
            // Put import-bearing code parts first so ESM import statements end up
            // at the top of the concatenated file. Helper sub-chunks typically have
            // no imports; the component sub-chunk that has peer imports (e.g.
            // from ./shared-*.js) must come first or the combined file is invalid.
            const importBearing = codes.filter((c) => /^import\s/m.test(c));
            const rest = codes.filter((c) => !/^import\s/m.test(c));
            const combined = [...importBearing, ...rest].join("\n\n");

            let formatted: string;
            try {
                formatted = await prettier.format(combined, {
                    parser: "babel",
                    singleQuote: true,
                    trailingComma: "none",
                });
            } catch {
                formatted = combined;
            }
            if (formatted.trim().length === 0) {
                printMsg(MSG.Info, `[~] Chunk ${keys.join("+")} is empty after refactoring — skipping`);
                continue;
            }
            fs.writeFileSync(filePath, formatted);
            // Push exactly once per output file — prevents duplicate entries in
            // writtenFiles that would cause the rename loop in runViteBuildCheck
            // to attempt renaming the same path twice (ENOENT on the second try).
            writtenFiles.push(filePath);
            for (const key of keys) {
                printMsg(MSG.Run, `[✓] Chunk ${key} written to ${filePath}`);
            }
        }

        // Version detection — run before build check so the detected version can be
        // written into package.json by runViteBuildCheck.
        let viteDetectedVersion: VersionDetectionResult | undefined;
        if (remoteOpts?.detectVersion && VERSION_TECH_TO_BUNDLER[tech]) {
            const bundler = VERSION_TECH_TO_BUNDLER[tech];
            const vScatDirs = await resolveVersionDetectionScatDirs(bundler, remoteOpts);
            if (vScatDirs.length > 0) {
                const vResult = await detectReactVersion(chunks, tech, vScatDirs);
                if (vResult) {
                    printMsg(
                        MSG.Run,
                        `[✓] Detected React version: ${vResult.versionKey} (${vResult.matchCount} signature matches)`
                    );
                    viteDetectedVersion = vResult;
                } else {
                    printMsg(MSG.Warn, `[!] Version detection: no matching version found`);
                }
            }
        }

        // Build check with Vite scaffold
        runViteBuildCheck(outputDir, writtenFiles, viteDetectedVersion);
    } else if (tech === "vue-webpack") {
        for (const [, value] of Object.entries(chunks)) {
            const moduleFiles = await refactorVueWebpack(value);
            for (const [moduleId, rawCode] of Object.entries(moduleFiles)) {
                let formatted: string;
                try {
                    formatted = await prettier.format(rawCode, {
                        parser: "babel",
                        singleQuote: true,
                        trailingComma: "none",
                    });
                } catch {
                    formatted = rawCode;
                }
                if (formatted.trim().length === 0) {
                    printMsg(MSG.Info, `[~] Module ${moduleId} is empty after stripping — skipping`);
                    continue;
                }
                const filePath = `${outputDir}/${moduleId}.js`;
                fs.writeFileSync(filePath, formatted);
                printMsg(MSG.Run, `[✓] Module ${moduleId} written to ${filePath}`);
            }
        }
    } else if (tech === "vue-vite") {
        const viteFiles = await refactorVueVite(chunks);
        for (const [chunkKey, rawCode] of Object.entries(viteFiles)) {
            const chunkInfo = chunks[chunkKey];
            const originalFile = chunkInfo ? (chunkInfo.file ?? chunkInfo.id) : null;
            const outputBasename = originalFile
                ? path.basename(originalFile)
                : chunkKey.replace(/[/\\]/g, "_").replace(/\.js$/, "") + ".js";
            const filePath = `${outputDir}/${outputBasename}`;

            let formatted: string;
            try {
                formatted = await prettier.format(rawCode, {
                    parser: "babel",
                    singleQuote: true,
                    trailingComma: "none",
                });
            } catch {
                formatted = rawCode;
            }
            if (formatted.trim().length === 0) {
                printMsg(MSG.Info, `[~] Chunk ${chunkKey} is empty after refactoring — skipping`);
                continue;
            }
            fs.writeFileSync(filePath, formatted);
            printMsg(MSG.Run, `[✓] Chunk ${chunkKey} written to ${filePath}`);
        }
    }

    if (libStrippingSkipped) {
        const { tech: skippedTech, scat, branch } = libStrippingSkipped;
        printMsg(MSG.Warn, "=".repeat(60));
        printMsg(MSG.Warn, "[!] LIBRARY STRIPPING WAS SKIPPED FOR THIS RUN");
        printMsg(MSG.Warn, `    tech: ${skippedTech}  scat: ${scat}  branch: ${branch}`);
        printMsg(MSG.Warn, "    No remote collisions data available — output includes library code.");
        printMsg(MSG.Warn, "=".repeat(60));
    }

    printMsg(MSG.Run, "[✓] Refactoring complete.");
};

export default refactor;
