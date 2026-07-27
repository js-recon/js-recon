import chalk from "chalk";
import puppeteer from "../../utility/puppeteerInstance.js";
import { getChromiumPath } from "../../utility/getChromiumPath.js";
import parser from "@babel/parser";
import _traverse from "@babel/traverse";
const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;
import inquirer from "inquirer";
import cliProgress from "cli-progress";
import makeRequest, { buildPuppeteerProxyArgs, getResolvedProxyConfigFromGlobals } from "../../utility/makeReq.js";
import execFunc from "../../utility/runSandboxed.js";
import { getJsonUrls, getJsUrls, pushToJsonUrls, pushToJsUrls } from "../globals.js";
import * as globals from "../../utility/globals.js";
import { setActiveBarLogger, computeBarSize, watchBarResize } from "../../utility/progressLog.js";
import { isSigintHandlerActive } from "../../run/interruptHandler.js";
import { runWithConcurrency } from "../../utility/concurrency.js";

type MatchedFunction = {
    source: string;
    jsUrl: string;
    jsContent: string;
};

/**
 * Discovers lazy-loaded JS chunk URLs by scanning ALL JS files loaded during the
 * initial page visit, not just webpack-named files.
 *
 * Workflow:
 *  1. Load the page via Puppeteer to capture every network JS request.
 *  2. Scan each discovered JS file for functions that end in `".js"` — the
 *     signature of a webpack chunk URL builder (e.g. __webpack_require__.u).
 *     A progress bar shows how many files have been checked.
 *  3. For each matched function, show the source and ask the user to approve or
 *     deny execution. If the `--yes` / `-y` flag is set, auto-approve.
 *  4. Execute approved functions with every integer found in their source and
 *     collect the resulting chunk paths as absolute URLs.
 *
 * @param {string} url - The URL of the page to crawl.
 * @returns {Promise<string[]>} Deduplicated absolute URLs of discovered JS chunks.
 */
const next_GetLazyResourcesWebpackJs = async (url: string, threads: number = 1): Promise<string[]> => {
    const chromiumPath = getChromiumPath();
    const sandboxArgs = globals.getDisableSandbox()
        ? ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
        : [];
    const proxyArgs = buildPuppeteerProxyArgs(getResolvedProxyConfigFromGlobals());
    const browser = await puppeteer.launch({
        headless: true,
        executablePath: chromiumPath,
        args: ["--disable-external-protocol-dialog", ...sandboxArgs, ...(proxyArgs.arg ? [proxyArgs.arg] : [])],
        handleSIGINT: !isSigintHandlerActive(),
    });

    const page = await browser.newPage();
    if (proxyArgs.authenticate) {
        await page.authenticate(proxyArgs.authenticate);
    }

    const cdp = await page.createCDPSession();
    await cdp.send("Page.setDownloadBehavior", { behavior: "deny" });

    await page.evaluateOnNewDocument(() => {
        const origOpen = window.open.bind(window);
        window.open = (url?: string | URL, ...rest: string[]) => {
            if (url != null && !/^https?:/i.test(String(url))) return null;
            return origOpen(url, ...rest);
        };
        document.addEventListener(
            "click",
            (e) => {
                const anchor = (e.target as Element).closest("a[href]") as HTMLAnchorElement | null;
                if (anchor && !/^https?:/i.test(anchor.href)) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                }
            },
            true
        );
    });

    await page.setRequestInterception(true);

    page.on("request", async (request) => {
        const req_url = request.url();

        if (request.method() === "GET" && req_url.match(/https?:\/\/[a-z0-9:\._\-]+\/.+\.js\??.*/)) {
            if (!getJsUrls().includes(req_url)) {
                pushToJsUrls(req_url);
            }
        }

        if (request.method() === "GET" && req_url.match(/https?:\/\/[\d\w\.\-]+\/.+\.json\??.*$/)) {
            if (!getJsonUrls().includes(req_url)) {
                pushToJsonUrls(req_url);
            }
        }

        if (/^https?:\/\//i.test(req_url)) {
            await request.continue();
        } else {
            await request.abort();
        }
    });

    try {
        await page.goto(url, { waitUntil: "networkidle0" });
    } catch {
        console.error(chalk.yellow("[!] Timeout reached for page load. Continuing with the current state"));
    }

    await browser.close();

    const jsUrls = getJsUrls();

    if (jsUrls.length === 0) {
        console.error(chalk.yellow("[!] No JS files discovered during page load"));
        return [];
    }

    console.log(chalk.cyan(`[i] Scanning ${jsUrls.length} JS file(s) for chunk URL builders`));

    // ── progress bar ──────────────────────────────────────────────────────
    const FORMAT = `  ${chalk.cyan("Scanning")} [{bar}] {percentage}% | {value}/{total}`;
    const overhead = 42;

    const bar = new cliProgress.SingleBar(
        {
            format: FORMAT,
            barsize: computeBarSize(overhead),
            hideCursor: true,
            clearOnComplete: true,
        },
        cliProgress.Presets.shades_classic
    );

    bar.start(jsUrls.length, 0);
    setActiveBarLogger(bar as any);
    const stopResize = watchBarResize(bar, overhead);

    const matched: MatchedFunction[] = [];
    let processed = 0;

    await runWithConcurrency(jsUrls, threads, async (jsUrl) => {
        try {
            const res = await makeRequest(jsUrl, {});
            if (!res || res.status !== 200) {
                processed++;
                bar.update(processed);
                return;
            }

            const jsContent = await res.text();

            // Fast path: skip files that cannot possibly contain the pattern
            if (!jsContent.includes('".js"')) {
                processed++;
                bar.update(processed);
                return;
            }

            let ast;
            try {
                ast = parser.parse(jsContent, {
                    sourceType: "unambiguous",
                    plugins: ["jsx", "typescript"],
                    errorRecovery: true,
                });
            } catch {
                processed++;
                bar.update(processed);
                return;
            }

            traverse(ast, {
                FunctionDeclaration(p) {
                    const start = p.node.start ?? 0;
                    const end = p.node.end ?? jsContent.length;
                    const source = jsContent.slice(start, end);
                    if (source.match(/"\.js".{0,15}$/)) matched.push({ source, jsUrl, jsContent });
                },
                FunctionExpression(p) {
                    const start = p.node.start ?? 0;
                    const end = p.node.end ?? jsContent.length;
                    const source = jsContent.slice(start, end);
                    if (source.match(/"\.js".{0,15}$/)) matched.push({ source, jsUrl, jsContent });
                },
                ArrowFunctionExpression(p) {
                    const start = p.node.start ?? 0;
                    const end = p.node.end ?? jsContent.length;
                    const source = jsContent.slice(start, end);
                    if (source.match(/"\.js".{0,15}$/)) matched.push({ source, jsUrl, jsContent });
                },
                ObjectMethod(p) {
                    const start = p.node.start ?? 0;
                    const end = p.node.end ?? jsContent.length;
                    const source = jsContent.slice(start, end);
                    if (source.match(/"\.js".{0,15}$/)) matched.push({ source, jsUrl, jsContent });
                },
                ClassMethod(p) {
                    const start = p.node.start ?? 0;
                    const end = p.node.end ?? jsContent.length;
                    const source = jsContent.slice(start, end);
                    if (source.match(/"\.js".{0,15}$/)) matched.push({ source, jsUrl, jsContent });
                },
            });
        } catch {
            // skip files with fetch/parse errors
        }

        processed++;
        bar.update(processed);
    });

    bar.stop();
    setActiveBarLogger(null);
    stopResize();

    if (matched.length === 0) {
        console.error(chalk.yellow("[!] No chunk URL builder functions found in discovered JS files"));
        return [];
    }

    console.log(chalk.green(`[✓] Found ${matched.length} chunk URL builder function(s)`));

    // ── user approval and execution ───────────────────────────────────────
    const chunkUrls: string[] = [];

    for (const { source, jsUrl, jsContent } of matched) {
        console.log(chalk.green(`[✓] Found chunk URL builder in ${jsUrl}`));
        console.log(chalk.yellow(source));

        let approved: boolean;
        if (globals.getYes()) {
            approved = true;
        } else {
            const { confirmed } = await inquirer.prompt([
                {
                    type: "confirm",
                    name: "confirmed",
                    message: "Execute this function to enumerate chunk URLs?",
                    default: true,
                },
            ]);
            approved = confirmed;
        }

        if (!approved) {
            console.error(chalk.red("[!] Skipping function."));
            continue;
        }

        console.log(chalk.cyan("[i] Executing function to enumerate chunk URLs"));

        // Detect free variable .p accesses (webpack __webpack_public_path__).
        // When a chunk URL builder is extracted from its surrounding scope, outer
        // variables like `i` or `o` that hold the public path are undefined in
        // the sandbox. We inject a mock declaration so the function executes.
        const funcParamRe = /^(?:function\s*\w*\s*\(([^)]*)\)|(?:\(([^)]*)\)|([a-zA-Z_$]\w*))\s*=>)/;
        const paramMatch = source.match(funcParamRe);
        const funcParams = new Set(
            [paramMatch?.[1] ?? "", paramMatch?.[2] ?? "", paramMatch?.[3] ?? ""]
                .join(",")
                .split(",")
                .map((p) => p.trim())
                .filter(Boolean)
        );
        const pVarMatch = source.match(/\b([a-zA-Z_$]\w*)\.p\b/);
        const pVarName = pVarMatch && !funcParams.has(pVarMatch[1]) ? pVarMatch[1] : null;

        let publicPath = "";
        if (pVarName) {
            const assignRe = new RegExp(`\\b${pVarName}\\.p\\s*=\\s*["']([^"']*)["']`);
            const assignMatch = jsContent.match(assignRe);
            if (assignMatch) publicPath = assignMatch[1];
            // If not found, publicPath stays "". The existing new URL(output, baseDir)
            // resolution will handle relative paths produced by the function correctly.
        }

        const preamble = pVarName ? `var ${pVarName}={p:${JSON.stringify(publicPath)}};` : "";
        const urlBuilderFunc = `(()=>{${preamble}return(${source})})()`;
        const integers = source.match(/\d+/g);
        if (!integers) continue;

        const baseDir = jsUrl.split("/").slice(0, -2).join("/");

        try {
            for (const i of integers) {
                const output = execFunc(urlBuilderFunc, parseInt(i));
                if (typeof output !== "string" || output.includes("undefined")) continue;
                const fullUrl = new URL(output, baseDir).href;
                chunkUrls.push(fullUrl);
            }
        } catch (err) {
            console.error(chalk.red("Unsafe or invalid code:", err.message));
        }
    }

    const unique = [...new Set(chunkUrls)];
    if (unique.length > 0) {
        console.log(chalk.green(`[✓] Found ${unique.length} JS chunk URL(s)`));
    }

    return unique;
};

export default next_GetLazyResourcesWebpackJs;
