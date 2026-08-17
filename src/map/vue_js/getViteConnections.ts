import fs from "fs";
import path from "path";
import * as parser from "@babel/parser";
import traverse from "@babel/traverse";
import { printMsg, MSG } from "../../utility/printMsg.js";

import { Chunks } from "../../utility/interfaces.js";
import { File } from "@babel/types";
import * as globals from "../../utility/globals.js";
import { getCompletion } from "../../utility/ai.js";

const FUNC_NAME_RE = /^[a-zA-Z_]{2}$/;

interface FileMeta {
    something: string;
    hash: string;
}

const parseFilename = (filename: string): FileMeta | null => {
    const base = path.basename(filename);
    if (!base.endsWith(".js") && !base.endsWith(".mjs")) return null;
    let stem = base.endsWith(".mjs") ? base.slice(0, -4) : base.slice(0, -3);
    if (stem.endsWith(".chunk")) {
        stem = stem.slice(0, -6);
    }
    const parts = stem.split(".");
    if (parts.length < 2) return null;
    const hash = parts[parts.length - 1];
    const something = parts.slice(0, -1).join(".");
    if (!something || !hash) return null;
    return { something, hash };
};

// Lightweight per-function import reference — stored instead of the live AST
// so the AST can be freed after each file is processed.
interface ImportRef {
    source: string;
    original: string;
}

const getViteConnections = async (directory: string, output: string, formats: string[]): Promise<Chunks> => {
    const maxAiThreads = globals.getAiThreads();
    if (globals.getAi().length > 0) {
        printMsg(
            MSG.Warn,
            "[!] AI integration is enabled. This may incur costs. By using this feature, you agree to the AI provider's terms of service, and accept the risk of incurring unexpected costs due to huge codebase."
        );
        const provider = globals.getAiServiceProvider();
        if (provider === "openai") {
            const apiKey = globals.getAiApiKey() || process.env.OPENAI_API_KEY;
            if (!apiKey) {
                printMsg(
                    MSG.Err,
                    "[!] OpenAI API key not found. Please provide it via --ai-api-key or OPENAI_API_KEY environment variable."
                );
                process.exit(19);
            }
        }
        if (provider === "anthropic") {
            const apiKey = globals.getAiApiKey() || process.env.ANTHROPIC_API_KEY;
            if (!apiKey) {
                printMsg(
                    MSG.Err,
                    "[!] Anthropic API key not found. Please provide it via --ai-api-key or ANTHROPIC_API_KEY environment variable."
                );
                process.exit(19);
            }
        }
        printMsg(MSG.Header, `[i] AI provider "${provider}" initialized.`);
    }

    // skip regeneration when an AI-tagged JSON already exists, since it would burn $$$
    if (fs.existsSync(`${output}.json`) && globals.getAi().length > 0) {
        printMsg(MSG.Warn, `[!] Output file ${output}.json already exists. Skipping regeneration to save costs.`);
        const chunks = JSON.parse(fs.readFileSync(`${output}.json`, "utf8"));
        return chunks;
    }

    printMsg(MSG.Header, "[i] Getting Vite (Vue.JS) connections");

    let files = fs.readdirSync(directory, {
        recursive: true,
        encoding: "utf8",
    }) as string[];

    files = files.filter(
        (f) => (f.endsWith(".js") || f.endsWith(".mjs") || f.endsWith(".vue")) && !f.includes("___subsequent_requests")
    );
    files = files.filter((f) => !fs.lstatSync(path.join(directory, f)).isDirectory());

    const fileMeta = new Map<string, FileMeta>();
    const somethingCount = new Map<string, number>();
    for (const file of files) {
        const meta = parseFilename(file);
        if (!meta) continue;
        fileMeta.set(file, meta);
        somethingCount.set(meta.something, (somethingCount.get(meta.something) || 0) + 1);
    }

    const computeChunkKey = (funcName: string, meta: FileMeta): string => {
        const isDistinct = somethingCount.get(meta.something) === 1;
        const suffix = isDistinct ? meta.something.slice(0, 4) : meta.hash.slice(0, 4);
        return `${funcName}__${suffix}`;
    };

    // Build basename -> file path lookup for import resolution (cheap, no I/O)
    const pathByNormalized = new Map<string, string>();
    for (const file of files) {
        pathByNormalized.set(path.normalize(file), file);
    }

    const resolveImportSource = (importingFile: string, source: string): string | null => {
        if (!source.startsWith(".") && !source.startsWith("/")) return null;
        const fileDir = path.dirname(importingFile);
        const resolved = path.normalize(path.join(fileDir, source));
        return pathByNormalized.get(resolved) ?? null;
    };

    const chunks: Chunks = {};
    const fileFuncToChunkId = new Map<string, Map<string, string>>();

    // Per-chunk import references collected during the single parse pass.
    // Stored as lightweight data so ASTs can be freed immediately after each file.
    const chunkImportRefs = new Map<string, ImportRef[]>();

    // Single pass: parse each file once, extract functions + imports + exports.
    // This replaces the previous two-pass approach (Pass 1 + Pass 2) that parsed
    // every file twice and kept ASTs alive across both loops.
    const MAX_MAP_FILE_SIZE_BYTES = 8 * 1024 * 1024;
    printMsg(MSG.Header, `[i] Scanning ${files.length} JS files for root functions`);
    for (const file of files) {
        const meta = fileMeta.get(file);

        const filePath = path.join(directory, file);
        if (fs.statSync(filePath).size > MAX_MAP_FILE_SIZE_BYTES) {
            printMsg(MSG.Warn, `[!] Skipping ${file} (too large for map analysis)`);
            continue;
        }
        let code: string;
        try {
            code = fs.readFileSync(filePath, "utf8");
        } catch {
            continue;
        }

        let ast: parser.ParseResult<File>;
        try {
            ast = parser.parse(code, {
                sourceType: "unambiguous",
                plugins: ["jsx", "typescript"],
                errorRecovery: true,
            });
        } catch {
            continue;
        }

        const fileFuncs = new Map<string, string>();
        fileFuncToChunkId.set(file, fileFuncs);

        // Collect imports/exports from the top-level declaration list.
        const importMap = new Map<string, { source: string; original: string }>();
        const exportMap = new Map<string, string[]>();

        for (const node of ast.program.body) {
            if (node.type === "FunctionDeclaration") {
                if (!node.id || !FUNC_NAME_RE.test(node.id.name)) continue;
                if (!meta) continue;
                const funcName = node.id.name;
                const key = computeChunkKey(funcName, meta);
                if (chunks[key]) continue;
                const funcCode = code.slice(node.start ?? 0, node.end ?? 0);
                chunks[key] = {
                    id: key,
                    description: "none",
                    loadedOn: [],
                    containsFetch: false,
                    isAxiosLibrary: false,
                    exports: [],
                    callStack: [],
                    code: funcCode,
                    imports: [],
                    file: file,
                };
                fileFuncs.set(funcName, key);
            } else if (node.type === "ImportDeclaration") {
                const source = node.source.value;
                for (const spec of node.specifiers) {
                    if (spec.type === "ImportSpecifier") {
                        const importedName =
                            spec.imported.type === "Identifier" ? spec.imported.name : spec.imported.value;
                        importMap.set(spec.local.name, { source, original: importedName });
                    } else if (spec.type === "ImportDefaultSpecifier") {
                        importMap.set(spec.local.name, { source, original: "default" });
                    } else if (spec.type === "ImportNamespaceSpecifier") {
                        importMap.set(spec.local.name, { source, original: "*" });
                    }
                }
            } else if (node.type === "ExportNamedDeclaration" && !node.declaration) {
                for (const spec of node.specifiers) {
                    if (spec.type !== "ExportSpecifier") continue;
                    const localName = spec.local.name;
                    const exportedAs = spec.exported.type === "Identifier" ? spec.exported.name : spec.exported.value;
                    const arr = exportMap.get(localName) ?? [];
                    arr.push(exportedAs);
                    exportMap.set(localName, arr);
                }
            }
        }

        // Fallback for Vite dev-mode / non-bundled files: production-style 2-char
        // function chunking doesn't apply, so emit the whole file as a single chunk
        // so the AST analysis engine still has something to scan.
        if (fileFuncs.size === 0) {
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
                code: code,
                imports: [],
                file: file,
            };
        }

        // Apply exports now that we have fileFuncs and exportMap.
        for (const [funcName, chunkId] of fileFuncs.entries()) {
            const exportNames = exportMap.get(funcName);
            if (exportNames) chunks[chunkId].exports = exportNames;
        }

        // Collect per-function import references in a single AST traversal so the
        // AST can be discarded immediately after this loop body. Lightweight ImportRef
        // objects are stored instead of live AST node references.
        if (importMap.size > 0) {
            traverse(ast, {
                FunctionDeclaration(funcPath) {
                    if (funcPath.parent.type !== "Program") return;
                    const name = funcPath.node.id?.name;
                    if (!name || !FUNC_NAME_RE.test(name)) return;
                    const chunkId = fileFuncs.get(name);
                    if (!chunkId) return;

                    const refs: ImportRef[] = [];
                    funcPath.traverse({
                        Identifier(idPath) {
                            const idName = idPath.node.name;
                            if (!importMap.has(idName)) return;
                            const parent = idPath.parent;
                            if (
                                parent.type === "MemberExpression" &&
                                parent.property === idPath.node &&
                                !parent.computed
                            )
                                return;
                            if (parent.type === "ObjectProperty" && parent.key === idPath.node && !parent.computed)
                                return;
                            const imp = importMap.get(idName)!;
                            refs.push({ source: imp.source, original: imp.original });
                        },
                    });

                    if (refs.length > 0) chunkImportRefs.set(chunkId, refs);
                },
            });
        }

        // ast and code go out of scope here — the GC can reclaim them.
    }

    // Resolve collected import references to chunk IDs (no re-parsing needed).
    printMsg(MSG.Header, "[i] Resolving imports and exports");
    for (const [chunkId, refs] of chunkImportRefs.entries()) {
        const chunk = chunks[chunkId];
        if (!chunk) continue;
        const file = chunk.file;

        const importsSet = new Set<string>();
        for (const { source, original } of refs) {
            const resolvedFile = resolveImportSource(file, source);
            if (!resolvedFile) continue;
            const targetMap = fileFuncToChunkId.get(resolvedFile);
            if (!targetMap) continue;
            const targetId = targetMap.get(original);
            if (targetId) importsSet.add(targetId);
        }
        chunk.imports = Array.from(importsSet);
    }

    printMsg(MSG.Run, `[✓] Found ${Object.keys(chunks).length} Vue.JS functions`);

    // if AI description is enabled, generate descriptions for each chunk in parallel batches
    if (globals.getAi() && globals.getAi().includes("description")) {
        printMsg(MSG.Header, "[i] Generating descriptions for chunks");
        const chunkEntries = Object.entries(chunks);
        const descriptionPromises: Promise<{ key: string; description: string }>[] = [];
        let activeThreads = 0;
        const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        const systemPrompt =
            "You are a code analyzer. You will be given a function from a Vite-bundled Vue.JS application. You have to generate a one-liner description of what the function does.";

        for (const [key, value] of chunkEntries) {
            while (activeThreads >= maxAiThreads) {
                await sleep(Math.floor(Math.random() * 451) + 50);
            }

            activeThreads++;
            const promise = (async () => {
                try {
                    const description = await getCompletion(value.code, systemPrompt);
                    return { key, description };
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    printMsg(MSG.Err, `[!] Error generating description for chunk ${key}: ${msg}`);
                    return { key, description: "none" };
                } finally {
                    activeThreads--;
                }
            })();
            descriptionPromises.push(promise);
        }

        const results = await Promise.all(descriptionPromises);

        results.forEach(({ key, description }) => {
            if (chunks[key]) {
                chunks[key].description = description || "none";
                printMsg(MSG.Run, `[✓] Generated description for ${key}: ${chunks[key].description}`);
            }
        });
    }

    if (formats.includes("json")) {
        // Write the JSON file incrementally to avoid allocating a single string
        // that mirrors the entire chunks object in memory (which can be GBs for
        // large apps).
        const outputPath = `${output}.json`;
        const writeStream = fs.createWriteStream(outputPath);
        writeStream.write("{\n");
        const entries = Object.entries(chunks);
        for (let i = 0; i < entries.length; i++) {
            const [key, value] = entries[i];
            const isLast = i === entries.length - 1;
            // Indent inner lines by 2 extra spaces to match pretty-print style.
            const valueStr = JSON.stringify(value, null, 2)
                .split("\n")
                .map((line, j) => (j === 0 ? line : "  " + line))
                .join("\n");
            writeStream.write(`  ${JSON.stringify(key)}: ${valueStr}${isLast ? "" : ","}\n`);
        }
        writeStream.write("}");
        await new Promise<void>((resolve, reject) => {
            writeStream.end((err?: Error | null) => {
                if (err) reject(err);
                else resolve();
            });
        });
        printMsg(MSG.Run, `[✓] Saved Vite connections to ${output}.json`);
    }

    return chunks;
};

export default getViteConnections;
