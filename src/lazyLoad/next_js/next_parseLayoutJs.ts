import makeRequest from "../../utility/makeReq.js";
import * as parser from "@babel/parser";
import traverse from "@babel/traverse";
import { printMsg, MSG } from "../../utility/printMsg.js";
import next_getJSScript from "./next_GetJSScript.js";
import { runWithConcurrency } from "../../utility/concurrency.js";

/**
 * Recursively resolves a string-producing AST node to a string value.
 * Unknown/dynamic nodes return a random placeholder (matching original behaviour).
 */
const resolveString = (node: any): string => {
    if (!node) return "";
    if (node.type === "StringLiteral") return node.value;
    if (node.type === "TemplateLiteral") {
        let str = "";
        node.quasis.forEach((q: any, i: number) => {
            str += q.value.raw;
            if (i < node.expressions.length) str += resolveString(node.expressions[i]);
        });
        return str;
    }
    if (node.type === "BinaryExpression" && node.operator === "+") {
        return resolveString(node.left) + resolveString(node.right);
    }
    if (node.type === "CallExpression") {
        if (node.callee.type === "MemberExpression" && node.callee.property.name === "concat") {
            let base = resolveString(node.callee.object);
            node.arguments.forEach((arg: any) => {
                base += resolveString(arg);
            });
            return base;
        }
    }
    return Math.random()
        .toString(36)
        .substring(2, 2 + 64);
};

/**
 * Pure parser: given layout.js content, returns every `href` value found in
 * object literals (string, template literal, binary concat, or `.concat()` chain).
 */
export const extractHrefsFromLayoutJs = (jsContent: string): string[] => {
    const hrefs: string[] = [];
    let ast: any;
    try {
        ast = parser.parse(jsContent, {
            sourceType: "unambiguous",
            plugins: ["jsx", "typescript"],
            errorRecovery: true,
        });
    } catch {
        return hrefs;
    }
    traverse(ast, {
        ObjectProperty(path: any) {
            const { key, value } = path.node;
            if (key.name === "href") {
                const resolved = resolveString(value);
                if (resolved) hrefs.push(resolved);
            }
        },
    });
    return hrefs;
};

const next_parseLayoutJs = async (baseUrl: string, urls: string[], threads: number = 1) => {
    printMsg(MSG.Header, "[i] Parsing layout.js files");

    let toReturn: string[] = [];
    const MAX_LAYOUT_JS_BYTES = 1.5 * 1024 * 1024;

    const layoutUrls = urls.filter((url) => url.includes("layout-"));

    await runWithConcurrency(layoutUrls, threads, async (url) => {
        const req = await makeRequest(url);
        if (!req) return;

        const contentLength = req.headers.get("content-length");
        if (contentLength && parseInt(contentLength, 10) > MAX_LAYOUT_JS_BYTES) {
            printMsg(
                MSG.Warn,
                `[!] Skipping oversized layout.js (${Math.round(parseInt(contentLength, 10) / 1024)} KB): ${url}`
            );
            return;
        }

        const jsContent = await req.text();

        if (jsContent.length > MAX_LAYOUT_JS_BYTES) {
            printMsg(MSG.Warn, `[!] Skipping oversized layout.js (${Math.round(jsContent.length / 1024)} KB): ${url}`);
            return;
        }

        const hrefFinds = extractHrefsFromLayoutJs(jsContent);

        for (const href of hrefFinds) {
            const newUrl = new URL(href, new URL(url).origin).href;
            if (newUrl.startsWith("mailto:")) continue;
            if (new URL(baseUrl).origin !== new URL(newUrl).origin) continue;

            let hreqResult: Response | null;
            try {
                hreqResult = await makeRequest(newUrl);
            } catch {
                continue;
            }

            if (hreqResult && hreqResult.status === 200) {
                printMsg(MSG.Run, `[✓] Found new client side URL: ${newUrl}`);
                const jsFiles = await next_getJSScript(newUrl);
                toReturn.push(...jsFiles);
            }
        }
    });

    toReturn = [...new Set(toReturn)];

    if (toReturn.length !== 0) {
        printMsg(MSG.Run, `[✓] Found ${toReturn.length} JS files from the layout.js files`);
    }
    return toReturn;
};

export default next_parseLayoutJs;
