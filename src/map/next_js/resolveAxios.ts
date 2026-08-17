import { Chunks } from "../../utility/interfaces.js";
import * as parser from "@babel/parser";
import traverse, { NodePath } from "@babel/traverse";
import { findAxiosClients } from "./resolveAxiosHelpers/findAxiosClients.js";
import { findAxiosInstance } from "./resolveAxiosHelpers/findAxiosInstance.js";
import { processAxiosCall } from "./resolveAxiosHelpers/processAxiosCall.js";
import { ArrowFunctionExpression, FunctionDeclaration, Node } from "@babel/types";
import { handleZDotCreate, processZDotCreateCall } from "./resolveAxiosHelpers/handleZDotCreate.js";
import { directCallsWithoutAssignment } from "./resolveAxiosHelpers/directCallsWithoutAssignment.js";
import { collectInterceptorHeaders } from "./resolveAxiosHelpers/interceptorHeaders.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

// Headers injected globally by axios request interceptors. Populated once at
// the start of `resolveAxios` and read by the per-call processors so every
// emitted endpoint reflects them.
let globalInterceptorHeaders: { [key: string]: string } = {};
export const getGlobalInterceptorHeaders = (): { [key: string]: string } => globalInterceptorHeaders;

/**
 * Gets the third argument of a function declaration or arrow function expression.
 * @param {Node} ast - The abstract syntax tree of the function.
 * @returns {string} - The name of the third argument.
 */
export const getThirdArg = (ast: Node): string => {
    let thirdArg = "";
    traverse(ast, {
        enter(path: NodePath<Node>) {
            let funcNode: FunctionDeclaration | ArrowFunctionExpression | null = null;
            if (path.isFunctionDeclaration()) {
                funcNode = path.node;
            } else if (path.isAssignmentExpression() && path.node.right.type === "ArrowFunctionExpression") {
                funcNode = path.node.right;
            }

            if (funcNode && funcNode.params.length === 3) {
                const thirdParam = funcNode.params[2];
                if (thirdParam.type === "Identifier") {
                    thirdArg = thirdParam.name;
                    path.stop();
                }
            }
        },
    });
    return thirdArg;
};

/**
 * Resolves axios instances in the given chunks.
 * @param {Chunks} chunks - A dictionary of chunk names to chunk objects.
 * @param {string} directory - The directory of the chunk file.
 */
const resolveAxios = async (chunks: Chunks, directory: string) => {
    printMsg(MSG.Header, "[i] Resolving axios instances");

    // Discover headers added by axios request interceptors up-front. The same
    // set applies to every request that flows through the shared axios client,
    // so we attach it to each emitted endpoint below.
    globalInterceptorHeaders = collectInterceptorHeaders(chunks);
    if (Object.keys(globalInterceptorHeaders).length > 0) {
        printMsg(
            MSG.Header,
            `[i] Detected ${Object.keys(globalInterceptorHeaders).length} interceptor-injected header(s): ${Object.keys(globalInterceptorHeaders).join(", ")}`
        );
    }

    const { axiosExportedFrom, axiosImportedTo } = findAxiosClients(chunks);

    if (axiosExportedFrom.length === 0) {
        printMsg(MSG.Warn, "[!] No axios clients defined in any chunk.");
        return;
    }

    if (Object.keys(axiosImportedTo).length === 0) {
        printMsg(MSG.Warn, "[!] No chunks import any of the defined axios clients.");
        return;
    }

    for (const chunkName of Object.keys(chunks)) {
        const chunk = chunks[chunkName];
        const chunkCode = chunk.code;
        let axiosCallsFound = false;

        let ast;
        try {
            ast = parser.parse(chunkCode, {
                sourceType: "unambiguous",
                plugins: ["jsx", "typescript"],
                errorRecovery: true,
            });
        } catch {
            continue;
        }

        // First, check for the n(...).Z.create() pattern
        const zDotCreateInstances: { [key: string]: string } = {};

        traverse(ast, {
            CallExpression(path) {
                const axiosVarName = handleZDotCreate(path, chunkCode, directory, chunkName, chunks, axiosExportedFrom);
                if (axiosVarName) {
                    zDotCreateInstances[axiosVarName] = axiosVarName;
                }
            },
        });

        // Process any found Z.create instances
        for (const axiosVarName of Object.keys(zDotCreateInstances)) {
            traverse(ast, {
                MemberExpression(path) {
                    processZDotCreateCall(path, axiosVarName, chunkCode, directory, chunkName, chunks, ast);
                },
            });
            axiosCallsFound = true;
        }

        // similar to n(...).Z.create() pattern, search for direct calls, like n(...).Z.get(), n(...).Z.post(), etc.
        // for this, iterate through all the chunks, and find which ones import the axios instances

        const axiosLibraries: string[] = Object.values(chunks)
            .filter((chunk) => chunk.isAxiosLibrary === true)
            .map((chunk) => chunk.id);

        if (axiosLibraries.length > 0) {
            const importedAxiosLib = axiosLibraries.find((lib) => chunk.imports?.includes(lib));

            if (importedAxiosLib) {
                // now it can be processed to find axios calls
                const thirdArg = getThirdArg(ast);

                if (thirdArg) {
                    directCallsWithoutAssignment(
                        ast,
                        thirdArg,
                        importedAxiosLib,
                        chunkCode,
                        directory,
                        chunkName,
                        chunks
                    );
                    axiosCallsFound = true;
                }
            }
        }

        // Process regular axios instances
        if (Object.keys(axiosImportedTo).includes(chunkName)) {
            const thirdArg = getThirdArg(ast);

            if (thirdArg) {
                const axiosInstance = findAxiosInstance(ast, thirdArg, axiosImportedTo[chunkName], chunkName);

                if (axiosInstance) {
                    traverse(ast, {
                        MemberExpression(path) {
                            processAxiosCall(path, axiosInstance, chunkCode, directory, chunkName, chunks, ast);
                        },
                    });
                    axiosCallsFound = true;
                }
            } else {
                // This case might not be an error, just a different pattern.
                // console.error(chalk.yellow(`[!] Could not find a function with 3 arguments in ${chunkName}`));
            }
        }

        if (
            !axiosCallsFound &&
            Object.keys(axiosImportedTo).includes(chunkName) &&
            Object.keys(zDotCreateInstances).length !== 0
        ) {
            printMsg(MSG.Warn, `[!] No axios calls found in ${chunkName}`);
        }
    }
};

export default resolveAxios;
