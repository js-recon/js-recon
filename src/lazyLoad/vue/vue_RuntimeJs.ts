import chalk from "chalk";
import makeRequest from "../../utility/makeReq.js";
import * as cheerio from "cheerio";
import * as parser from "@babel/parser";
import _traverse from "@babel/traverse";
const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;
import inquirer from "inquirer";
import CONFIG from "../../globalConfig.js";
import execFunc from "../../utility/runSandboxed.js";
import * as globals from "../../utility/globals.js";
import { progressError, progressLog, progressWarn } from "../../utility/progressLog.js";

const vue_runtimeJs = async (url: string, allowPrompt: boolean = true): Promise<string[]> => {
    const rootHtmlRes = await makeRequest(url);
    if (!rootHtmlRes) {
        progressError(chalk.red(`[!] Failed to fetch ${url}`));
        return [];
    }
    const rootHtml: string = await rootHtmlRes.text();

    let runtimeJsUrl: string | undefined;

    const $ = cheerio.load(rootHtml);
    $("script").each((_, el) => {
        const attribs = el.attribs;
        if (attribs) {
            for (const [attrName, attrValue] of Object.entries(attribs)) {
                // Match webpack runtime filename specifically: /runtime.<hex>.js
                // Exclude things like /vue.runtime.2.7.20.min.js
                if (attrName === "src" && attrValue.match(/\/runtime\.[a-f0-9]+\.js(?:$|\?)/)) {
                    runtimeJsUrl = attrValue;
                }
            }
        }
    });

    if (!runtimeJsUrl) {
        progressError(chalk.red("[!] No runtime JS file found in page source"));
        progressLog(chalk.magenta(CONFIG.notFoundMessage));
        return [];
    }

    if (!runtimeJsUrl.startsWith("http")) {
        runtimeJsUrl = new URL(runtimeJsUrl, url).href;
    }

    const runtimeJsRes = await makeRequest(runtimeJsUrl);
    if (!runtimeJsRes) {
        progressError(chalk.red(`[!] Failed to fetch ${runtimeJsUrl}`));
        return [];
    }
    const runtimeJsContent: string = await runtimeJsRes.text();

    const ast = parser.parse(runtimeJsContent, {
        sourceType: "unambiguous",
        plugins: ["jsx", "typescript"],
        errorRecovery: true,
    });

    let scriptSrcFuncSource: string | undefined;
    let publicPathObj: string | undefined;
    let publicPathProp: string | undefined;

    traverse(ast, {
        AssignmentExpression(path) {
            const { left, right } = path.node;

            // Anchor on the always-present pattern: script.src = function(e){...}(e)
            if (
                left.type === "MemberExpression" &&
                left.object.type === "Identifier" &&
                (left.object as any).name === "script" &&
                left.property.type === "Identifier" &&
                (left.property as any).name === "src" &&
                right.type === "CallExpression" &&
                right.callee.type === "FunctionExpression"
            ) {
                const funcExpr: any = right.callee;
                if (funcExpr.start !== null && funcExpr.end !== null) {
                    scriptSrcFuncSource = runtimeJsContent.slice(funcExpr.start, funcExpr.end);
                }

                // The public-path variable is whatever sits leftmost in the
                // concatenation chain of the return statement. The webpack
                // template emits any short <obj>.<prop> identifier here, not
                // necessarily `c.p`.
                const returnStmt = funcExpr.body?.body?.find((s: any) => s.type === "ReturnStatement");
                if (returnStmt && returnStmt.argument) {
                    let cursor: any = returnStmt.argument;
                    while (cursor && cursor.type === "BinaryExpression") {
                        cursor = cursor.left;
                    }
                    if (
                        cursor &&
                        cursor.type === "MemberExpression" &&
                        !cursor.computed &&
                        cursor.object.type === "Identifier" &&
                        cursor.property.type === "Identifier"
                    ) {
                        publicPathObj = cursor.object.name;
                        publicPathProp = cursor.property.name;
                    }
                }
            }
        },
    });

    if (!scriptSrcFuncSource) {
        progressError(chalk.red("[!] Could not find chunk URL builder function in runtime JS"));
        progressLog(chalk.magenta(CONFIG.notFoundMessage));
        return [];
    }

    progressLog(chalk.green("[✓] Found chunk URL builder function"));
    progressLog(chalk.yellow(scriptSrcFuncSource));

    if (publicPathObj && publicPathProp) {
        progressLog(chalk.green(`[✓] Public-path variable detected: ${publicPathObj}.${publicPathProp}`));
    } else {
        progressWarn(
            chalk.yellow(
                "[!] Could not detect public-path variable; will resolve chunk paths against runtime.js directory regardless"
            )
        );
    }

    if (!globals.getYes()) {
        if (!allowPrompt) {
            progressWarn(chalk.yellow("[!] Skipping nested runtime function execution; use --yes to allow it"));
            return [];
        }
        const { confirmed } = await inquirer.prompt([
            {
                type: "confirm",
                name: "confirmed",
                message: "Is this the correct function?",
                default: true,
            },
        ]);
        if (!confirmed) {
            progressError(chalk.red("[!] Not executing function."));
            return [];
        }
    }

    progressLog(chalk.cyan("[i] Proceeding with the selected function to fetch files"));

    // Stub the public-path variable with empty string so the function returns
    // just the relative chunk path (e.g. "pages/index.<hash>.js"). The real
    // public path value isn't needed -- chunks live alongside runtime.js, so
    // resolving the relative path against the runtime.js directory gives the
    // correct absolute URL.
    const stubDecl = publicPathObj && publicPathProp ? `var ${publicPathObj} = { ${publicPathProp}: "" };` : "";
    const urlBuilderFunc = `(() => { ${stubDecl} return (${scriptSrcFuncSource}); })()`;

    const js_paths: string[] = [];
    try {
        const integers = scriptSrcFuncSource.match(/\d+/g);
        if (integers) {
            for (const i of integers) {
                const output = execFunc(urlBuilderFunc, parseInt(i));
                if (output !== null && output !== undefined && !String(output).includes("undefined")) {
                    js_paths.push(String(output));
                }
            }
        }
    } catch (err) {
        progressError(chalk.red(`Unsafe or invalid code: ${err instanceof Error ? err.message : String(err)}`));
        return [];
    }

    const unique_paths = [...new Set(js_paths)];

    if (unique_paths.length > 0) {
        progressLog(chalk.green(`[✓] Found ${unique_paths.length} JS chunks`));
    }

    const runtimeDir = runtimeJsUrl.split("/").slice(0, -1).join("/") + "/";

    const discovered_urls: string[] = [];
    for (const js_path of unique_paths) {
        if (js_path.startsWith("http")) {
            discovered_urls.push(js_path);
        } else {
            discovered_urls.push(new URL(js_path, runtimeDir).href);
        }
    }

    return discovered_urls;
};

export default vue_runtimeJs;
