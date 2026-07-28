import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "path";
import lazyLoad from "../lazyLoad/index.js";
import strings from "../strings/index.js";
import map from "../map/index.js";
import endpoints from "../endpoints/index.js";
import analyze from "../analyze/index.js";
import report from "../report/index.js";
import run from "../run/index.js";
import * as globalsUtil from "../utility/globals.js";
import CONFIG from "../globalConfig.js";
import { loadSkills, findSkill, renderSkill, getSkillsDir } from "./skills.js";

/**
 * Redirects stdout writes to stderr for the duration of `fn`. Returns the captured text.
 *
 * MCP stdio transport owns stdout for JSON-RPC framing — any non-protocol byte written
 * to stdout corrupts the channel. js-recon subcommands log liberally via console.log,
 * so we capture those writes and return them as the tool result text.
 */
const captureStdout = async <T>(fn: () => Promise<T>): Promise<{ result: T; captured: string }> => {
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    let captured = "";

    process.stdout.write = ((chunk: any, ...args: any[]): boolean => {
        const text = typeof chunk === "string" ? chunk : (chunk?.toString?.() ?? "");
        captured += text;
        return process.stderr.write(text, ...(args as [any]));
    }) as typeof process.stdout.write;

    try {
        const result = await fn();
        return { result, captured };
    } finally {
        process.stdout.write = origStdoutWrite;
    }
};

const textResult = (text: string) => ({
    content: [{ type: "text" as const, text }],
});

export const startMcpServer = async (): Promise<void> => {
    const server = new McpServer({ name: "js-recon", version: CONFIG.version });

    // ---- lazyload ---------------------------------------------------------
    server.registerTool(
        "lazyload",
        {
            description:
                "Download JS chunks from a target URL via Puppeteer. Detects framework (Next.js, Vue, React, Svelte, Angular). Outputs files under <output>/<host>/.",
            inputSchema: {
                url: z.string().describe("Target URL or path to a file with one URL per line"),
                output: z.string().default("output").describe("Output directory"),
                threads: z.number().int().min(1).default(1),
                insecure: z.boolean().default(false).describe("Disable SSL cert verification"),
                yes: z.boolean().default(false).describe("Auto-approve executing JS code from the target"),
                lazyloadTimeoutMinutes: z.number().int().min(0).default(30),
            },
        },
        async (args) => {
            const { captured } = await captureStdout(async () => {
                globalsUtil.setYes(args.yes);
                globalsUtil.setRequestTimeout(30000);
                await lazyLoad(
                    args.url,
                    args.output,
                    false,
                    [] as any,
                    args.threads,
                    false,
                    "extracted_urls.json",
                    args.insecure,
                    false,
                    "extracted",
                    false,
                    "research.json",
                    10,
                    2,
                    args.lazyloadTimeoutMinutes * 60 * 1000
                );
            });
            return textResult(`${captured}\n\n[Output directory] ${path.resolve(args.output)}`);
        }
    );

    // ---- strings ---------------------------------------------------------
    server.registerTool(
        "strings",
        {
            description:
                "Scan downloaded JS files for strings, URL paths, and secrets. Produces strings.json and (optionally) extracted_urls.json.",
            inputSchema: {
                directory: z.string().describe("Directory containing downloaded JS"),
                output: z.string().default("strings.json"),
                extractUrls: z.boolean().default(true),
                extractedUrlPath: z.string().default("extracted_urls.json"),
                scanSecrets: z.boolean().default(false),
                permutate: z.boolean().default(false),
                openapi: z.boolean().default(false),
            },
        },
        async (args) => {
            const { captured } = await captureStdout(async () => {
                await strings(
                    args.directory,
                    args.output,
                    args.extractUrls,
                    args.extractedUrlPath,
                    args.scanSecrets,
                    args.permutate,
                    args.openapi
                );
            });
            return textResult(`${captured}\n\n[Outputs] ${path.resolve(args.output)}`);
        }
    );

    // ---- map ------------------------------------------------------------
    server.registerTool(
        "map",
        {
            description:
                "Parse webpack/turbopack/vite bundles into mapped.json. Resolves fetch/XHR/axios call sites to endpoints.",
            inputSchema: {
                directory: z.string().describe("Directory containing downloaded JS chunks"),
                output: z.string().default("mapped").describe("Output file name (without extension)"),
                formats: z.array(z.enum(["json", "openapi", "postman"])).default(["json"]),
                tech: z.enum(["next", "vue", "react", "svelte"]).describe("Target framework"),
            },
        },
        async (args) => {
            const { captured } = await captureStdout(async () => {
                await map(args.directory, args.output, args.formats as any, args.tech, false, false, []);
            });
            return textResult(`${captured}\n\n[Output] ${path.resolve(args.output + ".json")}`);
        }
    );

    // ---- endpoints ------------------------------------------------------
    server.registerTool(
        "endpoints",
        {
            description: "Extract client-side route paths (Next.js). Produces endpoints.json.",
            inputSchema: {
                directory: z.string().optional(),
                url: z.string().optional(),
                output: z.string().default("endpoints"),
                format: z.array(z.string()).default(["json"]),
                tech: z.string().default("next"),
                mappedJson: z.string().optional(),
            },
        },
        async (args) => {
            const { captured } = await captureStdout(async () => {
                await endpoints(args.url, args.directory, args.output, args.format, args.tech, false, args.mappedJson);
            });
            return textResult(`${captured}\n\n[Output] ${path.resolve(args.output + ".json")}`);
        }
    );

    // ---- analyze --------------------------------------------------------
    server.registerTool(
        "analyze",
        {
            description: "Run YAML rules against mapped.json / OpenAPI spec. Produces analyze.json.",
            inputSchema: {
                rulesPath: z.string().default(""),
                mappedJson: z.string().default("mapped.json"),
                tech: z.enum(["next", "vue", "react", "svelte"]),
                openapi: z.string().default(""),
                outputFile: z.string().default("analyze.json"),
            },
        },
        async (args) => {
            const { captured } = await captureStdout(async () => {
                await analyze(
                    args.rulesPath,
                    args.mappedJson,
                    args.tech,
                    false,
                    args.openapi,
                    false,
                    args.outputFile,
                    false,
                    false
                );
            });
            return textResult(`${captured}\n\n[Output] ${path.resolve(args.outputFile)}`);
        }
    );

    // ---- report ---------------------------------------------------------
    server.registerTool(
        "report",
        {
            description: "Populate the SQLite DB and generate an HTML report (report.html, js-recon.db).",
            inputSchema: {
                db: z.string().default("js-recon.db"),
                mappedJson: z.string().optional(),
                analyzeJson: z.string().optional(),
                endpointsJson: z.string().optional(),
                mappedOpenapiJson: z.string().optional(),
                reportFile: z.string().default("report.html"),
            },
        },
        async (args) => {
            const { captured } = await captureStdout(async () => {
                await report(
                    args.db,
                    args.mappedJson,
                    args.analyzeJson,
                    args.endpointsJson,
                    args.mappedOpenapiJson,
                    args.reportFile
                );
            });
            return textResult(`${captured}\n\n[Report] ${path.resolve(args.reportFile)}`);
        }
    );

    // ---- run (full pipeline) -------------------------------------------
    server.registerTool(
        "run",
        {
            description:
                "Primary interface. Runs the full pipeline (lazyload → strings → map → endpoints → analyze → report) against a target URL.",
            inputSchema: {
                url: z.string().describe("Target URL, or path to a file containing one URL per line"),
                output: z.string().default("output"),
                threads: z.number().int().min(1).default(1),
                insecure: z.boolean().default(false),
                yes: z.boolean().default(false),
                secrets: z.boolean().default(false),
                rules: z.string().optional(),
            },
        },
        async (args) => {
            const cmd: any = {
                url: args.url,
                output: args.output,
                strictScope: false,
                scope: "*",
                threads: String(args.threads),
                proxyConfig: ".proxy_config.json",
                ignoreProxyEnv: false,
                cacheFile: ".resp_cache.json",
                disableCache: false,
                yes: args.yes,
                secrets: args.secrets,
                ai: undefined,
                aiThreads: "5",
                aiProvider: "openai",
                aiEndpoint: undefined,
                aiApiKey: undefined,
                model: "gpt-4o-mini",
                mapOpenapiChunkTag: false,
                timeout: "30000",
                insecure: args.insecure,
                sandbox: true,
                sourcemapDir: "extracted",
                research: false,
                researchOutput: "research.json",
                maxIterations: "10",
                rules: args.rules || "",
            };
            const { captured } = await captureStdout(async () => {
                globalsUtil.setRequestTimeout(30000);
                await run(cmd);
            });
            return textResult(`${captured}\n\n[Output directory] ${path.resolve(args.output)}`);
        }
    );

    // ---- list_skills ----------------------------------------------------
    server.registerTool(
        "list_skills",
        {
            description:
                "List the js-recon skills available in this installation. Skills are workflow prompts shipped via the js-recon-rules release.",
            inputSchema: {},
        },
        async () => {
            const skills = loadSkills(true);
            if (skills.length === 0) {
                return textResult(`No skills found in ${getSkillsDir()}.`);
            }
            const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
            return textResult(lines.join("\n"));
        }
    );

    // ---- run_skill ------------------------------------------------------
    server.registerTool(
        "run_skill",
        {
            description:
                "Render a js-recon skill (workflow prompt) for a target. Returns the rendered prompt text; the caller agent should treat it as instructions to follow.",
            inputSchema: {
                name: z.string().describe("Skill name (see list_skills)"),
                params: z
                    .record(z.string())
                    .default({})
                    .describe("Parameter map for the skill (e.g. { target: 'https://example.com' })"),
            },
        },
        async (args) => {
            loadSkills(true);
            const skill = findSkill(args.name);
            if (!skill) {
                return textResult(`[!] Skill not found: ${args.name}`);
            }
            const rendered = renderSkill(skill, args.params || {});
            if (!rendered.ok) {
                return textResult(`[!] ${rendered.error}`);
            }
            return textResult(rendered.prompt!);
        }
    );

    const transport = new StdioServerTransport();
    await server.connect(transport);
    // Use stderr — stdout is owned by the transport.
    process.stderr.write(`[i] js-recon MCP server (v${CONFIG.version}) ready on stdio (cwd: ${process.cwd()})\n`);
};
