import { loadConfig } from "./config.js";
import { startCli } from "./cli.js";
import { runChatOneShot } from "./chatOneShot.js";
import { startMcpServer } from "./mcpServer.js";
import { printMsg, MSG } from "../utility/printMsg.js";

export interface McpOptions {
    cli: boolean;
    server: boolean;
    chat: string[];
    configFile?: string;
    apiKey?: string;
    model?: string;
    provider?: string;
    refreshClaudeCreds: boolean; // commander sets to false when --no-refresh-claude-creds passed
    claudeClientId?: string;
}

/**
 * Main entry point for the MCP module. Dispatches between:
 *  --server      Model Context Protocol stdio server
 *  -c/--chat     one-shot non-interactive chat
 *  --cli         interactive TUI
 *  (no flags)    usage hint
 */
const mcp = async (opts: McpOptions): Promise<void> => {
    if (opts.server) {
        await startMcpServer();
        return;
    }

    printMsg(MSG.Header, "[i] Loading 'MCP' module");
    const config = loadConfig(opts.configFile);

    if (opts.chat && opts.chat.length > 0) {
        await runChatOneShot(config, opts.chat, opts.apiKey, opts.model, opts.provider, {
            refreshClaudeCreds: opts.refreshClaudeCreds,
            claudeClientId: opts.claudeClientId,
        });
        return;
    }

    if (opts.cli) {
        await startCli(config, opts.apiKey, opts.model, opts.provider, {
            refreshClaudeCreds: opts.refreshClaudeCreds,
            claudeClientId: opts.claudeClientId,
        });
        return;
    }

    printMsg(MSG.Warn, "[!] MCP module requires a mode flag.");
    printMsg(MSG.Header, "[i] Usage:");
    printMsg(MSG.Plain, "    js-recon mcp --cli                  Interactive TUI");
    printMsg(MSG.Plain, '    js-recon mcp -c "<prompt>"          One-shot chat');
    printMsg(MSG.Plain, "    js-recon mcp --server               Model Context Protocol server (stdio)");
};

export default mcp;
