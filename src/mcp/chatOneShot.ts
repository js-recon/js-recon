import {
    ChatMessage,
    LLMProvider,
    SessionUsage,
    createProvider,
    createAnthropicOAuthProvider,
    getDefaultModel,
} from "./providers.js";
import { McpConfig, resolveApiKey } from "./config.js";
import { detectIntent, handleToolExecution, IntentToolState } from "./intent.js";
import { getUsableAccessToken } from "./claudeCodeCreds.js";
import { SYSTEM_PROMPT } from "./cli.js";
import { getJobManager } from "./jobs.js";
import { loadSkills } from "./skills.js";
import { printMsg, MSG } from "../utility/printMsg.js";

export interface ChatOneShotOptions {
    refreshClaudeCreds?: boolean;
    claudeClientId?: string;
}

export const runChatOneShot = async (
    config: McpConfig,
    prompts: string[],
    cliApiKey: string | undefined,
    cliModel: string | undefined,
    cliProvider: string | undefined,
    opts: ChatOneShotOptions = {}
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
        printMsg(
            MSG.Err,
            "[!] No API key configured and no Claude Code credentials found. Pass --api-key, set OPENAI_API_KEY / ANTHROPIC_API_KEY, or run 'claude' to log in."
        );
        process.exit(1);
    }

    if (!provider && cliApiKey && !cliModel) {
        model = getDefaultModel(providerName);
    }

    if (!provider) {
        provider = createProvider(providerName, apiKey, model);
    }

    loadSkills();
    const usage = new SessionUsage(model);
    const history: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
    const cwd = process.cwd();
    const toolState: IntentToolState = { config, cwd };
    printMsg(MSG.Info, `[i] Working directory: ${cwd}`);

    for (const rawPrompt of prompts) {
        const trimmed = rawPrompt.trim();
        if (!trimmed) continue;

        const intent = detectIntent(trimmed);
        let toolContext = "";

        if (intent.action !== "chat") {
            try {
                const toolOutput = await handleToolExecution(toolState, intent);
                if (toolOutput) {
                    toolContext = `\n\n[Tool Output - ${intent.action}]:\n${toolOutput}`;
                } else if ((intent.action === "lazyload" || intent.action === "run") && !intent.url) {
                    toolContext = "\n\n[System: No URL detected in the message. Ask the user for the target URL.]";
                }

                // In one-shot mode, wait for any spawned jobs to finish before answering.
                if (intent.action === "lazyload" || intent.action === "run") {
                    const mgr = getJobManager();
                    const running = mgr.listRunning();
                    for (const j of running) {
                        const finished = await mgr.waitJob(j.id);
                        const log = mgr.fullLog(j.id) || "";
                        toolContext +=
                            `\n\n[Job ${j.id} (${j.name}) finished: ${finished?.status} exit=${finished?.exitCode}]\n` +
                            log.slice(-4096);
                    }
                }
            } catch (err: any) {
                printMsg(MSG.Err, `[!] Tool error: ${err.message}`);
            }
        }

        const userMessage = toolContext ? `${trimmed}${toolContext}` : trimmed;
        history.push({ role: "user", content: userMessage });

        if (history.length > config.history_limit) {
            const system = history[0];
            history.splice(0, history.length, system, ...history.slice(-(config.history_limit - 1)));
        }

        try {
            const response = await provider.chat(history);
            usage.addUsage(response.promptTokens, response.completionTokens);
            history.push({ role: "assistant", content: response.content });
            process.stdout.write(response.content + "\n");
        } catch (err: any) {
            printMsg(MSG.Err, `[!] ${err.message}`);
            process.exit(1);
        }
    }
};
