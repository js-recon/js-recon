import fs, { readdirSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { extractSources } from "../lazyLoad/sourcemap.js";
import { printMsg, MSG } from "../utility/printMsg.js";

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

export const extractSourceMaps = async (assetsDir: string, outputDir: string): Promise<void> => {
    const mapFiles = getMapFilesRecursively(assetsDir);
    let counter = 0;

    for (const mapFile of mapFiles) {
        const raw = readFileSync(mapFile, "utf-8");
        // Older runs prepended a `// File Source: ...` banner to .js.map files;
        // current runs write pure JSON. Strip the leading banner if present.
        const mapContent = raw.startsWith("//") ? raw.split("\n").slice(1).join("\n") : raw;
        const { files } = extractSources(mapContent);

        for (const file of files) {
            if (file.path === "." || file.path === "") continue;
            const outPath = join(outputDir, file.path);
            mkdirSync(dirname(outPath), { recursive: true });
            writeFileSync(outPath, file.content);
            counter++;
        }
    }

    if (counter !== 0) {
        printMsg(MSG.Run, `[✓] Found ${counter} files from source maps - written to ${outputDir}`);
    } else {
        printMsg(MSG.Warn, "[!] No source files found in the provided sourcemap(s)");
    }
};

const sourcemaps = async (inputPath: string, outputDir: string): Promise<void> => {
    if (!fs.existsSync(inputPath)) {
        printMsg(MSG.Err, `[!] Input does not exist: ${inputPath}`);
        process.exit(23);
    }

    if (fs.existsSync(outputDir)) {
        printMsg(MSG.Err, `[!] Output directory already exists: ${outputDir}`);
        process.exit(24);
    }

    const stat = fs.statSync(inputPath);

    if (stat.isDirectory()) {
        await extractSourceMaps(inputPath, outputDir);
    } else {
        // Single file
        const raw = readFileSync(inputPath, "utf-8");
        const mapContent = raw.startsWith("//") ? raw.split("\n").slice(1).join("\n") : raw;
        const { files } = extractSources(mapContent);
        let counter = 0;

        for (const file of files) {
            if (file.path === "." || file.path === "") continue;
            const outPath = join(outputDir, file.path);
            mkdirSync(dirname(outPath), { recursive: true });
            writeFileSync(outPath, file.content);
            counter++;
        }

        if (counter !== 0) {
            printMsg(MSG.Run, `[✓] Found ${counter} files from source map - written to ${outputDir}`);
        } else {
            printMsg(MSG.Warn, "[!] No source files found in the provided sourcemap");
        }
    }
};

export default sourcemaps;
