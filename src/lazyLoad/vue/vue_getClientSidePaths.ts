import makeRequest from "../../utility/makeReq.js";
import _traverse from "@babel/traverse";
import chalk from "chalk";
import cliProgress from "cli-progress";
import parser from "@babel/parser";
import t from "@babel/types";
import {
    activateBarLogger,
    computeBarSize,
    progressLog,
    watchBarResize,
    withProgressResources,
} from "../../utility/progressLog.js";
import { runWithConcurrency } from "../../utility/concurrency.js";

const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;

const vue_getClientSidePaths = async (
    url: string,
    jsFiles: string[],
    maxJsSizeMb: number = 2,
    threads: number = 1,
    showProgress: boolean = true
): Promise<string[]> => {
    const MAX_JS_SIZE_BYTES = maxJsSizeMb * 1024 * 1024;
    const toReturn: string[] = [];

    const baseOrigin = new URL(url).origin;
    const addClientPath = (pathValue: string, jsFileOrigin: string): void => {
        if (pathValue.startsWith("//")) {
            try {
                toReturn.push(new URL(`https:${pathValue}`).href);
            } catch {
                // Ignore malformed target-controlled URL strings.
            }
            return;
        }
        if (pathValue.startsWith("/")) {
            try {
                toReturn.push(new URL(pathValue, baseOrigin).href);
            } catch {
                // Ignore malformed target-controlled URL strings.
            }
            return;
        }
        if (pathValue.startsWith("http")) {
            try {
                const parsed = new URL(pathValue);
                if (parsed.origin === jsFileOrigin) toReturn.push(parsed.href);
            } catch {
                // Ignore malformed target-controlled URL strings.
            }
        }
    };

    const bar = showProgress
        ? new cliProgress.SingleBar(
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
          )
        : null;

    let processed = 0;
    let skipped = 0;
    bar?.start(jsFiles.length, 0, { paths: 0, skipped: 0 });
    const stopBarWatcher = bar ? watchBarResize(bar, 86) : () => undefined;
    const releaseBarLogger = bar
        ? activateBarLogger({ log: (s: string) => process.stdout.write("\r\x1b[K" + s) }, process.stdout.isTTY === true)
        : () => undefined;

    // iterate through all those
    await withProgressResources(
        () =>
            runWithConcurrency(jsFiles, threads, async (jsFile) => {
                if (!jsFile.endsWith(".js")) {
                    processed++;
                    skipped++;
                    bar?.update(processed, { paths: toReturn.length, skipped });
                    return;
                }
                const req = await makeRequest(jsFile);

                if (req == null) {
                    processed++;
                    skipped++;
                    bar?.update(processed, { paths: toReturn.length, skipped });
                    return;
                }

                const jsContent = await req.text();

                if (jsContent.length > MAX_JS_SIZE_BYTES) {
                    processed++;
                    skipped++;
                    bar?.update(processed, { paths: toReturn.length, skipped });
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
                    bar?.update(processed, { paths: toReturn.length, skipped });
                    return;
                }

                let jsFileOrigin: string;
                try {
                    jsFileOrigin = new URL(jsFile).origin;
                } catch {
                    processed++;
                    skipped++;
                    bar?.update(processed, { paths: toReturn.length, skipped });
                    return;
                }
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

                            addClientPath(linkVal, jsFileOrigin);
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

                                        addClientPath(pathVal, jsFileOrigin);
                                    }
                                }
                            }
                        }
                    },
                });

                processed++;
                if (toReturn.length === pathsBefore) skipped++;
                bar?.update(processed, { paths: toReturn.length, skipped });
            }),
        () => bar?.stop(),
        stopBarWatcher,
        releaseBarLogger
    );

    if (toReturn.length > 0) {
        progressLog(chalk.green(`[+] Found ${toReturn.length} client-side paths from JS files!`));
    }
    return toReturn;
};

export default vue_getClientSidePaths;
