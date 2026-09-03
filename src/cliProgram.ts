import { Command, Argument } from "commander";
import chalk from "chalk";
import lazyLoad from "./lazyLoad/index.js";
import { FRAMEWORK_METHODS, VALID_METHODS } from "./lazyLoad/methodFilter.js";
import endpoints from "./endpoints/index.js";
import CONFIG from "./globalConfig.js";
import strings from "./strings/index.js";
import proxy from "./proxy/index.js";
import configureProxy from "./utility/configureProxy.js";
import map from "./map/index.js";
import * as globalsUtil from "./utility/globals.js";
import refactor from "./refactor/index.js";
import run from "./run/index.js";
import analyze from "./analyze/index.js";
import report from "./report/index.js";
import exploit, { printCveList } from "./exploit/index.js";
import configureSandbox from "./utility/configureSandbox.js";
import mcp from "./mcp/index.js";
import load from "./load/index.js";
import fingerprint from "./fingerprint/index.js";
import { applyHeapLimit } from "./utility/heap.js";
import csMast from "./cs_mast/index.js";
import sourcemaps from "./sourcemaps/index.js";
import completion from "./completion/index.js";
import { getLoadedApplicationConfig, prepareProgramConfiguration } from "./config/applicationConfig.js";
import {
    configureOxylabsFallback,
    getOxylabsFallbackConfiguration,
    OxylabsFallbackConfigurationError,
    resolveOxylabsFallback,
} from "./proxy/oxylabsFallback.js";
import { collectTargetInput, resolveTargetInputs, TargetInputError } from "./utility/targetInputs.js";
import { parseHeaderFlagValue, type CustomHeaderPair } from "./utility/customHeaders.js";
import { readHeaderFile, buildOriginAllowlist, HeaderFileError } from "./utility/headerFile.js";

/** Valid AI options for analysis modules */
const validAiOptions = ["description"];

/**
 * Validates a --max-heap value.
 * @param rawValue Raw value provided via CLI.
 */
function parseMaxHeapMb(rawValue: string | undefined): number {
    const parsed = parseInt(rawValue ?? "0", 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
        console.error(chalk.red(`[!] Invalid --max-heap value: ${rawValue}. Use 0 or a positive integer (MB).`));
        process.exit(1);
    }
    return parsed;
}

/**
 * Validates a timeout string and updates the global request timeout.
 * @param timeoutValue Timeout value provided via CLI.
 */
function validateAndSetTimeout(timeoutValue: string): void {
    const parsedTimeout = parseInt(timeoutValue, 10);
    if (Number.isNaN(parsedTimeout) || parsedTimeout < 1) {
        console.error(chalk.yellow(`[!] Invalid timeout value: "${timeoutValue}". Using default of 30000ms.`));
        globalsUtil.setRequestTimeout(30000);
    } else {
        globalsUtil.setRequestTimeout(parsedTimeout);
    }
}

/**
 * Parses `-H/--header` flag values into name/value pairs, exiting with an error on malformed input.
 * @param headerValues Raw `--header` values accumulated from the CLI (one per occurrence).
 */
function resolveCustomHeaders(headerValues: string[]): CustomHeaderPair[] {
    return headerValues.map((raw) => {
        const pair = parseHeaderFlagValue(raw);
        if (!pair) {
            console.error(chalk.red(`[!] Invalid --header value (expected "Name: Value"): ${raw}`));
            process.exit(1);
        }
        return pair;
    });
}

/**
 * Builds the fully-configured js-recon Commander program.
 *
 * Returns a fresh `Command` instance every call so this can be safely invoked more than once in
 * the same process (e.g. once for the real CLI entrypoint and again by the completion generator
 * for introspection) without "command already registered" collisions from reusing a singleton.
 */
export function buildProgram(): Command {
    const program = new Command();

    program
        .version(CONFIG.version)
        .description(CONFIG.toolDesc)
        .option(
            "--config <file>",
            "Application YAML config (default: ~/.config/js-recon/config.yaml; JS_RECON_CONFIG takes precedence)"
        );

    program.configureHelp({
        styleTitle: (str) => chalk.bold.cyan(str),
        styleCommandText: (str) => chalk.bold(str),
        styleCommandDescription: (str) => chalk.dim(str),
        styleDescriptionText: (str) => chalk.dim(str),
        styleOptionText: (str) => chalk.yellow(str),
        styleArgumentText: (str) => chalk.green(str),
        styleSubcommandText: (str) => chalk.cyan(str),
        styleOptionTerm: (str) => {
            // Color flags yellow, <required> args magenta, [optional] args cyan
            return str
                .split(" ")
                .map((word) => {
                    if (word.startsWith("<") && word.endsWith(">")) return chalk.magenta(word);
                    if (word.startsWith("[") && word.endsWith("]")) return chalk.cyan(word);
                    return chalk.yellow(word);
                })
                .join(" ");
        },
        styleOptionDescription: (str) => str.replace(/(\(default:[^)]*\))/g, chalk.dim.italic("$1")),
    });

    program
        .command("lazyload")
        .description("Run lazy load module")
        .option(
            "-u, --url <url/list/file>",
            "Target URL, comma-separated URLs, or target file; may be repeated",
            collectTargetInput
        )
        .option("-o, --output <directory>", "Output directory", "output")
        .option("--strict-scope", "Download JS files from only the input URL domain", false)
        .option("-s, --scope <scope>", "Download JS files from specific domains (comma-separated)", "*")
        .option("-t, --threads <threads>", "Number of threads to use", "1")
        .option("--subsequent-requests", "Download JS files from subsequent requests (Next.JS only)", false)
        .option("--urls-file <file>", "Input JSON file containing URLs", "extracted_urls.json")
        .option("--proxy-config <file>", "Proxy config file (generated via the `proxy` module)", ".proxy_config.json")
        .option("--ignore-proxy-env", "Skip JS_RECON_* proxy environment variables during resolution", false)
        .option(
            "--oxylabs-waf-fallback",
            "Retry strongly identified CDN/WAF blocks through configured Oxylabs; direct requests remain the default",
            false
        )
        .option("--oxylabs-fallback-max-requests <count>", "Maximum paid Oxylabs fallback requests per origin", "10")
        .option("--oxylabs-fallback-max-total <count>", "Maximum paid Oxylabs fallback requests per run", "100")
        .option("--oxylabs-fallback-max-origins <count>", "Maximum distinct fallback origins per run", "25")
        .option("--cache-file <file>", "File to store response cache", ".resp_cache.db")
        .option("--disable-cache", "Disable response caching", false)
        .option("--cache-only", "Only use the response cache; never make network requests", false)
        .option("-y, --yes", "Auto-approve executing JS code from the target", false)
        .option(
            "-H, --header <name: value>",
            "Custom header to send with every request, as 'Name: Value'. Can be passed multiple times.",
            (val: string, prev: string[]) => [...prev, val],
            [] as string[]
        )
        .option("--timeout <timeout>", "Request timeout in ms", "30000")
        .option("-k, --insecure", "Disable SSL certificate verification", false)
        .option("--no-sandbox", "Disable browser sandbox")
        .option("--build-id", "Get the buildId from the Next.js app", false)
        .option("--sourcemap-dir <directory>", "Directory to write source maps", "extracted")
        .option("--research", "Enable research mode", false)
        .option("--research-output <file>", "Output file for research mode", "research.json")
        .option("--max-iterations <iterations>", "Maximum number of recursive crawl iterations", "10")
        .option("--max-js-size <mb>", "Maximum JS file size in MB to parse (Vue only)", "2")
        .option(
            "--lazyload-timeout <minutes>",
            "Hard timeout for the lazyload module in minutes (0 = no timeout)",
            "30"
        )
        .option(
            "--detection-timeout <seconds>",
            "Timeout for front-end framework detection in seconds (0 = no timeout)",
            "30"
        )
        .option("--max-pages <pages>", "Maximum HTML pages to visit during Next.js crawl (0 = unlimited)", "200")
        .option(
            "--rsc-param-bruteforce-limit <n>",
            "Max harvested dynamic-route param-name candidates to try per URL in next_routerStateForge's RSC-body keyword fallback (0 = disable the fallback)",
            "20"
        )
        .option(
            "--wordlist <file>",
            "Newline-separated file of path segments/prefixes (e.g. 'admin'); each entry is added as <origin>/<entry> to next_routerStateForge's candidate URLs"
        )
        .option("--verbose", "Show detailed file write error messages", false)
        .option(
            "--max-redirects <n>",
            "Maximum redirects to follow when resolving the default crawl scope for generic tech",
            "20"
        )
        .option(
            "--strings",
            "Enable strings-based recursive JS discovery for generic tech (scans downloaded files for string-literal JS paths)",
            false
        )
        .option(
            "--strings-max-iterations <n>",
            "Maximum recursive strings-discovery passes for generic tech (0 = unlimited, loops until no new files)",
            "5"
        )
        .option(
            "--stagnation-timein <mins>",
            "Minutes to wait before generic-tech content stagnation detection begins monitoring (0 = disabled)",
            "30"
        )
        .option(
            "--stagnation-percentage <percent>",
            "Percentage of discovered generic-tech JS files sharing identical content required to flag stagnation",
            "80"
        )
        .option(
            "--stagnation-monitor <mins>",
            "Interval in minutes between generic-tech stagnation re-checks once armed",
            "1"
        )
        .option(
            "--include-methods <methods>",
            "Comma-separated method names to run (whitelist). Use --list-methods to see valid names."
        )
        .option(
            "--exclude-methods <methods>",
            "Comma-separated method names to skip (blacklist). Use --list-methods to see valid names."
        )
        .option(
            "--list-methods [framework]",
            "Print available method names grouped by framework and exit. Optionally filter by framework (next_js, vue, nuxt_js, svelte, angular, react)."
        )
        .action(async (cmd) => {
            // handle --list-methods before any network work
            if (cmd.listMethods !== undefined) {
                const filter = typeof cmd.listMethods === "string" ? cmd.listMethods : null;
                const frameworkKeys = Object.keys(FRAMEWORK_METHODS);
                if (filter && !frameworkKeys.includes(filter)) {
                    console.error(
                        chalk.red(`[!] Unknown framework: "${filter}". Valid frameworks: ${frameworkKeys.join(", ")}`)
                    );
                    process.exit(1);
                }
                const keys = filter ? [filter] : frameworkKeys;
                for (const fw of keys) {
                    console.log(chalk.cyan(`\n[${fw}]`));
                    for (const method of FRAMEWORK_METHODS[fw]) {
                        console.log(chalk.green(`  - ${method}`));
                    }
                }
                process.exit(0);
            }

            // parse and validate method filter lists
            const includeMethods: string[] = cmd.includeMethods
                ? cmd.includeMethods
                      .split(",")
                      .map((m: string) => m.trim())
                      .filter(Boolean)
                : [];
            const excludeMethods: string[] = cmd.excludeMethods
                ? cmd.excludeMethods
                      .split(",")
                      .map((m: string) => m.trim())
                      .filter(Boolean)
                : [];

            const allMethods = [...includeMethods, ...excludeMethods];
            const invalid = allMethods.filter((m) => !VALID_METHODS.includes(m));
            if (invalid.length > 0) {
                console.error(chalk.red(`[!] Invalid method name(s): ${invalid.join(", ")}`));
                console.error(chalk.yellow(`[i] Valid methods: ${VALID_METHODS.join(", ")}`));
                process.exit(22);
            }

            if (!cmd.url || (Array.isArray(cmd.url) && cmd.url.length === 0)) {
                console.error(chalk.red("[!] Missing required option: -u, --url <url/list/file>"));
                process.exit(1);
            }

            const lazyloadTimeoutMin = Number(cmd.lazyloadTimeout);
            const stagnationTimeinMin = Number(cmd.stagnationTimein);
            if (lazyloadTimeoutMin > 0 && stagnationTimeinMin > lazyloadTimeoutMin) {
                console.error(
                    chalk.red(
                        `[!] --stagnation-timein (${stagnationTimeinMin}m) cannot exceed --lazyload-timeout (${lazyloadTimeoutMin}m)`
                    )
                );
                process.exit(30);
            }

            configureProxy(cmd);
            if (getOxylabsFallbackConfiguration().enabled) globalsUtil.setUseProxy(false);
            globalsUtil.setDisableCache(cmd.disableCache);
            globalsUtil.setRespCacheFile(cmd.cacheFile);
            globalsUtil.setCacheOnly(cmd.cacheOnly);
            globalsUtil.setYes(cmd.yes);
            globalsUtil.setVerbose(cmd.verbose);
            globalsUtil.setCustomHeaders(resolveCustomHeaders(cmd.header));
            validateAndSetTimeout(cmd.timeout);

            configureSandbox(cmd);

            await lazyLoad(
                cmd.url,
                cmd.output,
                cmd.strictScope,
                cmd.scope.split(","),
                Number(cmd.threads),
                cmd.subsequentRequests,
                cmd.urlsFile,
                cmd.insecure,
                cmd.buildId,
                cmd.sourcemapDir,
                cmd.research,
                cmd.researchOutput,
                Number(cmd.maxIterations),
                Number(cmd.maxJsSize),
                Number(cmd.lazyloadTimeout) * 60 * 1000,
                Number(cmd.maxPages),
                includeMethods,
                excludeMethods,
                Number(cmd.detectionTimeout) * 1000,
                undefined,
                false,
                Number(cmd.maxRedirects),
                cmd.strings,
                Number(cmd.stringsMaxIterations),
                Number(cmd.stagnationTimein) * 60 * 1000,
                Number(cmd.stagnationPercentage),
                Number(cmd.stagnationMonitor) * 60 * 1000,
                Number(cmd.rscParamBruteforceLimit),
                cmd.wordlist
            );
        });

    program
        .command("endpoints")
        .description("Extract client-side endpoints")
        .option("-u, --url <url>", "Target Base URL (will be used to resolve relative paths)")
        .option("-d, --directory <directory>", "Directory containing JS files")
        .option("-o, --output <filename>", "Output filename (without file extension)", "endpoints")
        .option("--output-format <format>", "Output format for the results comma-separated (available: json)", "json")
        .option("-t, --tech <tech>", "Technology used in the JS files (run with -l/--list to see available options)")
        .option("-l, --list", "List available technologies", false)
        .option("--mapped-json <file>", "Mapped JSON file (for Next.JS)")
        .action(async (cmd) => {
            await endpoints(
                cmd.url,
                cmd.directory,
                cmd.output,
                cmd.outputFormat.split(","),
                cmd.tech,
                cmd.list,
                cmd.mappedJson
            );
        });

    program
        .command("strings")
        .description("Extract strings from JS files")
        .requiredOption("-d, --directory <directory>", "Directory containing JS files")
        .option("-o, --output <file>", "JSON file to save the strings", "strings.json")
        .option("-e, --extract-urls", "Extract URLs from strings", false)
        .option(
            "--extracted-url-path <file>",
            "Output file for extracted URLs and paths (without extension)",
            "extracted_urls"
        )
        .option("-p, --permutate", "Permutate URLs and paths found", false)
        .option("--openapi", "Generate OpenAPI specification from the paths found", false)
        .option("-s, --scan-secrets", "Scan for secrets", false)
        .option("--trufflehog", "Run TruffleHog secret scanner on the output directory", false)
        .option("--trufflehog-bin <path>", "Path to the trufflehog binary (skips auto-download)", "trufflehog")
        .option(
            "--trufflehog-accept-terms",
            "Accept TruffleHog's AGPL-3.0 license terms non-interactively so it can be auto-downloaded (required in non-TTY/CI contexts on first use)",
            false
        )
        .action(async (cmd) => {
            await strings(
                cmd.directory,
                cmd.output,
                cmd.extractUrls,
                cmd.extractedUrlPath,
                cmd.scanSecrets,
                cmd.permutate,
                cmd.openapi,
                cmd.trufflehog,
                cmd.trufflehogBin,
                cmd.trufflehogAcceptTerms
            );
        });

    program
        .command("proxy")
        .description("Manage proxy configuration (AWS API Gateway IP rotation, SOCKS/HTTP, Oxylabs)")
        .option("-i, --init", "Initialize the config file (create API) [aws method]", false)
        .option("-d, --destroy <id>", "Destroy API with the given ID [aws method]")
        .option("--destroy-all", "Destroy all the API created by this tool in all regions [aws method]", false)
        .option("-r, --region <region>", "AWS region (default: random region) [aws method]")
        .option(
            "--aws-access-key <key>",
            "AWS access key (if not provided, AWS_ACCESS_KEY_ID environment variable will be used) [aws method]"
        )
        .option(
            "--aws-secret-key <key>",
            "AWS secret key (if not provided, AWS_SECRET_ACCESS_KEY environment variable will be used) [aws method]"
        )
        .option("-c, --config <config>", "Name of the config file", ".proxy_config.json")
        .option("-l, --list", "List all the API created by this tool [aws method]", false)
        .option(
            "--feasibility",
            "Check whether a firewall/WAF blocks the target directly and, if so, whether the proxy method (--proxy-method, or the one already configured via -i/--init) bypasses it",
            false
        )
        .option("--feasibility-url <url>", "URL to check feasibility of")
        .option(
            "--proxy-method <method>",
            "Proxy method to configure with -i/--init: aws, socks, http, or oxylabs (omit for an interactive prompt)"
        )
        .option(
            "--proxy <url>",
            "SOCKS5/HTTP proxy URL for -i/--init (socks5://[user:pass@]host:port or http://[user:pass@]host:port)"
        )
        .option("--oxylabs-username <username>", "Oxylabs datacenter proxy username for -i/--init")
        .option("--oxylabs-password <password>", "Oxylabs datacenter proxy password for -i/--init")
        .option("--oxylabs-country <country>", "Oxylabs datacenter proxy country code for -i/--init")
        .option(
            "--oxylabs-city <city>",
            "Oxylabs datacenter proxy city for -i/--init (currently unsupported — no documented username-level city targeting)"
        )
        .option(
            "--oxylabs-session-id <id>",
            "Oxylabs datacenter proxy sticky session id for -i/--init (currently unsupported via username — sessions are selected by port)"
        )
        .action(async (cmd) => {
            try {
                await proxy({
                    init: cmd.init,
                    destroy: cmd.destroy,
                    destroyAll: cmd.destroyAll,
                    list: cmd.list,
                    region: cmd.region,
                    awsAccessKey: cmd.awsAccessKey,
                    awsSecretKey: cmd.awsSecretKey,
                    config: cmd.config,
                    feasibility: cmd.feasibility,
                    feasibilityUrl: cmd.feasibilityUrl,
                    proxyMethod: cmd.proxyMethod,
                    proxyUrl: cmd.proxy,
                    oxylabsUsername: cmd.oxylabsUsername,
                    oxylabsPassword: cmd.oxylabsPassword,
                    oxylabsCountry: cmd.oxylabsCountry,
                    oxylabsCity: cmd.oxylabsCity,
                    oxylabsSessionId: cmd.oxylabsSessionId,
                });
            } catch (err) {
                console.error(chalk.red(`[!] ${err.message}`));
                process.exit(1);
            }
        });

    program
        .command("map")
        .description("Map all the functions")
        .option("-d, --directory <directory>", "Directory containing JS files")
        .option("-t, --tech <tech>", "Technology used in the JS files (run with -l/--list to see available options)")
        .option("-l, --list", "List available technologies", false)
        .option("-o, --output <file>", "Output file name (without extension)", "mapped")
        .option("-f, --format <format>", "Output format for the results comma-separated (available: JSON)", "json")
        .option("-i, --interactive", "Interactive mode", false)
        .option(
            "-c, --command <command>",
            "Run an interactive-mode command non-interactively. Can be passed multiple times, or chain several with `&&` inside a single value (e.g. -c 'list fetch && go to 1234'), to run several commands in sequence.",
            (val: string, prev: string[]) => [...prev, ...val.split(/\s*&&\s*/).filter((c) => c.length > 0)],
            [] as string[]
        )
        .option("--ai <options>", "Use AI to analyze the code (comma-separated; available: description)")
        .option("--ai-threads <threads>", "Number of threads to use for AI", "5")
        .option(
            "--ai-provider <provider>",
            "Service provider to use for AI (available: openai, ollama, anthropic)",
            "openai"
        )
        .option("--ai-endpoint <endpoint>", "Endpoint to use for AI service (for Ollama, etc)")
        .option("--ai-api-key <key>", "API key for the configured AI provider")
        .option("--model <model>", "AI model to use", "gpt-4o-mini")
        .option("--openapi", "Generate OpenAPI spec from the code", false)
        .option("--openapi-output <file>", "Output file for OpenAPI spec", "mapped-openapi.json")
        .option("--openapi-chunk-tag", "Add chunk ID tag to OpenAPI spec for each request found", false)
        .option("--no-graphql", "Disable GraphQL operation extraction during OpenAPI generation")
        .option("--ngql", "Alias for --no-graphql")
        .option(
            "--max-recursion-depth <n>",
            "Max recursion depth for HTTP-client URL fan-out and cross-file resolution (default 3)",
            "3"
        )
        .option("--max-heap <mb>", "V8 heap size cap in MB (0 = all available RAM)")
        .action(async (cmd) => {
            if (cmd.maxHeap !== undefined) applyHeapLimit(parseMaxHeapMb(cmd.maxHeap));
            globalsUtil.setAi(cmd.ai?.split(",") || []);
            globalsUtil.setAiServiceProvider(cmd.aiProvider);
            globalsUtil.setOpenapiChunkTag(cmd.openapiChunkTag);
            globalsUtil.setAiApiKey(cmd.aiApiKey);
            globalsUtil.setAiModel(cmd.model);
            if (cmd.aiEndpoint) globalsUtil.setAiEndpoint(cmd.aiEndpoint);
            globalsUtil.setAiThreads(cmd.aiThreads);
            globalsUtil.setOpenapi(cmd.openapi);
            globalsUtil.setOpenapiOutputFile(cmd.openapiOutput);
            // Commander's --no-graphql flips cmd.graphql to false; --ngql is an alias.
            globalsUtil.setGraphqlEnabled(cmd.graphql !== false && !cmd.ngql);

            // validate AI options
            if (globalsUtil.getAi().length !== 0) {
                for (const aiType of globalsUtil.getAi()) {
                    if (aiType !== "" && !validAiOptions.includes(aiType)) {
                        console.error(chalk.red(`[!] Invalid AI option: ${aiType}`));
                        process.exit(1);
                    }
                }
            }
            const maxRecursionDepth = parseInt(cmd.maxRecursionDepth ?? "3", 10);
            if (!Number.isFinite(maxRecursionDepth) || maxRecursionDepth < 0) {
                console.error(chalk.red(`[!] Invalid --max-recursion-depth: ${cmd.maxRecursionDepth}`));
                process.exit(1);
            }
            globalsUtil.setMaxRecursionDepth(maxRecursionDepth);
            await map(
                cmd.directory,
                cmd.output,
                cmd.format.split(","),
                cmd.tech,
                cmd.list,
                cmd.interactive,
                cmd.command || []
            );
        });

    program
        .command("refactor")
        .description("Refactor the code")
        .option("-m, --mapped-json <file>", "Mapped JSON file", "mapped.json")
        .option("-o, --output <directory>", "Output directory", "output_refactored")
        .option("-t, --tech <tech>", "Technology used in the JS files (run with -l/--list to see available options)")
        .option("-l, --list", "List available technologies", false)
        .option(
            "--collisions <file>",
            "Local path to a CS-MAST collisions.json (or directory). Overrides the default remote HuggingFace signatures."
        )
        .option(
            "--sq, --signature-quality <number>",
            "Minimum signature quality threshold (0–100). A signature is used only when (count/sample_size)*100 >= threshold.",
            "100"
        )
        .option("--refresh-cache", "Force refresh the remote file list cache", false)
        .option("--skip-cache-checks", "Skip cache age and 404-triggered refresh checks", false)
        .option(
            "--no-remote",
            "Disable remote HuggingFace signature fetch; run without library stripping unless --collisions is provided"
        )
        .option(
            "--remote-collisions <path>",
            "HuggingFace dataset path to load collision signatures from (e.g. react/vite/large-0.1.8). Overrides the automatic tech-to-branch mapping. Exits with code 25 if the path does not exist."
        )
        .option(
            "--scat <categories>",
            "Override the CS-MAST scat categories used for library signature matching. Comma-separated list of: lit,id,op,decl,loop,cond,name,val,op_name (e.g. --scat lit,decl,cond). Overrides the default lit-decl-loop-cond config."
        )
        .option(
            "--detect-version",
            "Detect the React version used in the bundle and use it in the refactored output's package.json (react-webpack and react-vite only).",
            false
        )
        .option(
            "--detect-version-config <config>",
            'Scat configuration for version detection. Use "dynamic" (default) to auto-select reliable configs, or pass comma-separated scat categories for a fixed config (e.g. lit,decl,loop,cond). Exits with code 26 if the static config has empty signatures for any known React version.'
        )
        .option(
            "--detect-version-dynamic-threshold <n>",
            "Number of scat configs to select in dynamic version detection mode (default: 3). Must be a positive integer.",
            "3"
        )
        .option(
            "--detect-version-dynamic-conf-purge",
            "Purge the cached dynamic scat config selection (stored in ~/.js-recon/refactor/config.json) and recompute it on this run.",
            false
        )
        .action(async (cmd) => {
            const scat: string[] | undefined = cmd.scat
                ? (cmd.scat as string)
                      .split(",")
                      .map((s: string) => s.trim())
                      .filter(Boolean)
                : undefined;
            const detectVersionDynamicThreshold = Number(cmd.detectVersionDynamicThreshold ?? 3);
            if (!Number.isInteger(detectVersionDynamicThreshold) || detectVersionDynamicThreshold < 1) {
                console.error(
                    `[!] --detect-version-dynamic-threshold must be a positive integer (got "${cmd.detectVersionDynamicThreshold}")`
                );
                process.exit(1);
            }
            await refactor(cmd.mappedJson, cmd.output, cmd.tech, cmd.list, cmd.collisions, {
                signatureQuality: Number(cmd.signatureQuality ?? 100),
                refreshCache: !!cmd.refreshCache,
                skipCacheChecks: !!cmd.skipCacheChecks,
                noRemote: cmd.remote === false,
                remoteCollisions: cmd.remoteCollisions as string | undefined,
                scat,
                detectVersion: !!cmd.detectVersion,
                detectVersionConfig: cmd.detectVersionConfig as string | undefined,
                detectVersionDynamicThreshold,
                detectVersionDynamicConfPurge: !!cmd.detectVersionDynamicConfPurge,
            });
        });

    program
        .command("analyze")
        .description("Analyze the code")
        .option("-r, --rules <file/dir>", "Rules file or directory")
        .option("-m, --mapped-json <file>", "Mapped JSON file", "mapped.json")
        .option("-t, --tech <tech>", "Technology used in the JS files (run with -l/--list to see available options)")
        .option("--openapi <file>", "Path to OpenAPI spec file")
        .option("-l, --list", "List available technologies", false)
        .option("--validate", "Validate the rules", false)
        .option("-o, --output <file>", "Output JSON file name", "analyze.json")
        .option(
            "--disable-rules-version-check",
            "Skip the GitHub rules version check and use cached rules as-is",
            false
        )
        .option(
            "--determine-compatible-version",
            "Report the js_recon_version/js_recon_max_version each rule actually requires, based on the features it uses",
            false
        )
        .option(
            "--apply-compatible-versions",
            "Same as --determine-compatible-version, but rewrites the rule files in place",
            false
        )
        .action(async (cmd) => {
            await analyze(
                cmd.rules,
                cmd.mappedJson,
                cmd.tech,
                cmd.list,
                cmd.openapi,
                cmd.validate,
                cmd.output,
                !!cmd.disableRulesVersionCheck,
                cmd.determineCompatibleVersion,
                cmd.applyCompatibleVersions
            );
        });

    program
        .command("exploit")
        .description("Attempt exploitation of known framework CVEs to discover new attack surface")
        .option("-u, --url <url>", "Target URL")
        .option("--cve <id>", "CVE ID to exploit (e.g. CVE-2025-29927)")
        .option("--list-cve", "List all supported CVEs grouped by framework and exit", false)
        .option("--exec-cmd <cmd>", "Command to execute for RCE-class CVE proof (read-only recommended)", "id")
        .option("-o, --output <file>", "Output JSON file for exploit findings", "exploit.json")
        .option(
            "--engine-output <file>",
            "Output JSON file in report-compatible EngineOutput format",
            "exploit-engine.json"
        )
        .option("--proxy-config <file>", "Proxy config file (generated via the `proxy` module)", ".proxy_config.json")
        .option("--ignore-proxy-env", "Skip JS_RECON_* proxy environment variables during resolution", false)
        .option(
            "-H, --header <name: value>",
            "Custom header to send with every request, as 'Name: Value'. Can be passed multiple times.",
            (val: string, prev: string[]) => [...prev, val],
            [] as string[]
        )
        .option("--timeout <timeout>", "Request timeout in ms", "30000")
        .option("-k, --insecure", "Disable SSL certificate verification", false)
        .action(async (cmd) => {
            if (cmd.listCve) {
                printCveList();
                process.exit(0);
            }

            if (!cmd.cve) {
                console.error(chalk.red("[!] Missing required option: --cve <id> (or use --list-cve)"));
                process.exit(1);
            }

            if (!cmd.url) {
                console.error(chalk.red("[!] Missing required option: -u, --url <url>"));
                process.exit(1);
            }

            configureProxy(cmd);
            validateAndSetTimeout(cmd.timeout);
            globalsUtil.setCustomHeaders(resolveCustomHeaders(cmd.header));
            if (cmd.insecure) {
                globalsUtil.setInsecure(true);
                process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // lgtm[js/disabling-certificate-validation]: opt-in via -k/--insecure, same as lazyload/run
                console.warn(chalk.yellow("[!] Running in insecure mode. SSL certificate verification disabled"));
            }

            await exploit(cmd.url, cmd.cve, {
                execCmd: cmd.execCmd,
                output: cmd.output,
                engineOutput: cmd.engineOutput,
                timeout: Number(cmd.timeout),
                insecure: !!cmd.insecure,
            });
        });

    program
        .command("report")
        .description("Generate a report")
        .option("-s, --sqlite-db <file>", "SQLite database file", "js-recon.db")
        .option("-m, --mapped-json <file>", "Mapped JSON file")
        .option("-a, --analyze-json <file>", "Analyze JSON file")
        .option("-e, --endpoints-json <file>", "Endpoints JSON file")
        .option("--map-openapi, --mapped-openapi-json <file>", "Mapped OpenAPI JSON file")
        .option(
            "--exploit-json <file>",
            "Exploit findings JSON file, in EngineOutput format (see `exploit --engine-output`)"
        )
        .option("-o, --output <file>", "Output file name (without the extension)", "report")
        .option("--sj", "Run sj (swagger-jacker) against the mapped OpenAPI spec", false)
        .option("--sj-bin <path>", "Path to the sj binary", "sj")
        .option("--sj-args <args>", "Extra arguments passed through to `sj automate`", "")
        .action(async (cmd) => {
            await report(
                cmd.sqliteDb,
                cmd.mappedJson,
                cmd.analyzeJson,
                cmd.endpointsJson,
                cmd.mappedOpenapiJson,
                cmd.output,
                cmd.sj,
                cmd.sjBin,
                cmd.sjArgs,
                cmd.exploitJson
            );
        });

    program
        .command("run")
        .description("Run all modules")
        .option(
            "-u, --url <url/list/file>",
            "Target URL, comma-separated URLs, or target file; may be repeated",
            collectTargetInput
        )
        .option("-r, --rules <file/dir>", "Rules file or directory (passed to analyze module)")
        .option(
            "--disable-rules-version-check",
            "Skip the GitHub rules version check and use cached rules as-is (passed to analyze module)",
            false
        )
        .option(
            "-c, --command <command>",
            "Run an interactive-mode command on the mapped chunks non-interactively (forwarded to the map step). Can be passed multiple times, or chain several with `&&` inside a single value (e.g. -c 'list fetch && go to 1234').",
            (val: string, prev: string[]) => [...prev, ...val.split(/\s*&&\s*/).filter((c) => c.length > 0)],
            [] as string[]
        )
        .option("-o, --output <directory>", "Output directory", "output")
        .option(
            "--output-overwrite",
            "Replace an occupied js-recon-owned output instead of selecting output-2, output-3, etc. Can also be set via JS_RECON_OUTPUT_OVERWRITE=true.",
            false
        )
        .option("--strict-scope", "Download JS files from only the input URL domain", false)
        .option("-s, --scope <scope>", "Download JS files from specific domains (comma-separated)", "*")
        .option("-t, --threads <threads>", "Number of threads to use", "1")
        .option("--proxy-config <file>", "Proxy config file (generated via the `proxy` module)", ".proxy_config.json")
        .option("--ignore-proxy-env", "Skip JS_RECON_* proxy environment variables during resolution", false)
        .option(
            "--proxy-waf-fallback",
            "Before each target, check whether the configured proxy is needed and can bypass a WAF/firewall (reuses the `proxy --feasibility` logic); skip the target if the proxy can't bypass it",
            false
        )
        .option(
            "--oxylabs-waf-fallback",
            "Retry strongly identified CDN/WAF blocks through configured Oxylabs; direct requests remain the default",
            false
        )
        .option("--oxylabs-fallback-max-requests <count>", "Maximum paid Oxylabs fallback requests per origin", "10")
        .option("--oxylabs-fallback-max-total <count>", "Maximum paid Oxylabs fallback requests per run", "100")
        .option("--oxylabs-fallback-max-origins <count>", "Maximum distinct fallback origins per run", "25")
        .option("--cache-file <file>", "File to store response cache", ".resp_cache.db")
        .option("--disable-cache", "Disable response caching", false)
        .option("--cache-only", "Only use the response cache; never make network requests", false)
        .option("-y, --yes", "Auto-approve executing JS code from the target", false)
        .option(
            "-H, --header <name: value>",
            "Custom header to send with every request, as 'Name: Value'. Can be passed multiple times.",
            (val: string, prev: string[]) => [...prev, val],
            [] as string[]
        )
        .option(
            "--header-file <path>",
            "Owner-only, non-symlink file of newline-separated 'Name: value' private headers (1-16 entries). Sent only to the exact origin(s) explicitly supplied via -u, never to third-party subresources, redirects off-origin, or any proxy/AI/MCP call. No environment-variable alternative."
        )
        .option("--secrets", "Scan for secrets", false)
        .option("--trufflehog", "Run TruffleHog secret scanner on the output directory", false)
        .option("--trufflehog-bin <path>", "Path to the trufflehog binary (skips auto-download)", "trufflehog")
        .option(
            "--trufflehog-accept-terms",
            "Accept TruffleHog's AGPL-3.0 license terms non-interactively so it can be auto-downloaded (required in non-TTY/CI contexts on first use)",
            false
        )
        .option("--sj", "Run sj (swagger-jacker) against the mapped OpenAPI spec", false)
        .option("--sj-bin <path>", "Path to the sj binary", "sj")
        .option("--sj-args <args>", "Extra arguments passed through to `sj automate`", "")
        .option("--ai <options>", "Use AI to analyze the code (comma-separated; available: description)")
        .option("--ai-threads <threads>", "Number of threads to use for AI", "5")
        .option(
            "--ai-provider <provider>",
            "Service provider to use for AI (available: openai, ollama, anthropic)",
            "openai"
        )
        .option("--ai-endpoint <endpoint>", "Endpoint to use for AI service (for Ollama, etc)")
        .option("--ai-api-key <key>", "API key for the configured AI provider")
        .option("--model <model>", "AI model to use", "gpt-4o-mini")
        .option(
            "--map-openapi-chunk-tag",
            "Add chunk ID tag to OpenAPI spec for each request found (map module)",
            false
        )
        .option("--no-graphql", "Disable GraphQL operation extraction during OpenAPI generation")
        .option("--ngql", "Alias for --no-graphql")
        .option("--timeout <timeout>", "Request timeout in ms", "30000")
        .option("-k, --insecure", "Disable SSL certificate verification", false)
        .option("--no-sandbox", "Disable browser sandbox")
        .option("--sourcemap-dir <directory>", "Directory to write source maps", "extracted")
        .option("--research", "Enable research mode", false)
        .option("--research-output <file>", "Output file for research mode", "research.json")
        .option("--max-iterations <iterations>", "Maximum number of recursive crawl iterations", "10")
        .option("--max-js-size <mb>", "Maximum JS file size in MB to parse (Vue only)", "2")
        .option("--lazyload-timeout <minutes>", "Hard timeout for each lazyload step in minutes (0 = no timeout)", "30")
        .option(
            "--detection-timeout <seconds>",
            "Timeout for front-end framework detection in seconds (0 = no timeout)",
            "30"
        )
        .option("--max-heap <mb>", "V8 heap size cap in MB (0 = all available RAM)")
        .option("--max-pages <pages>", "Maximum HTML pages to visit during Next.js crawl (0 = unlimited)", "200")
        .option(
            "--rsc-param-bruteforce-limit <n>",
            "Max harvested dynamic-route param-name candidates to try per URL in next_routerStateForge's RSC-body keyword fallback (0 = disable the fallback)",
            "20"
        )
        .option(
            "--wordlist <file>",
            "Newline-separated file of path segments/prefixes (e.g. 'admin'); each entry is added as <origin>/<entry> to next_routerStateForge's candidate URLs"
        )
        .option("--verbose", "Show detailed file write error messages", false)
        .option(
            "--max-redirects <n>",
            "Maximum redirects to follow when resolving the default crawl scope for generic tech",
            "20"
        )
        .option(
            "--strings",
            "Enable strings-based recursive JS discovery for generic tech (scans downloaded files for string-literal JS paths)",
            false
        )
        .option(
            "--strings-max-iterations <n>",
            "Maximum recursive strings-discovery passes for generic tech (0 = unlimited, loops until no new files)",
            "5"
        )
        .option(
            "--stagnation-timein <mins>",
            "Minutes to wait before generic-tech content stagnation detection begins monitoring (0 = disabled)",
            "30"
        )
        .option(
            "--stagnation-percentage <percent>",
            "Percentage of discovered generic-tech JS files sharing identical content required to flag stagnation",
            "80"
        )
        .option(
            "--stagnation-monitor <mins>",
            "Interval in minutes between generic-tech stagnation re-checks once armed",
            "1"
        )
        .option(
            "--include-methods <methods>",
            "Comma-separated lazyload method names to run (whitelist). Use --list-methods to see valid names."
        )
        .option(
            "--exclude-methods <methods>",
            "Comma-separated lazyload method names to skip (blacklist). Use --list-methods to see valid names."
        )
        .option(
            "--list-methods [framework]",
            "Print available lazyload method names grouped by framework and exit. Optionally filter by framework (next_js, vue, nuxt_js, svelte, angular, react)."
        )
        .option(
            "--cs-mast-tech-detect-threshold <n>",
            "Minimum CS-MAST-S signature matches required to detect bundler for the refactor step (0 = skip refactor)",
            "50"
        )
        .option("--disable-refactor", "Skip the automatic refactor step after report", false)
        .option(
            "--web-stats-dashboard",
            "Start a live web dashboard (with a REST API) to follow this run's progress instead of relying on console output",
            false
        )
        .option(
            "--web-stats-port <port>",
            "Preferred port for --web-stats-dashboard (increments if already in use)",
            "6767"
        )
        .action(async (cmd) => {
            // handle --list-methods before any network work
            if (cmd.listMethods !== undefined) {
                const filter = typeof cmd.listMethods === "string" ? cmd.listMethods : null;
                const frameworkKeys = Object.keys(FRAMEWORK_METHODS);
                if (filter && !frameworkKeys.includes(filter)) {
                    console.error(
                        chalk.red(`[!] Unknown framework: "${filter}". Valid frameworks: ${frameworkKeys.join(", ")}`)
                    );
                    process.exit(1);
                }
                const keys = filter ? [filter] : frameworkKeys;
                for (const fw of keys) {
                    console.log(chalk.cyan(`\n[${fw}]`));
                    for (const method of FRAMEWORK_METHODS[fw]) {
                        console.log(chalk.green(`  - ${method}`));
                    }
                }
                process.exit(0);
            }

            // parse and validate method filter lists
            const includeMethods: string[] = cmd.includeMethods
                ? cmd.includeMethods
                      .split(",")
                      .map((m: string) => m.trim())
                      .filter(Boolean)
                : [];
            const excludeMethods: string[] = cmd.excludeMethods
                ? cmd.excludeMethods
                      .split(",")
                      .map((m: string) => m.trim())
                      .filter(Boolean)
                : [];
            const allMethods = [...includeMethods, ...excludeMethods];
            const invalid = allMethods.filter((m) => !VALID_METHODS.includes(m));
            if (invalid.length > 0) {
                console.error(chalk.red(`[!] Invalid method name(s): ${invalid.join(", ")}`));
                console.error(chalk.yellow(`[i] Valid methods: ${VALID_METHODS.join(", ")}`));
                process.exit(22);
            }
            cmd._includeMethods = includeMethods;
            cmd._excludeMethods = excludeMethods;

            if (!cmd.url || (Array.isArray(cmd.url) && cmd.url.length === 0)) {
                console.error(chalk.red("[!] Missing required option: -u, --url <url/list/file>"));
                process.exit(1);
            }

            const runLazyloadTimeoutMin = Number(cmd.lazyloadTimeout);
            const runStagnationTimeinMin = Number(cmd.stagnationTimein);
            if (runLazyloadTimeoutMin > 0 && runStagnationTimeinMin > runLazyloadTimeoutMin) {
                console.error(
                    chalk.red(
                        `[!] --stagnation-timein (${runStagnationTimeinMin}m) cannot exceed --lazyload-timeout (${runLazyloadTimeoutMin}m)`
                    )
                );
                process.exit(30);
            }

            if (cmd.maxHeap !== undefined) applyHeapLimit(parseMaxHeapMb(cmd.maxHeap));
            validateAndSetTimeout(cmd.timeout);
            globalsUtil.setAi(cmd.ai?.split(",") || []);
            globalsUtil.setAiApiKey(cmd.aiApiKey);
            globalsUtil.setAiModel(cmd.model);
            globalsUtil.setAiServiceProvider(cmd.aiProvider);
            globalsUtil.setAiThreads(cmd.aiThreads);
            if (cmd.aiEndpoint) globalsUtil.setAiEndpoint(cmd.aiEndpoint);
            globalsUtil.setOpenapiChunkTag(cmd.mapOpenapiChunkTag);
            globalsUtil.setGraphqlEnabled(cmd.graphql !== false && !cmd.ngql);
            globalsUtil.setDisableCache(cmd.disableCache);
            globalsUtil.setRespCacheFile(cmd.cacheFile);
            globalsUtil.setCacheOnly(cmd.cacheOnly);
            globalsUtil.setVerbose(cmd.verbose);
            const resolvedCustomHeaders = resolveCustomHeaders(cmd.header);
            globalsUtil.setCustomHeaders(resolvedCustomHeaders);

            if (cmd.headerFile) {
                if (cmd.oxylabsWafFallback || cmd.proxyWafFallback) {
                    console.error(
                        chalk.red(
                            "[!] --header-file cannot be combined with --oxylabs-waf-fallback or --proxy-waf-fallback (a private header must never be sent through a third-party fallback proxy)"
                        )
                    );
                    process.exit(35);
                }
                let privateHeaders: ReturnType<typeof readHeaderFile>;
                try {
                    privateHeaders = readHeaderFile(cmd.headerFile);
                } catch (error) {
                    console.error(
                        chalk.red(`[!] ${error instanceof HeaderFileError ? error.message : "Unable to read --header-file"}`)
                    );
                    process.exit(35);
                }
                const customHeaderNames = new Set(resolvedCustomHeaders.map((h) => h.name.toLowerCase()));
                const collision = privateHeaders.find((h) => customHeaderNames.has(h.name.toLowerCase()));
                if (collision) {
                    console.error(
                        chalk.red("[!] --header-file has a header name that collides with a -H/--header value")
                    );
                    process.exit(35);
                }
                let resolvedTargets: readonly string[];
                try {
                    resolvedTargets = resolveTargetInputs(cmd.url).targets;
                } catch (error) {
                    console.error(
                        chalk.red(`[!] ${error instanceof TargetInputError ? error.message : "Unable to resolve -u/--url"}`)
                    );
                    process.exit(1);
                }
                globalsUtil.setPrivateHeaders(privateHeaders, buildOriginAllowlist(resolvedTargets));
            }

            configureSandbox(cmd);

            // validate AI options
            if (globalsUtil.getAi().length !== 0) {
                for (const aiType of globalsUtil.getAi()) {
                    if (aiType !== "" && !validAiOptions.includes(aiType)) {
                        console.error(chalk.red(`[!] Invalid AI option: ${aiType}`));
                        process.exit(2);
                    }
                }
            }
            await run(cmd);
        });

    program
        .command("load")
        .description("Populate response cache from a Caido/Burp request history export")
        .requiredOption("-c, --caido <file>", "Caido JSON export file")
        .requiredOption("-u, --url <url>", "Target URL — only entries matching this host/port/scheme are loaded")
        .option("--cache-file <file>", "Response cache file to write", ".resp_cache.db")
        .action(async (cmd) => {
            globalsUtil.setRespCacheFile(cmd.cacheFile);
            await load(cmd.caido, cmd.url);
        });

    program
        .command("fingerprint")
        .description("Detect front-end frameworks across one or more URLs")
        .option(
            "-u, --url <url/list/file>",
            "Target URL, comma-separated URLs, or target file; may be repeated",
            collectTargetInput
        )
        .option("-o, --output <file>", "Output file to write results")
        .option("-f, --format <formats>", "Output format(s): text, csv, json, jsonl (comma-separated)", "text")
        .option("-t, --threads <threads>", "Number of concurrent detection workers", "5")
        .option("--timeout <timeout>", "Request timeout in ms", "30000")
        .option("-k, --insecure", "Disable SSL certificate verification", false)
        .option("--no-sandbox", "Disable browser sandbox")
        .action(async (cmd) => {
            if (!cmd.url || (Array.isArray(cmd.url) && cmd.url.length === 0)) {
                console.error(chalk.red("[!] Missing required option: -u, --url <url/list/file>"));
                process.exit(1);
            }
            validateAndSetTimeout(cmd.timeout);
            globalsUtil.setDisableCache(true);
            globalsUtil.setYes(true);
            configureSandbox(cmd);
            await fingerprint(cmd.url, cmd.output, cmd.format, Number(cmd.threads));
        });

    program
        .command("mcp")
        .description("AI-powered CLI / one-shot chat / Model Context Protocol server for js-recon")
        .option("--cli", "Start interactive CLI mode", false)
        .option("--server", "Start a Model Context Protocol server over stdio", false)
        .option(
            "-c, --chat <prompt>",
            "Send a one-shot prompt to the AI agent non-interactively (can be passed multiple times)",
            (val: string, prev: string[]) => [...prev, val],
            [] as string[]
        )
        .option("--config <file>", "Path to MCP config file", undefined)
        .option("--api-key <key>", "API key for the LLM provider")
        .option("--model <model>", "AI model to use (e.g. gpt-4o-mini, claude-sonnet-4-20250514)")
        .option("--provider <provider>", "LLM provider to use (openai, anthropic)")
        .option("--no-refresh-claude-creds", "Do not auto-refresh Claude Code OAuth tokens; fail if expired")
        .option("--claude-client-id <id>", "OAuth client ID used when refreshing Claude Code credentials")
        .action(async (cmd) => {
            await mcp({
                cli: cmd.cli,
                server: cmd.server,
                chat: cmd.chat,
                configFile: cmd.config,
                apiKey: cmd.apiKey,
                model: cmd.model,
                provider: cmd.provider,
                refreshClaudeCreds: cmd.refreshClaudeCreds,
                claudeClientId: cmd.claudeClientId,
            });
        });

    program
        .command("cs-mast")
        .description("Compute CS-MAST hashes for downloaded JS files and find structural collisions")
        .option("-o, --output <directory>", "Output directory to scan for JS files", "output")
        .option("--ct, --collision-table", "Find and display hash collisions", false)
        .option("--min-collisions <n>", "Minimum times a hash must appear to be reported", "2")
        .option("--co, --collision-output <file>", "Write collision results to a file")
        .option("--cf, --collision-format <format>", "Output format for collision file: json or csv", "csv")
        .option(
            "--scat <categories>",
            "Comma-separated scat categories (e.g. lit,decl,loop,cond)",
            "lit,decl,loop,cond"
        )
        .option("--sinc <nodes>", "Comma-separated exact node types to include via sinc (e.g. IfStatement)", "")
        .option(
            "--all-scat-permutations",
            "Run all 511 non-empty scat permutations and save per-permutation collision files",
            false
        )
        .option(
            "--perm-output <dir>",
            "Output directory for per-permutation collision files (required with --all-scat-permutations)"
        )
        .option("--perm-concurrency <n>", "Number of parallel permutation workers (default: half of CPU count)", "0")
        .action(async (cmd) => {
            await csMast(
                cmd.output,
                cmd.collisionTable,
                parseInt(cmd.minCollisions, 10),
                cmd.collisionOutput,
                cmd.collisionFormat,
                cmd.scat,
                cmd.sinc || "",
                cmd.allScatPermutations,
                cmd.permOutput,
                parseInt(cmd.permConcurrency, 10)
            );
        });

    program
        .command("sourcemaps")
        .description("Extract source files from .map sourcemap file(s)")
        .requiredOption("-i, --input <path>", "Single .map file or directory containing .map files")
        .option("-o, --output <directory>", "Output directory for extracted source files", "extracted")
        .action(async (cmd) => {
            await sourcemaps(cmd.input, cmd.output);
        });

    program
        .command("completion")
        .description("Install shell completion for bash, zsh, or fish")
        .addArgument(new Argument("<shell>", "Shell type: bash, zsh, or fish").choices(["bash", "zsh", "fish"]))
        .option(
            "--rc-file",
            "Print the small rc-file loader snippet instead of installing (used internally by the generated rc entry)"
        )
        .addHelpText(
            "after",
            `
Examples:
  js-recon completion bash   # installs the script and wires ~/.bashrc automatically
  js-recon completion zsh    # installs the script and wires ~/.zshrc automatically
  js-recon completion fish   # installs to ~/.config/fish/completions/js-recon.fish (auto-loaded)`
        )
        .action(async (shell, cmd) => {
            completion(shell, !!cmd.rcFile);
        });

    prepareProgramConfiguration(program);
    program.hook("preAction", (_rootCommand, actionCommand) => {
        const commandOptions = actionCommand.opts();
        if (commandOptions.oxylabsWafFallback && commandOptions.proxyWafFallback) {
            throw new OxylabsFallbackConfigurationError(
                "--oxylabs-waf-fallback cannot be combined with --proxy-waf-fallback"
            );
        }
        configureOxylabsFallback(
            resolveOxylabsFallback({
                enabled: commandOptions.oxylabsWafFallback === true,
                maxRequestsPerOrigin: commandOptions.oxylabsFallbackMaxRequests ?? "10",
                maxTotalRequests: commandOptions.oxylabsFallbackMaxTotal ?? "100",
                maxOrigins: commandOptions.oxylabsFallbackMaxOrigins ?? "25",
                loadedConfig: getLoadedApplicationConfig(),
                env: process.env,
                ignoreEnvironment: commandOptions.ignoreProxyEnv === true,
            })
        );
    });

    return program;
}
