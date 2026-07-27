import fs from "fs";
import path from "path";
import lazyLoad from "../lazyLoad/index.js";
import run from "../run/index.js";
import * as globalsUtil from "../utility/globals.js";
import configureSandbox from "../utility/configureSandbox.js";
import { printMsg, MSG } from "../utility/printMsg.js";

export interface ToolResult {
    success: boolean;
    message: string;
    outputDir?: string;
}

/**
 * Builds a tree-style directory listing string for a given path (recursive, max depth).
 */
const buildDirTree = (dirPath: string, prefix: string = "", maxDepth: number = 3, currentDepth: number = 0): string => {
    if (currentDepth >= maxDepth || !fs.existsSync(dirPath)) return "";

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    let result = "";

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const isLast = i === entries.length - 1;
        const connector = isLast ? "└── " : "├── ";
        const childPrefix = isLast ? "    " : "│   ";
        const fullPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
            const childCount = fs.readdirSync(fullPath).length;
            result += `${prefix}${connector}${entry.name}/ (${childCount} items)\n`;
            result += buildDirTree(fullPath, prefix + childPrefix, maxDepth, currentDepth + 1);
        } else {
            const size = fs.statSync(fullPath).size;
            const sizeStr = size > 1024 ? `${(size / 1024).toFixed(1)}KB` : `${size}B`;
            result += `${prefix}${connector}${entry.name} (${sizeStr})\n`;
        }
    }
    return result;
};

/**
 * Runs the lazyload module against a target URL.
 */
export const runLazyload = async (
    url: string,
    outputDir: string = "output",
    threads: number = 1,
    sourcemapDir: string = "extracted"
): Promise<ToolResult> => {
    try {
        printMsg(MSG.Header, `\n[mcp] Running lazyload against ${url}...`);
        await lazyLoad(
            url,
            outputDir,
            false,
            [] as any,
            threads,
            false,
            "extracted_urls.json",
            false,
            false,
            sourcemapDir,
            false,
            "research.json",
            10
        );
        return { success: true, message: `Lazyload complete. Files saved to ${outputDir}/`, outputDir };
    } catch (err: any) {
        return { success: false, message: `Lazyload failed: ${err.message}` };
    }
};

/**
 * Runs the full pipeline (run module) against a target URL.
 */
export const runFullPipeline = async (
    url: string,
    outputDir: string = "output",
    threads: number = 1,
    sourcemapDir: string = "extracted"
): Promise<ToolResult> => {
    try {
        printMsg(MSG.Header, `\n[mcp] Running full pipeline against ${url}...`);

        const cmd = {
            url,
            output: outputDir,
            strictScope: false,
            scope: "*",
            threads: String(threads),
            apiGateway: false,
            apiGatewayConfig: ".api_gateway_config.json",
            cacheFile: ".resp_cache.json",
            disableCache: false,
            yes: false,
            secrets: false,
            ai: undefined,
            aiThreads: "5",
            aiProvider: "openai",
            aiEndpoint: undefined,
            aiApiKey: undefined,
            model: "gpt-4o-mini",
            mapOpenapiChunkTag: false,
            timeout: "30000",
            insecure: false,
            sandbox: true,
            sourcemapDir,
            research: false,
            researchOutput: "research.json",
            maxIterations: "10",
        };

        globalsUtil.setRequestTimeout(30000);
        configureSandbox(cmd);
        await run(cmd);
        return { success: true, message: `Full pipeline complete. Output in ${outputDir}/`, outputDir };
    } catch (err: any) {
        return { success: false, message: `Run failed: ${err.message}` };
    }
};

/**
 * Summarizes the output directory for lazyload — returns a directory tree overview.
 */
export const summarizeLazyloadOutput = (outputDir: string): string => {
    if (!fs.existsSync(outputDir)) {
        return `Output directory '${outputDir}' does not exist.`;
    }

    const tree = buildDirTree(outputDir, "", 4);
    const totalFiles = countFiles(outputDir);
    return `Directory structure of ${outputDir} (${totalFiles} total files):\n\n${tree}`;
};

/**
 * Reads and summarizes the output files from a run module execution.
 */
export const summarizeRunOutput = (workingDir: string = "."): string => {
    const summaryParts: string[] = [];

    // Check for common output files
    const filesToCheck = [
        { path: "endpoints.json", label: "Endpoints" },
        { path: "mapped.json", label: "Mapped Functions" },
        { path: "analyze.json", label: "Analysis Results" },
        { path: "strings.json", label: "Extracted Strings" },
        { path: "extracted_urls.json", label: "Extracted URLs" },
        { path: "mapped-openapi.json", label: "OpenAPI Spec" },
    ];

    for (const file of filesToCheck) {
        const filePath = path.join(workingDir, file.path);
        if (fs.existsSync(filePath)) {
            try {
                const content = fs.readFileSync(filePath, "utf-8");
                const parsed = JSON.parse(content);
                if (Array.isArray(parsed)) {
                    summaryParts.push(`**${file.label}** (${file.path}): ${parsed.length} items`);
                    // Show first few items as preview
                    if (parsed.length > 0) {
                        const preview = JSON.stringify(parsed.slice(0, 3), null, 2);
                        summaryParts.push(`  Preview (first 3):\n${preview}`);
                    }
                } else if (typeof parsed === "object") {
                    const keys = Object.keys(parsed);
                    summaryParts.push(`**${file.label}** (${file.path}): ${keys.length} top-level keys`);
                    summaryParts.push(`  Keys: ${keys.slice(0, 10).join(", ")}${keys.length > 10 ? "..." : ""}`);
                }
            } catch {
                const size = fs.statSync(filePath).size;
                summaryParts.push(`**${file.label}** (${file.path}): ${(size / 1024).toFixed(1)}KB`);
            }
        }
    }

    // Check for report files
    for (const ext of ["html", "md"]) {
        const reportPath = path.join(workingDir, `report.${ext}`);
        if (fs.existsSync(reportPath)) {
            const size = fs.statSync(reportPath).size;
            summaryParts.push(`**Report** (report.${ext}): ${(size / 1024).toFixed(1)}KB`);
        }
    }

    // Check output directory tree
    const outputDir = path.join(workingDir, "output");
    if (fs.existsSync(outputDir)) {
        const totalFiles = countFiles(outputDir);
        summaryParts.push(`\n**Downloaded Files** (output/): ${totalFiles} files`);
        summaryParts.push(buildDirTree(outputDir, "  ", 3));
    }

    if (summaryParts.length === 0) {
        return "No output files found. The run may not have completed yet.";
    }

    return summaryParts.join("\n\n");
};

const countFiles = (dirPath: string): number => {
    let count = 0;
    if (!fs.existsSync(dirPath)) return 0;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isDirectory()) {
            count += countFiles(path.join(dirPath, entry.name));
        } else {
            count++;
        }
    }
    return count;
};
