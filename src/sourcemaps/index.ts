import chalk from "chalk";
import fs, { readdirSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path, { join, dirname } from "path";
import { extractSources } from "../lazyLoad/sourcemap.js";

/** Resolves an untrusted source-map path without allowing it to escape outputDir. */
export const resolveSourceMapOutputPath = (outputDir: string, sourcePath: string): string | null => {
    if (path.isAbsolute(sourcePath) || path.win32.isAbsolute(sourcePath)) return null;
    const outputRoot = path.resolve(outputDir);
    const candidate = path.resolve(outputRoot, sourcePath.replace(/\\/g, path.sep));
    const relative = path.relative(outputRoot, candidate);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    return candidate;
};

export const getMapFilesRecursively = (dir: string): string[] => {
    const entries = readdirSync(dir, { withFileTypes: true });
    const mapFiles: string[] = [];

    for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            mapFiles.push(...getMapFilesRecursively(fullPath));
        } else if (entry.isFile() && entry.name.endsWith(".map")) {
            mapFiles.push(fullPath);
        }
    }

    return mapFiles;
};

interface SourceMapWriteResult {
    readonly written: number;
    readonly unsafePaths: number;
    readonly invalidMaps: number;
}

const writeExtractedSourceFiles = (files: readonly unknown[], outputDir: string): SourceMapWriteResult => {
    const outputRoot = path.resolve(outputDir);
    const candidates: { readonly outPath: string; readonly content: string }[] = [];
    let unsafePaths = 0;

    for (const file of files) {
        if (typeof file !== "object" || file === null) {
            return Object.freeze({ written: 0, unsafePaths, invalidMaps: 1 });
        }
        const sourcePath = Reflect.get(file, "path");
        const content = Reflect.get(file, "content");
        if (typeof sourcePath !== "string" || typeof content !== "string") {
            return Object.freeze({ written: 0, unsafePaths, invalidMaps: 1 });
        }
        if (sourcePath === "." || sourcePath === "") continue;
        const outPath = resolveSourceMapOutputPath(outputDir, sourcePath);
        if (!outPath) {
            unsafePaths++;
            continue;
        }
        if (outPath === outputRoot) {
            return Object.freeze({ written: 0, unsafePaths, invalidMaps: 1 });
        }
        candidates.push(Object.freeze({ outPath, content }));
    }

    const outputPaths = new Set(candidates.map(({ outPath }) => outPath));
    if (outputPaths.size !== candidates.length) {
        return Object.freeze({ written: 0, unsafePaths, invalidMaps: 1 });
    }
    for (const { outPath } of candidates) {
        let parent = dirname(outPath);
        while (parent !== outputRoot) {
            if (outputPaths.has(parent)) {
                return Object.freeze({ written: 0, unsafePaths, invalidMaps: 1 });
            }
            const nextParent = dirname(parent);
            if (nextParent === parent) break;
            parent = nextParent;
        }
    }

    let written = 0;
    try {
        for (const { outPath, content } of candidates) {
            mkdirSync(dirname(outPath), { recursive: true });
            writeFileSync(outPath, content);
            written++;
        }
    } catch {
        return Object.freeze({ written, unsafePaths, invalidMaps: 1 });
    }
    return Object.freeze({ written, unsafePaths, invalidMaps: 0 });
};

export const extractSourceMaps = async (assetsDir: string, outputDir: string): Promise<void> => {
    const mapFiles = getMapFilesRecursively(assetsDir);
    let counter = 0;
    let unsafePathCount = 0;
    let invalidMapCount = 0;

    for (const mapFile of mapFiles) {
        let files: ReturnType<typeof extractSources>["files"];
        try {
            const raw = readFileSync(mapFile, "utf-8");
            // Older runs prepended a `// File Source: ...` banner to .js.map files;
            // current runs write pure JSON. Strip the leading banner if present.
            const mapContent = raw.startsWith("//") ? raw.split("\n").slice(1).join("\n") : raw;
            files = extractSources(mapContent).files;
        } catch {
            invalidMapCount++;
            continue;
        }

        const writeResult = writeExtractedSourceFiles(files, outputDir);
        counter += writeResult.written;
        unsafePathCount += writeResult.unsafePaths;
        invalidMapCount += writeResult.invalidMaps;
    }

    if (unsafePathCount > 0) {
        console.warn(chalk.yellow(`[!] Skipped ${unsafePathCount} unsafe source-map output path(s)`));
    }
    if (invalidMapCount > 0) {
        console.warn(chalk.yellow(`[!] Skipped ${invalidMapCount} invalid source map(s)`));
    }

    if (counter !== 0) {
        console.log(chalk.green(`[✓] Found ${counter} files from source maps - written to ${outputDir}`));
    } else {
        console.log(chalk.yellow("[!] No source files found in the provided sourcemap(s)"));
    }
};

const sourcemaps = async (inputPath: string, outputDir: string): Promise<void> => {
    if (!fs.existsSync(inputPath)) {
        console.error(chalk.red(`[!] Input does not exist: ${inputPath}`));
        process.exit(23);
    }

    if (fs.existsSync(outputDir)) {
        console.error(chalk.red(`[!] Output directory already exists: ${outputDir}`));
        process.exit(24);
    }

    const stat = fs.statSync(inputPath);

    if (stat.isDirectory()) {
        await extractSourceMaps(inputPath, outputDir);
    } else {
        // Single file
        let files: ReturnType<typeof extractSources>["files"] = [];
        let invalidMapCount = 0;
        try {
            const raw = readFileSync(inputPath, "utf-8");
            const mapContent = raw.startsWith("//") ? raw.split("\n").slice(1).join("\n") : raw;
            files = extractSources(mapContent).files;
        } catch {
            invalidMapCount = 1;
        }
        let counter = 0;
        let unsafePathCount = 0;

        const writeResult = writeExtractedSourceFiles(files, outputDir);
        counter += writeResult.written;
        unsafePathCount += writeResult.unsafePaths;
        invalidMapCount += writeResult.invalidMaps;

        if (unsafePathCount > 0) {
            console.warn(chalk.yellow(`[!] Skipped ${unsafePathCount} unsafe source-map output path(s)`));
        }
        if (invalidMapCount > 0) {
            console.warn(chalk.yellow(`[!] Skipped ${invalidMapCount} invalid source map(s)`));
        }

        if (counter !== 0) {
            console.log(chalk.green(`[✓] Found ${counter} files from source map - written to ${outputDir}`));
        } else {
            console.log(chalk.yellow("[!] No source files found in the provided sourcemap"));
        }
    }
};

export default sourcemaps;
