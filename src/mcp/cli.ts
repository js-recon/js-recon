import readline from "readline";
import chalk from "chalk";
import inquirer from "inquirer";
import {
    ChatMessage,
    LLMProvider,
    SessionUsage,
    createProvider,
    createAnthropicOAuthProvider,
    listModels,
    getDefaultModel,
} from "./providers.js";
import { McpConfig, resolveApiKey, saveConfig } from "./config.js";
import { processCommand, CommandContext, getCommandSuggestions } from "./commands.js";
import { detectIntent, handleToolExecution } from "./intent.js";
import { getUsableAccessToken } from "./claudeCodeCreds.js";
import { getJobManager, buildJobContext, JobSummary } from "./jobs.js";
import { loadSkills, findSkill, parseSkillArgs, renderSkill } from "./skills.js";
import { printMsg, MSG } from "../utility/printMsg.js";

export const SYSTEM_PROMPT = `You are js-recon MCP, an AI assistant for JavaScript reconnaissance and security analysis.
You help users analyze websites by running js-recon modules against target URLs.

You have access to two main tools:
1. **lazyload** - Downloads and extracts JavaScript files from a target website. Detects frameworks (Next.js, Vue, Nuxt, Svelte, Angular) and downloads their JS bundles.
2. **run** - Runs the full js-recon pipeline (lazyload → strings → map → endpoints → analyze → report) against a target URL.

When the user asks you to scan/analyze/run against a website:
- If they want a quick JS file download, use lazyload.
- If they want a full analysis, use run.
- Always confirm the target URL before executing.

When the user asks to parse/summarize results:
- For lazyload results: provide a directory structure overview of downloaded files.
- For run results: read and summarize the output JSON files (endpoints, mapped functions, analysis, etc.).

Respond concisely and helpfully. When providing results, highlight security-relevant findings.`;

interface CliSession {
    provider: LLMProvider;
    providerName: "openai" | "anthropic";
    model: string;
    config: McpConfig;
    usage: SessionUsage;
    history: ChatMessage[];
    cliApiKey?: string;
    lastToolOutput?: string;
    lastOutputDir?: string;
    lastModule?: "lazyload" | "run";
    currentAbortController?: AbortController;
    configChanged: boolean;
    cwd: string;
}

/**
 * Prompts user to configure MCP settings interactively.
 */
const promptConfiguration = async (): Promise<{ provider: "openai" | "anthropic"; apiKey: string; model: string }> => {
    printMsg(MSG.Warn, "\n[!] No API key configured. Let's set up MCP.\n");

    const { provider } = await inquirer.prompt([
        {
            type: "list",
            name: "provider",
            message: "Select LLM provider:",
            choices: ["openai", "anthropic"],
        },
    ]);

    const { apiKey } = await inquirer.prompt([
        {
            type: "password",
            name: "apiKey",
            message: `Enter ${provider === "openai" ? "OpenAI" : "Anthropic"} API key:`,
            mask: "*",
        },
    ]);

    const availableModels = await listModels(provider, apiKey);
    const defaultModel = getDefaultModel(provider);

    const { model } = await inquirer.prompt([
        {
            type: "list",
            name: "model",
            message: "Select model:",
            choices: availableModels,
            default: defaultModel,
        },
    ]);

    return { provider, apiKey, model };
};

/**
 * Starts the interactive MCP CLI session.
 */
export interface StartCliOptions {
    refreshClaudeCreds?: boolean;
    claudeClientId?: string;
}

export const startCli = async (
    config: McpConfig,
    cliApiKey?: string,
    cliModel?: string,
    cliProvider?: string,
    opts: StartCliOptions = {}
): Promise<void> => {
    let providerName = (cliProvider || config.provider) as "openai" | "anthropic";
    let model = cliModel || config.model;
    let apiKey = resolveApiKey(providerName, cliApiKey, config);

    let provider: LLMProvider | null = null;

    if (!apiKey && (providerName === "anthropic" || !cliProvider)) {
        const token = await getUsableAccessToken({
            allowRefresh: opts.refreshClaudeCreds !== false,
            clientId: opts.claudeClientId,
        });
        if (token) {
            providerName = "anthropic";
            model = cliModel || getDefaultModel("anthropic");
            provider = createAnthropicOAuthProvider(token, model);
            printMsg(MSG.Header, "[i] Using existing Claude Code credentials (Anthropic OAuth).");
        }
    }

    if (!provider && !apiKey) {
        const configured = await promptConfiguration();
        providerName = configured.provider;
        apiKey = configured.apiKey;
        model = configured.model;

        config.provider = providerName;
        config.model = model;
        if (providerName === "openai") {
            config.openai_api_key = apiKey;
        } else {
            config.anthropic_api_key = apiKey;
        }
        saveConfig(config);
        printMsg(MSG.Run, "\n[✓] Configuration saved to ~/.js-recon/mcp.yaml\n");
    } else if (!provider && cliApiKey && !cliModel) {
        model = getDefaultModel(providerName);
        printMsg(MSG.Header, `[i] Auto-detected model: ${model}\n`);
    }

    if (!provider) {
        provider = createProvider(providerName, apiKey, model);
    }
    const usage = new SessionUsage(model);

    const launchCwd = process.cwd();

    const session: CliSession = {
        provider,
        providerName,
        model,
        config,
        usage,
        history: [{ role: "system", content: SYSTEM_PROMPT }],
        cliApiKey,
        configChanged: false,
        cwd: launchCwd,
    };

    // Preload skills cache so intent detection and /skill have it available.
    loadSkills();

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        completer: (line: string) => {
            if (line.startsWith("/")) {
                const suggestions = getCommandSuggestions(line);
                return [suggestions, line];
            }
            return [[], line];
        },
    });

    // Handle Ctrl-C: cancel in-flight LLM call → else cancel most recent running job → else exit warning.
    // `promptingActive` guards against re-entering `rl.question` while a prior question is still open.
    let ctrlCCount = 0;
    let promptingActive = false;
    const reprompt = (): void => {
        if (!promptingActive) prompt();
    };
    process.on("SIGINT", () => {
        try {
            if (session.currentAbortController) {
                printMsg(MSG.Warn, "\n\n[!] Stopping current process...\n");
                session.currentAbortController.abort();
                session.currentAbortController = undefined;
                ctrlCCount = 0;
                reprompt();
                return;
            }
            const cancelled = getJobManager().cancelMostRecentRunning();
            if (cancelled) {
                printMsg(MSG.Warn, `\n\n[!] Cancelling job ${cancelled.id} (${cancelled.name})...\n`);
                ctrlCCount = 0;
                reprompt();
                return;
            }
            ctrlCCount++;
            if (ctrlCCount === 1) {
                printMsg(MSG.Warn, "\n\n[!] Press Ctrl-C again to exit, or type /exit\n");
                setTimeout(() => {
                    ctrlCCount = 0;
                }, 2000);
                reprompt();
            } else {
                printMsg(MSG.Warn, "\nGoodbye!\n");
                if (session.configChanged) {
                    printMsg(MSG.Header, "[i] Config changes were made. Use /save to persist them.\n");
                }
                rl.close();
                process.exit(0);
            }
        } catch (err: any) {
            printMsg(MSG.Err, `\n[!] SIGINT handler error: ${err?.message || err}\n`);
        }
    });

    printMsg(MSG.Header, "\n  ╔══════════════════════════════════════╗");
    printMsg(MSG.Header, "  ║         js-recon MCP CLI             ║");
    printMsg(MSG.Header, "  ╚══════════════════════════════════════╝\n");
    printMsg(MSG.Info, `  Provider: ${providerName} | Model: ${model}`);
    printMsg(MSG.Info, `  Working directory: ${launchCwd}`);
    printMsg(MSG.Info, `  Artifacts are preserved across runs.`);
    printMsg(MSG.Info, `  Type /help for commands, or chat naturally.\n`);

    // Announce job completions between prompts.
    getJobManager().on("done", (job: JobSummary) => {
        const marker = job.status === "done" ? chalk.green("[✓]") : chalk.yellow("[!]");
        process.stdout.write(
            `\n${marker} Job ${job.id} (${job.name}) finished: ${job.status}` +
                (job.exitCode !== null ? ` (exit ${job.exitCode})` : "") +
                `\n`
        );
        rl.prompt(true);
    });

    const runInference = async (sess: CliSession, cfg: McpConfig): Promise<void> => {
        if (sess.history.length > cfg.history_limit) {
            const system = sess.history[0];
            sess.history = [system, ...sess.history.slice(-(cfg.history_limit - 1))];
        }
        sess.currentAbortController = new AbortController();
        const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
        let spinIdx = 0;
        const spinnerInterval: NodeJS.Timeout = setInterval(() => {
            process.stdout.write(`\r${chalk.cyan(spinner[spinIdx++ % spinner.length])} Thinking...`);
        }, 80);
        try {
            const response = await sess.provider.chat(sess.history);
            sess.usage.addUsage(response.promptTokens, response.completionTokens);
            sess.history.push({ role: "assistant", content: response.content });
            printMsg(MSG.Plain, "\n" + response.content + "\n");
        } catch (err: any) {
            if (err.name !== "AbortError") {
                printMsg(MSG.Err, `\n[!] ${err.message}\n`);
            } else {
                printMsg(MSG.Warn, "\n[!] Response generation stopped.\n");
            }
        } finally {
            clearInterval(spinnerInterval);
            process.stdout.write("\r" + " ".repeat(20) + "\r");
            sess.currentAbortController = undefined;
        }
    };

    const prompt = (): void => {
        if (promptingActive) return;
        promptingActive = true;
        rl.question(chalk.green("js-recon> "), async (input) => {
            promptingActive = false;
            const trimmed = input.trim();
            if (!trimmed) {
                prompt();
                return;
            }

            // Handle slash commands
            const cmdCtx: CommandContext = {
                usage,
                config,
                provider: session.providerName,
                model: session.model,
                conversationLength: session.history.length,
            };

            const cmdResult = processCommand(trimmed, cmdCtx);
            if (cmdResult.handled) {
                if (cmdResult.output) {
                    // Handle special output signals
                    if (cmdResult.output === "__LIST_MODELS__") {
                        const models = await listModels(
                            session.providerName,
                            resolveApiKey(session.providerName, session.cliApiKey, config)
                        );
                        printMsg(MSG.Header, `\n  Available models for ${session.providerName}:\n`);
                        models.forEach((m) => {
                            const marker = m === session.model ? chalk.green(" ← current") : "";
                            printMsg(MSG.Plain, `    ${m}${marker}`);
                        });
                        printMsg(MSG.Plain, "");
                    } else if (cmdResult.output.startsWith("__SWITCH_MODEL__")) {
                        const newModel = cmdResult.output.replace("__SWITCH_MODEL__", "");
                        session.model = newModel;
                        session.provider = createProvider(
                            session.providerName,
                            resolveApiKey(session.providerName, session.cliApiKey, config),
                            newModel
                        );
                        session.usage = new SessionUsage(newModel);
                        session.config.model = newModel;
                        session.configChanged = true;
                        printMsg(MSG.Run, `\n[✓] Switched model to: ${newModel}\n`);
                    } else if (cmdResult.output.startsWith("__SWITCH_PROVIDER__")) {
                        const newProvider = cmdResult.output.replace("__SWITCH_PROVIDER__", "") as
                            "openai" | "anthropic";
                        const newKey = resolveApiKey(newProvider, session.cliApiKey, config);
                        if (!newKey) {
                            printMsg(MSG.Err, `\n[!] No API key configured for ${newProvider}.\n`);
                        } else {
                            session.providerName = newProvider;
                            const autoModel = getDefaultModel(newProvider);
                            session.model = autoModel;
                            session.provider = createProvider(newProvider, newKey, autoModel);
                            session.usage = new SessionUsage(autoModel);
                            session.config.provider = newProvider;
                            session.config.model = autoModel;
                            session.configChanged = true;
                            printMsg(MSG.Run, `\n[✓] Switched provider to: ${newProvider}\n`);
                            printMsg(MSG.Header, `[i] Auto-selected model: ${autoModel}\n`);
                        }
                    } else if (cmdResult.output === "__SAVE_CONFIG__") {
                        saveConfig(session.config);
                        session.configChanged = false;
                        printMsg(MSG.Run, "\n[✓] Configuration saved to ~/.js-recon/mcp.yaml\n");
                    } else if (cmdResult.output.startsWith("__INVOKE_SKILL__")) {
                        const raw = cmdResult.output.replace("__INVOKE_SKILL__", "").trim();
                        const spaceIdx = raw.indexOf(" ");
                        const skillName = spaceIdx === -1 ? raw : raw.substring(0, spaceIdx);
                        const argsStr = spaceIdx === -1 ? "" : raw.substring(spaceIdx + 1);
                        const skill = findSkill(skillName);
                        if (!skill) {
                            printMsg(MSG.Err, `\n[!] Skill not found: ${skillName}\n`);
                            prompt();
                            return;
                        }
                        const parsed = parseSkillArgs(argsStr, skill);
                        const rendered = renderSkill(skill, parsed);
                        if (!rendered.ok) {
                            printMsg(MSG.Err, `\n[!] ${rendered.error}\n`);
                            prompt();
                            return;
                        }
                        printMsg(MSG.Header, `\n[i] Invoking skill: ${skillName}\n`);
                        const skillMessage = rendered.prompt!;
                        const jobContext = buildJobContext(2048);
                        session.history.push({
                            role: "user",
                            content: jobContext ? `${skillMessage}${jobContext}` : skillMessage,
                        });
                        await runInference(session, config);
                        prompt();
                        return;
                    } else {
                        printMsg(MSG.Plain, cmdResult.output);
                    }
                }

                // Handle /clear
                if (trimmed.toLowerCase() === "/clear") {
                    session.history = [{ role: "system", content: SYSTEM_PROMPT }];
                }

                if (cmdResult.exit) {
                    if (session.configChanged) {
                        printMsg(MSG.Header, "[i] Config changes were made. Use /save to persist them.\n");
                    }
                    rl.close();
                    return;
                }
                prompt();
                return;
            }

            // Detect intent and possibly run tools
            const intent = detectIntent(trimmed);
            let toolContext = "";

            if (intent.action !== "chat") {
                try {
                    const toolOutput = await handleToolExecution(session, intent);
                    if (toolOutput) {
                        // Echo to the user immediately so they see what happened, even if the LLM
                        // call later fails (e.g. quota / network).
                        printMsg(MSG.Header, `\n${toolOutput}\n`);
                        toolContext = `\n\n[Tool Output - ${intent.action}]:\n${toolOutput}`;
                    } else if ((intent.action === "lazyload" || intent.action === "run") && !intent.url) {
                        toolContext = "\n\n[System: No URL detected in the message. Ask the user for the target URL.]";
                    }
                } catch (err: any) {
                    printMsg(MSG.Err, `\n[!] Tool error: ${err.message}\n`);
                }
            }

            // Inject tails of running background jobs so the LLM can answer "how's it going?".
            const jobContext = buildJobContext(2048);

            // Build user message with tool + job context
            const userMessage = toolContext || jobContext ? `${trimmed}${toolContext}${jobContext}` : trimmed;
            session.history.push({ role: "user", content: userMessage });
            await runInference(session, config);
            prompt();
        });
    };

    prompt();
};
