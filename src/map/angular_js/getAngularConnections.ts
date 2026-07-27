import fs from "fs";
import path from "path";
import parser from "@babel/parser";

import { Chunks } from "../../utility/interfaces.js";
import { File } from "@babel/types";
import { printMsg, MSG } from "../../utility/printMsg.js";

// Angular CLI (esbuild) emits polyfills as a separate bundle — skip it since
// it contains only browser/zone polyfills with no app API calls.
const SKIP_PREFIXES = ["polyfills-", "polyfills."];

const isSkippedFile = (filename: string): boolean => {
    const base = path.basename(filename);
    return SKIP_PREFIXES.some((p) => base.startsWith(p));
};

const MAX_MAP_FILE_SIZE_BYTES = 1.5 * 1024 * 1024;

/**
 * Reads all Angular CLI (esbuild) JS chunks from the download directory and
 * returns a Chunks map keyed by a sanitised filename. Angular produces an IIFE
 * or ES-module main bundle plus optional lazy route chunks — each file is
 * emitted as a single chunk rather than split by function, because esbuild's
 * IIFE output doesn't use the 2-char root-function convention that Vite uses.
 */
const getAngularConnections = async (directory: string, output: string, formats: string[]): Promise<Chunks> => {
    printMsg(MSG.Header, "[i] Getting Angular (esbuild) connections");

    let files = fs.readdirSync(directory, { recursive: true, encoding: "utf8" }) as string[];
    files = files.filter(
        (f) => (f.endsWith(".js") || f.endsWith(".mjs")) && !f.includes("___subsequent_requests") && !isSkippedFile(f)
    );
    files = files.filter((f) => !fs.lstatSync(path.join(directory, f)).isDirectory());

    const chunks: Chunks = {};

    for (const file of files) {
        const filePath = path.join(directory, file);
        const stat = fs.statSync(filePath);
        if (stat.size > MAX_MAP_FILE_SIZE_BYTES) {
            printMsg(MSG.Warn, `[!] Skipping ${file} (too large for map analysis)`);
            continue;
        }

        let code: string;
        try {
            code = fs.readFileSync(filePath, "utf8");
        } catch {
            continue;
        }

        // Validate that Babel can parse it; skip unparseable files silently.
        try {
            parser.parse(code, {
                sourceType: "unambiguous",
                plugins: ["jsx", "typescript"],
                errorRecovery: true,
            }) as parser.ParseResult<File>;
        } catch {
            continue;
        }

        const baseId = path.basename(file).replace(/[^a-zA-Z0-9]+/g, "_");
        let key = baseId;
        let suffix = 0;
        while (chunks[key]) {
            suffix++;
            key = `${baseId}_${suffix}`;
        }

        chunks[key] = {
            id: key,
            description: "none",
            loadedOn: [],
            containsFetch: /\bfetch\s*\(/.test(code),
            isAxiosLibrary: false,
            exports: [],
            callStack: [],
            code,
            imports: [],
            file,
        };
    }

    printMsg(MSG.Run, `[✓] Found ${Object.keys(chunks).length} Angular chunks`);

    if (formats.includes("json")) {
        fs.writeFileSync(`${output}.json`, JSON.stringify(chunks, null, 2));
        printMsg(MSG.Run, `[✓] Saved Angular connections to ${output}.json`);
    }

    return chunks;
};

export default getAngularConnections;
