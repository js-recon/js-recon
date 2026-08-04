import parser from "@babel/parser";
import _traverse from "@babel/traverse";
const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;
import execFunc from "../../utility/runSandboxed.js";
import makeRequest from "../../utility/makeReq.js";
import inquirer from "inquirer";
import t from "@babel/types";
import resolvePath from "../../utility/resolvePath.js";
import * as globals from "../../utility/globals.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

export type ChunkBuilderFunction = {
    name: string;
    type: string;
    source: string;
};

/**
 * Pure parser: extracts all function nodes from `jsContent` whose source code
 * ends with the pattern `".js"` followed by up to 15 characters — the signature
 * of a webpack/Nuxt chunk URL builder function.
 */
export const extractChunkBuilderFunctions = (jsContent: string): ChunkBuilderFunction[] => {
    const functions: ChunkBuilderFunction[] = [];
    let ast: any;
    try {
        ast = parser.parse(jsContent, {
            sourceType: "module",
            plugins: ["jsx", "typescript"],
            errorRecovery: true,
        });
    } catch {
        return functions;
    }

    const collect = (path: any, name: string, type: string) => {
        const source = jsContent.slice(path.node.start, path.node.end);
        if (source.match(/"\.js".{0,15}$/)) {
            functions.push({ name, type, source });
        }
    };

    traverse(ast, {
        FunctionDeclaration(path) {
            collect(path, path.node.id?.name || "(anonymous)", "FunctionDeclaration");
        },
        FunctionExpression(path) {
            collect(path, (path.parent as any).id?.name || "(anonymous)", "FunctionExpression");
        },
        ArrowFunctionExpression(path) {
            collect(path, (path.parent as any).id?.name || "(anonymous)", "ArrowFunctionExpression");
        },
        ObjectMethod(path) {
            collect(path, (path.node.key as any).name, "ObjectMethod");
        },
        ClassMethod(path) {
            collect(path, (path.node.key as any).name, "ClassMethod");
        },
    });

    return functions;
};

/**
 * Finds all the lazy loaded JS files from a given URL using a Nuxt.js specific approach.
 */
const nuxt_astParse = async (url: string) => {
    let filesFound = [];
    const resp = await makeRequest(url, {});
    const body = await resp.text();

    const functions = extractChunkBuilderFunctions(body);

    if (functions.length === 0) {
        printMsg(MSG.Err, `[!] Error parsing JS file: ${url}`);
        return filesFound;
    }

    // Rebuild the full AST for later member-expression resolution.
    let ast: any;
    try {
        ast = parser.parse(body, {
            sourceType: "module",
            plugins: ["jsx", "typescript"],
            errorRecovery: true,
        });
    } catch (error) {
        printMsg(MSG.Err, `[!] Error parsing JS file: ${url}`);
        return filesFound;
    }

    for (const func of functions) {
        {
            printMsg(MSG.Run, `[✓] Found JS chunk having the following source:`);
            printMsg(MSG.Warn, func.source);

            let user_verified;
            if (!globals.getYes()) {
                const askCorrectFuncConfirmation = async () => {
                    const { value } = await inquirer.prompt([
                        {
                            type: "confirm",
                            name: "value",
                            message: "Is this the correct function?",
                            default: true,
                        },
                    ]);
                    return value;
                };

                user_verified = await askCorrectFuncConfirmation();
            } else {
                user_verified = true;
            }
            if (user_verified === true) {
                printMsg(MSG.Header, "[i] Proceeding with the selected function to fetch files");
            } else {
                printMsg(MSG.Err, "[!] Not executing function.");
                continue;
            }
            // get the value of the unknown vars
            // first, get the name of the unknown function
            const unknownVarAst = parser.parse(`(${func.source})`, {
                sourceType: "script",
                plugins: ["jsx", "typescript"],
                errorRecovery: true,
            });
            let memberExpressions = [];
            traverse(unknownVarAst, {
                MemberExpression(path) {
                    // Only collect identifiers like f.p (not obj["x"])
                    if (
                        t.isIdentifier(path.node.object) &&
                        t.isIdentifier(path.node.property) &&
                        !path.node.computed // ignore obj["x"]
                    ) {
                        const objName = path.node.object.name;
                        const propName = path.node.property.name;
                        memberExpressions.push(`${objName}.${propName}`);
                    }
                },
            });

            const unknownVar = memberExpressions[0].split(".");

            // now, resolve the value of this unknown var
            let unknownVarValue;

            traverse(ast, {
                AssignmentExpression(path) {
                    const { left, right } = path.node;

                    if (
                        t.isMemberExpression(left) &&
                        t.isIdentifier(left.object, { name: unknownVar[0] }) &&
                        t.isIdentifier(left.property, {
                            name: unknownVar[1],
                        }) &&
                        !left.computed
                    ) {
                        if (t.isStringLiteral(right)) {
                            unknownVarValue = right.value;
                        } else {
                            // fallback to source snippet
                            unknownVarValue = func.source.slice(right.start, right.end);
                        }
                    }
                },
            });

            // replace the unknown var with the value
            const funcSource = func.source.replace(
                new RegExp(`${unknownVar[0]}.${unknownVar[1]}`),
                `"${unknownVarValue}"`
            );

            // continue to executing the function with all possible numbers
            const urlBuilderFunc = `(() => (${funcSource}))()`;
            let js_paths = [];

            try {
                // rather than fuzzing, grep the integers from the func code
                const integers = funcSource.match(/\d+/g);
                if (integers) {
                    // Check if integers were found
                    // iterate through all integers, and get the output
                    for (const i of integers) {
                        const output = execFunc(urlBuilderFunc, parseInt(i));
                        if (output.includes("undefined")) {
                            continue;
                        } else {
                            js_paths.push(output);
                        }
                    }
                }
            } catch (error) {
                printMsg(MSG.Err, `[!] Error executing function: ${error}`);
            }

            if (js_paths.length > 0) {
                // iterate through the files, and resolve them
                for (const js_path of js_paths) {
                    const resolvedPath = await resolvePath(url, js_path);
                    filesFound.push(resolvedPath);
                }
            }
        }
    }

    if (filesFound.length > 0) {
        printMsg(MSG.Run, `[✓] Found ${filesFound.length} JS chunks`);
    }

    return filesFound;
};

export default nuxt_astParse;
