import makeRequest from "../../utility/makeReq.js";
import _traverse from "@babel/traverse";
import chalk from "chalk";
import cliProgress from "cli-progress";
import parser from "@babel/parser";
import t from "@babel/types";
import { setActiveBarLogger, computeBarSize, watchBarResize } from "../../utility/progressLog.js";
import { runWithConcurrency } from "../../utility/concurrency.js";

const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;

const vue_getClientSidePaths = async (
    url: string,
    jsFiles: string[],
    maxJsSizeMb: number = 2,
    threads: number = 1
): Promise<string[]> => {
    const MAX_JS_SIZE_BYTES = maxJsSizeMb * 1024 * 1024;
    let toReturn: string[] = [];

    const baseOrigin = new URL(url).origin;

    const bar = new cliProgress.SingleBar(
        {
            format:
                chalk.cyan("[i] Extracting client-side paths ") +
                "[{bar}] {percentage}% | {value}/{total} files | {paths} paths | {skipped} skipped",
            barCompleteChar: "█",
            barIncompleteChar: "░",
            barsize: computeBarSize(86),
            hideCursor: false,
            clearOnComplete: false,
            stopOnComplete: false,
        },
        cliProgress.Presets.shades_classic
    );

    let processed = 0;
    let skipped = 0;
    bar.start(jsFiles.length, 0, { paths: 0, skipped: 0 });
    const stopBarWatcher = watchBarResize(bar, 86);
    setActiveBarLogger({ log: (s: string) => process.stdout.write("\r\x1b[K" + s) });

    // iterate through all those
    await runWithConcurrency(jsFiles, threads, async (jsFile) => {
        if (!jsFile.endsWith(".js")) {
            processed++;
            skipped++;
            bar.update(processed, { paths: toReturn.length, skipped });
            return;
        }
        const req = await makeRequest(jsFile);

        if (req == null) {
            processed++;
            skipped++;
            bar.update(processed, { paths: toReturn.length, skipped });
            return;
        }

        const jsContent = await req.text();

        if (jsContent.length > MAX_JS_SIZE_BYTES) {
            processed++;
            skipped++;
            bar.update(processed, { paths: toReturn.length, skipped });
            return;
        }

        // load in ast
        let ast;

        try {
            ast = parser.parse(jsContent, {
                sourceType: "unambiguous",
                plugins: ["jsx", "typescript"],
                errorRecovery: true,
            });
        } catch {
            processed++;
            skipped++;
            bar.update(processed, { paths: toReturn.length, skipped });
            return;
        }

        const jsFileOrigin = new URL(jsFile).origin;
        const pathsBefore = toReturn.length;

        traverse(ast, {
            ObjectProperty(path) {
                const { key, value } = path.node;

                if (
                    t.isIdentifier(key, { name: "link" }) &&
                    t.isStringLiteral(value) &&
                    t.isObjectExpression(path.parent)
                ) {
                    const linkVal = value.value;

                    if (linkVal.startsWith("//")) {
                        toReturn.push("https:" + linkVal);
                    } else if (linkVal.startsWith("/")) {
                        toReturn.push(baseOrigin + linkVal);
                    } else if (linkVal.startsWith("http") && new URL(linkVal).origin === jsFileOrigin) {
                        toReturn.push(linkVal);
                    }
                }
            },

            CallExpression(path) {
                const { callee, arguments: args } = path.node;

                // Match Object.assign(...)
                if (
                    !t.isMemberExpression(callee) ||
                    !t.isIdentifier(callee.object, { name: "Object" }) ||
                    !t.isIdentifier(callee.property, { name: "assign" })
                )
                    return;

                if (args.length < 2) return;

                const [firstArg, secondArg] = args;

                // Match window.<something>.routes
                if (
                    !t.isMemberExpression(firstArg) ||
                    !t.isIdentifier(firstArg.property, { name: "routes" }) ||
                    !t.isMemberExpression(firstArg.object) ||
                    !t.isIdentifier((firstArg.object as t.MemberExpression).object, { name: "window" })
                )
                    return;

                if (!t.isObjectExpression(secondArg)) return;

                for (const routeEntry of secondArg.properties) {
                    if (!t.isObjectProperty(routeEntry) || !t.isObjectExpression(routeEntry.value)) continue;

                    for (const routeProp of routeEntry.value.properties) {
                        if (
                            !t.isObjectProperty(routeProp) ||
                            !t.isIdentifier(routeProp.key, { name: "tokens" }) ||
                            !t.isArrayExpression(routeProp.value)
                        )
                            continue;

                        for (const tokenEl of routeProp.value.elements) {
                            if (!t.isArrayExpression(tokenEl)) continue;

                            const [typeEl, valueEl] = tokenEl.elements;

                            if (t.isStringLiteral(typeEl, { value: "text" }) && t.isStringLiteral(valueEl)) {
                                const pathVal = valueEl.value;

                                if (pathVal.startsWith("//")) {
                                    toReturn.push("https:" + pathVal);
                                } else if (pathVal.startsWith("/")) {
                                    toReturn.push(baseOrigin + pathVal);
                                } else if (pathVal.startsWith("http") && new URL(pathVal).origin === jsFileOrigin) {
                                    toReturn.push(pathVal);
                                }
                            }
                        }
                    }
                }
            },
        });

        processed++;
        if (toReturn.length === pathsBefore) skipped++;
        bar.update(processed, { paths: toReturn.length, skipped });
    });

    bar.stop();
    stopBarWatcher();
    setActiveBarLogger(null);

    if (toReturn.length > 0) {
        console.log(chalk.green(`[+] Found ${toReturn.length} client-side paths from JS files!`));
    }
    return toReturn;
};

export default vue_getClientSidePaths;
