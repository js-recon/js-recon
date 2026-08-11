import fs from "fs";
import path from "path";
import parser from "@babel/parser";
import _traverse from "@babel/traverse";
const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;
import { Chunks } from "../../utility/interfaces.js";
import { File } from "@babel/types";
import * as globals from "../../utility/globals.js";
import { getCompletion } from "../../utility/ai.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

const FUNC_NAME_RE = /^[a-zA-Z_]{2}$/;

// Vendor/runtime chunk names that contain no app logic — skip them to keep
// the mapped output lean and avoid false-positive rule hits on library code.
const VENDOR_PREFIXES = ["vendor-", "rolldown-runtime", "chunk-"];

const isVendorFile = (filename: string): boolean => {
    const base = path.basename(filename);
    return VENDOR_PREFIXES.some((p) => base.startsWith(p));
};

interface FileMeta {
    stem: string;
    hash: string;
}

const parseFilename = (filename: string): FileMeta | null => {
    const base = path.basename(filename);
    if (!base.endsWith(".js") && !base.endsWith(".mjs")) return null;
    const stem = base.endsWith(".mjs") ? base.slice(0, -4) : base.slice(0, -3);
    const dashIdx = stem.lastIndexOf("-");
    if (dashIdx < 1) return null;
    return { stem: stem.slice(0, dashIdx), hash: stem.slice(dashIdx + 1) };
};

const getReactConnections = async (directory: string, output: string, formats: string[]): Promise<Chunks> => {
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

    if (fs.existsSync(`${output}.json`) && globals.getAi().length > 0) {
        printMsg(MSG.Warn, `[!] Output file ${output}.json already exists. Skipping regeneration to save costs.`);
        return JSON.parse(fs.readFileSync(`${output}.json`, "utf8"));
    }

    printMsg(MSG.Header, "[i] Getting React (Vite/Rolldown) connections");

    let files = fs.readdirSync(directory, { recursive: true, encoding: "utf8" }) as string[];
    files = files.filter(
        (f) => (f.endsWith(".js") || f.endsWith(".mjs")) && !f.includes("___subsequent_requests") && !isVendorFile(f)
    );
    files = files.filter((f) => !fs.lstatSync(path.join(directory, f)).isDirectory());

    const stemCount = new Map<string, number>();
    for (const file of files) {
        const meta = parseFilename(file);
        if (meta) stemCount.set(meta.stem, (stemCount.get(meta.stem) || 0) + 1);
    }

    const computeChunkKey = (funcName: string, meta: FileMeta): string => {
        const suffix = (stemCount.get(meta.stem) ?? 0) === 1 ? meta.stem.slice(0, 6) : meta.hash.slice(0, 6);
        return `${funcName}__${suffix}`;
    };

    const chunks: Chunks = {};
    const fileFuncToChunkId = new Map<string, Map<string, string>>();

    // Pass 1: find root-level 2-char function declarations (Vite/Rolldown minification pattern)
    const MAX_MAP_FILE_SIZE_BYTES = 8 * 1024 * 1024;
    printMsg(MSG.Header, `[i] Scanning ${files.length} React JS files for functions`);
    for (const file of files) {
        const meta = parseFilename(file);
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

        for (const node of ast.program.body) {
            if (node.type !== "FunctionDeclaration") continue;
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
                containsFetch: /\bfetch\s*\(/.test(funcCode),
                isAxiosLibrary: false,
                exports: [],
                callStack: [],
                code: funcCode,
                imports: [],
                file: file,
            };
            fileFuncs.set(funcName, key);
        }

        // Fallback: emit the whole file as one chunk when no 2-char root functions are found
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
    }

    // Build normalized path lookup for import resolution
    const pathByNormalized = new Map<string, string>();
    for (const file of files) {
        pathByNormalized.set(path.normalize(file), file);
    }

    const resolveImportSource = (importingFile: string, source: string): string | null => {
        if (!source.startsWith(".") && !source.startsWith("/")) return null;
        const resolved = path.normalize(path.join(path.dirname(importingFile), source));
        return pathByNormalized.get(resolved) ?? null;
    };

    // Pass 2: resolve imports and exports
    printMsg(MSG.Header, "[i] Resolving imports and exports");
    for (const file of files) {
        const meta = parseFilename(file);
        if (!meta) continue;
        const fileFuncs = fileFuncToChunkId.get(file);
        if (!fileFuncs || fileFuncs.size === 0) continue;

        const filePath = path.join(directory, file);
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

        const importMap = new Map<string, { source: string; original: string }>();
        const exportMap = new Map<string, string[]>();

        for (const node of ast.program.body) {
            if (node.type === "ImportDeclaration") {
                for (const spec of node.specifiers) {
                    if (spec.type === "ImportSpecifier") {
                        const imported = spec.imported.type === "Identifier" ? spec.imported.name : spec.imported.value;
                        importMap.set(spec.local.name, { source: node.source.value, original: imported });
                    } else if (spec.type === "ImportDefaultSpecifier") {
                        importMap.set(spec.local.name, { source: node.source.value, original: "default" });
                    } else if (spec.type === "ImportNamespaceSpecifier") {
                        importMap.set(spec.local.name, { source: node.source.value, original: "*" });
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

        for (const [funcName, chunkId] of fileFuncs.entries()) {
            const exportNames = exportMap.get(funcName);
            if (exportNames) chunks[chunkId].exports = exportNames;
        }

        traverse(ast, {
            FunctionDeclaration(funcPath) {
                if (funcPath.parent.type !== "Program") return;
                const name = funcPath.node.id?.name;
                if (!name || !FUNC_NAME_RE.test(name)) return;
                const chunkId = fileFuncs.get(name);
                if (!chunkId) return;

                const importsSet = new Set<string>();
                funcPath.traverse({
                    Identifier(idPath) {
                        const idName = idPath.node.name;
                        if (!importMap.has(idName)) return;
                        const parent = idPath.parent;
                        if (parent.type === "MemberExpression" && parent.property === idPath.node && !parent.computed)
                            return;
                        if (parent.type === "ObjectProperty" && parent.key === idPath.node && !parent.computed) return;
                        const { source, original } = importMap.get(idName)!;
                        const resolvedFile = resolveImportSource(file, source);
                        if (!resolvedFile) return;
                        const targetMap = fileFuncToChunkId.get(resolvedFile);
                        if (!targetMap) return;
                        const targetId = targetMap.get(original);
                        if (targetId) importsSet.add(targetId);
                    },
                });

                chunks[chunkId].imports = Array.from(importsSet);
            },
        });
    }

    printMsg(MSG.Run, `[✓] Found ${Object.keys(chunks).length} React chunks`);

    if (globals.getAi() && globals.getAi().includes("description")) {
        printMsg(MSG.Header, "[i] Generating AI descriptions for chunks");
        const chunkEntries = Object.entries(chunks);
        const descriptionPromises: Promise<{ key: string; description: string }>[] = [];
        let activeThreads = 0;
        const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        const systemPrompt =
            "You are a code analyzer. You will be given a function from a Vite-bundled React application. Generate a one-liner description of what the function does.";

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
                    return { key, description: "none" };
                } finally {
                    activeThreads--;
                }
            })();
            descriptionPromises.push(promise);
        }

        const results = await Promise.all(descriptionPromises);
        results.forEach(({ key, description }) => {
            if (chunks[key]) chunks[key].description = description || "none";
        });
    }

    if (formats.includes("json")) {
        fs.writeFileSync(`${output}.json`, JSON.stringify(chunks, null, 2));
        printMsg(MSG.Run, `[✓] Saved React connections to ${output}.json`);
    }

    return chunks;
};

export default getReactConnections;
