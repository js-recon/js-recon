import fs from "fs";
import path from "path";
import YAML from "yaml";
import { printMsg, MSG } from "../utility/printMsg.js";

export interface McpConfig {
    provider: "openai" | "anthropic";
    model: string;
    openai_api_key?: string;
    anthropic_api_key?: string;
    default_output_dir: string;
    default_threads: number;
    history_limit: number;
}

const DEFAULT_CONFIG: McpConfig = {
    provider: "openai",
    model: "gpt-4o-mini",
    openai_api_key: "",
    anthropic_api_key: "",
    default_output_dir: "output",
    default_threads: 1,
    history_limit: 50,
};

const CONFIG_DIR = path.join(process.env.HOME || "~", ".js-recon");
const CONFIG_FILE = path.join(CONFIG_DIR, "mcp.yaml");

/**
 * Ensures the ~/.js-recon directory exists.
 */
export const ensureConfigDir = (): void => {
    if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
        printMsg(MSG.Header, `[i] Created config directory: ${CONFIG_DIR}`);
    }
};

/**
 * Loads MCP configuration from ~/.js-recon/mcp.yaml.
 * Creates a default config file if one does not exist.
 */
export const loadConfig = (configPath?: string): McpConfig => {
    const filePath = configPath || CONFIG_FILE;
    ensureConfigDir();

    if (!fs.existsSync(filePath)) {
        saveConfig(DEFAULT_CONFIG, filePath);
        printMsg(MSG.Header, `[i] Created default MCP config at ${filePath}`);
        return { ...DEFAULT_CONFIG };
    }

    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const parsed = YAML.parse(raw) as Partial<McpConfig>;
        return { ...DEFAULT_CONFIG, ...parsed };
    } catch (err) {
        printMsg(MSG.Warn, `[!] Failed to parse config at ${filePath}. Using defaults.`);
        return { ...DEFAULT_CONFIG };
    }
};

/**
 * Saves MCP configuration to ~/.js-recon/mcp.yaml.
 */
export const saveConfig = (config: McpConfig, configPath?: string): void => {
    const filePath = configPath || CONFIG_FILE;
    ensureConfigDir();
    fs.writeFileSync(filePath, YAML.stringify(config), "utf-8");
};

/**
 * Resolves the API key for a given provider, checking CLI flag, config, and env vars.
 */
export const resolveApiKey = (
    provider: "openai" | "anthropic",
    cliKey: string | undefined,
    config: McpConfig
): string => {
    if (cliKey) return cliKey;

    if (provider === "openai") {
        return config.openai_api_key || process.env.OPENAI_API_KEY || "";
    }
    return config.anthropic_api_key || process.env.ANTHROPIC_API_KEY || "";
};

export const getConfigDir = (): string => CONFIG_DIR;
export const getConfigFilePath = (): string => CONFIG_FILE;
