import fs from "fs";
import path from "path";
import * as parser from "@babel/parser";
import traverse from "@babel/traverse";
import { Chunks } from "../../utility/interfaces.js";

import * as globals from "../../utility/globals.js";
import { getCompletion } from "../../utility/ai.js";
import { File } from "@babel/types";
import { printMsg, MSG } from "../../utility/printMsg.js";

/**
 * Gets the turbopack connections for a given directory and output file name.
 *
 * Turbopack-compiled Next.JS files share the same top-level shape but use a
 * different push payload than webpack — the array argument contains a
 * currentScript marker followed by `id, fn, id, fn, ...` pairs instead of an
 * object expression. Inside each function, `e.i(<id>)` is the analog of
 * `__webpack_require__(<id>)`.
 *
 * @param {string} directory - The directory to search for turbopack chunks.
 * @param {string} output - The output file name (without extension).
 * @param {string[]} formats - The output formats to generate.
 * @param {Chunks} existingChunks - Chunks already collected by other parsers (e.g. webpack); new turbopack chunks are merged in.
 * @returns {Promise<Chunks>} - A promise that resolves with the merged chunks dictionary.
 */
const getTurbopackConnections = async (
    directory: string,
    output: string,
    formats: string[],
    existingChunks: Chunks = {}
): Promise<Chunks> => {
    const maxAiThreads = globals.getAiThreads();

    printMsg(MSG.Header, "[i] Getting turbopack connections");

    let files = fs.readdirSync(directory, {
        recursive: true,
        encoding: "utf8",
    });

    files = files.filter((file) => {
        return !file.includes("___subsequent_requests");
    });

    files = files.filter((file) => {
        return !fs.lstatSync(path.join(directory, file)).isDirectory();
    });

    const chunks: Chunks = existingChunks;
    let newChunkCount = 0;

    for (const file of files) {
        const filePath = path.join(directory, file.toString());
        const code = fs.readFileSync(filePath, "utf8");

        // quick filter: the file must reference globalThis.TURBOPACK
        if (!code.includes("globalThis.TURBOPACK")) {
            continue;
        }

        let ast: parser.ParseResult<File>;
        try {
            ast = parser.parse(code, {
                sourceType: "unambiguous",
                plugins: ["jsx", "typescript"],
                errorRecovery: true,
            });
        } catch (err) {
            continue;
        }

        traverse(ast, {
            CallExpression(p) {
                const callee = p.get("callee");
                if (!callee.isMemberExpression()) return;
                if (!callee.get("property").isIdentifier({ name: "push" })) return;

                // confirm the receiver references the TURBOPACK global. Turbopack emits
                // `(globalThis.TURBOPACK || (globalThis.TURBOPACK = [])).push([...])`,
                // so the .push receiver always contains the literal `TURBOPACK`.
                const objectNode = callee.get("object").node;
                if (!objectNode || objectNode.start == null || objectNode.end == null) return;
                const calleeSrc = code.slice(objectNode.start, objectNode.end);
                if (!calleeSrc.includes("TURBOPACK")) return;

                const arg = p.get("arguments.0");
                if (!arg || !arg.isArrayExpression()) return;

                const elements = arg.get("elements");
                for (let i = 0; i < elements.length; i++) {
                    const el = elements[i];
                    if (!el) continue;
                    // ids are either numeric or string literals; the next element is the module function
                    let idValue: string | number | undefined;
                    if (el.isNumericLiteral()) {
                        idValue = (el.node as any).value;
                    } else if (el.isStringLiteral()) {
                        idValue = (el.node as any).value;
                    } else {
                        continue;
                    }

                    const next = elements[i + 1];
                    if (!next) continue;
                    if (!(
                        next.isArrowFunctionExpression() ||
                        next.isFunctionExpression() ||
                        next.isFunctionDeclaration()
                    )) {
                        continue;
                    }

                    const fnNode = next.node as any;
                    if (fnNode.start == null || fnNode.end == null) continue;
                    const fnSource = code.slice(fnNode.start, fnNode.end);
                    const id = String(idValue);
                    const function_code = `func_${id} = ${fnSource}`;

                    if (!chunks[id]) {
                        newChunkCount++;
                    }
                    chunks[id] = {
                        id,
                        description: "none",
                        loadedOn: [],
                        containsFetch: false,
                        isAxiosLibrary: false,
                        exports: [],
                        callStack: [],
                        code: function_code,
                        imports: [],
                        file: file.toString(),
                    };

                    // skip the function element we just consumed
                    i++;
                }
            },
        });
    }

    // populate imports for turbopack chunks: e.i(<id>) calls inside the function body,
    // where `e` is the first parameter of the module function.
    printMsg(MSG.Header, "[i] Finding imports for turbopack chunks");
    for (const [key, value] of Object.entries(chunks)) {
        // only re-process chunks that look like turbopack output (skip webpack chunks already populated)
        if (!value.code.startsWith(`func_${key} = `)) {
            continue;
        }

        let ast: parser.ParseResult<File>;
        try {
            ast = parser.parse(value.code, {
                sourceType: "unambiguous",
                plugins: ["jsx", "typescript"],
                errorRecovery: true,
            });
        } catch (err) {
            continue;
        }

        let firstArgName: string | undefined;
        traverse(ast, {
            ArrowFunctionExpression(p) {
                if (firstArgName) return;
                const params = p.get("params");
                if (params.length >= 1 && params[0].isIdentifier()) {
                    firstArgName = (params[0].node as any).name;
                }
            },
            FunctionExpression(p) {
                if (firstArgName) return;
                const params = p.get("params");
                if (params.length >= 1 && params[0].isIdentifier()) {
                    firstArgName = (params[0].node as any).name;
                }
            },
            FunctionDeclaration(p) {
                if (firstArgName) return;
                const params = p.get("params");
                if (params.length >= 1 && params[0].isIdentifier()) {
                    firstArgName = (params[0].node as any).name;
                }
            },
        });

        if (!firstArgName) continue;

        traverse(ast, {
            CallExpression(p) {
                const callee = p.get("callee");
                if (!callee.isMemberExpression()) return;
                const object = callee.get("object");
                const property = callee.get("property");
                if (!object.isIdentifier({ name: firstArgName })) return;
                if (!property.isIdentifier({ name: "i" })) return;
                const arg0 = p.get("arguments.0");
                if (!arg0) return;
                let importId: string | undefined;
                if (arg0.isNumericLiteral() || arg0.isStringLiteral()) {
                    importId = String((arg0.node as any).value);
                }
                if (!importId) return;
                if (!chunks[key].imports.includes(importId)) {
                    chunks[key].imports.push(importId);
                }
            },
        });
    }

    // optional AI descriptions for turbopack chunks (mirrors the webpack path)
    if (globals.getAi() && globals.getAi().includes("description")) {
        printMsg(MSG.Header, "[i] Generating descriptions for turbopack chunks");
        const turbopackEntries = Object.entries(chunks).filter(
            ([k, v]) => v.code.startsWith(`func_${k} = `) && v.description === "none"
        );
        const descriptionPromises = [];
        let activeThreads = 0;
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const systemPrompt =
            "You are a code analyzer. You will be given a function from a Turbopack-compiled Next.JS file. You have to generate a one-liner description of what the function does.";

        for (const [key, value] of turbopackEntries) {
            while (activeThreads >= maxAiThreads) {
                await sleep(Math.floor(Math.random() * 451) + 50);
            }

            activeThreads++;
            const promise = (async () => {
                try {
                    const description = await getCompletion(value.code, systemPrompt);
                    return { key, description };
                } catch (err) {
                    printMsg(MSG.Err, `[!] Error generating description for chunk ${key}: ${err.message}`);
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

    printMsg(MSG.Run, `[✓] Found ${newChunkCount} turbopack functions`);

    if (formats.includes("json")) {
        const chunks_json = JSON.stringify(chunks, null, 2);
        fs.writeFileSync(`${output}.json`, chunks_json);
        printMsg(MSG.Run, `[✓] Saved turbopack connections to ${output}.json`);
    }

    return chunks;
};

export default getTurbopackConnections;
