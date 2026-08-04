import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { printMsg, MSG } from "../utility/printMsg.js";

const execFileAsync = promisify(execFile);

const KEYCHAIN_SERVICE = "Claude Code-credentials";
const LINUX_CREDS_PATH = path.join(os.homedir(), ".claude", ".credentials.json");
const OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";

export interface ClaudeAiOauth {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes?: string[];
    subscriptionType?: string;
}

export interface ClaudeCodeCreds {
    claudeAiOauth: ClaudeAiOauth;
}

type CredsSource = "keychain" | "file";

interface ReadResult {
    creds: ClaudeCodeCreds;
    source: CredsSource;
}

const readFromKeychain = async (): Promise<string | null> => {
    try {
        const { stdout } = await execFileAsync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]);
        const value = stdout.trim();
        return value || null;
    } catch {
        return null;
    }
};

const writeToKeychain = async (value: string): Promise<void> => {
    const account = os.userInfo().username;
    await execFileAsync("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", account, "-w", value]);
};

const readFromFile = (): string | null => {
    try {
        if (!fs.existsSync(LINUX_CREDS_PATH)) return null;
        return fs.readFileSync(LINUX_CREDS_PATH, "utf-8");
    } catch {
        return null;
    }
};

const writeToFile = (value: string): void => {
    fs.mkdirSync(path.dirname(LINUX_CREDS_PATH), { recursive: true });
    fs.writeFileSync(LINUX_CREDS_PATH, value, { mode: 0o600 });
};

const parseCreds = (raw: string): ClaudeCodeCreds | null => {
    try {
        const obj = JSON.parse(raw);
        if (obj && obj.claudeAiOauth && typeof obj.claudeAiOauth.accessToken === "string") {
            return obj as ClaudeCodeCreds;
        }
        return null;
    } catch {
        return null;
    }
};

export const readClaudeCodeCreds = async (): Promise<ReadResult | null> => {
    if (process.platform === "darwin") {
        const raw = await readFromKeychain();
        if (raw) {
            const creds = parseCreds(raw);
            if (creds) return { creds, source: "keychain" };
        }
    }
    const raw = readFromFile();
    if (raw) {
        const creds = parseCreds(raw);
        if (creds) return { creds, source: "file" };
    }
    return null;
};

export const isExpired = (creds: ClaudeCodeCreds, skewMs = 60_000): boolean => {
    const expiresAt = creds.claudeAiOauth.expiresAt;
    if (!expiresAt) return false;
    return Date.now() + skewMs >= expiresAt;
};

const writeCreds = async (creds: ClaudeCodeCreds, source: CredsSource): Promise<void> => {
    const serialized = JSON.stringify(creds);
    if (source === "keychain") {
        await writeToKeychain(serialized);
    } else {
        writeToFile(serialized);
    }
};

export const refreshClaudeCodeCreds = async (
    creds: ClaudeCodeCreds,
    source: CredsSource,
    clientId?: string
): Promise<ClaudeCodeCreds> => {
    if (!clientId) {
        throw new Error(
            "Cannot refresh Claude Code OAuth token: --claude-client-id is required. " +
                "Pass the OAuth client ID or use --no-refresh-claude-creds to skip refresh."
        );
    }

    printMsg(MSG.Warn, "[!] Refreshing Claude Code OAuth token (use --no-refresh-claude-creds to disable).");

    const body = {
        grant_type: "refresh_token",
        refresh_token: creds.claudeAiOauth.refreshToken,
        client_id: clientId,
    };

    const res = await fetch(OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
            `Failed to refresh Claude Code OAuth token (HTTP ${res.status}). Run 'claude' to re-authenticate.${
                text ? ` Details: ${text.slice(0, 200)}` : ""
            }`
        );
    }

    const data = (await res.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
        scope?: string;
    };

    const refreshed: ClaudeCodeCreds = {
        claudeAiOauth: {
            accessToken: data.access_token,
            refreshToken: data.refresh_token || creds.claudeAiOauth.refreshToken,
            expiresAt: Date.now() + data.expires_in * 1000,
            scopes: data.scope ? data.scope.split(" ") : creds.claudeAiOauth.scopes,
            subscriptionType: creds.claudeAiOauth.subscriptionType,
        },
    };

    try {
        await writeCreds(refreshed, source);
    } catch (err: any) {
        printMsg(MSG.Warn, `[!] Refreshed token, but failed to persist it back to ${source}: ${err.message}`);
    }

    return refreshed;
};

export interface GetTokenOptions {
    allowRefresh: boolean;
    clientId?: string;
}

export const getUsableAccessToken = async (opts: GetTokenOptions): Promise<string | null> => {
    const read = await readClaudeCodeCreds();
    if (!read) return null;

    if (!isExpired(read.creds)) {
        return read.creds.claudeAiOauth.accessToken;
    }

    if (!opts.allowRefresh) {
        printMsg(
            MSG.Err,
            "[!] Claude Code OAuth token is expired and --no-refresh-claude-creds was set. Run 'claude' to re-authenticate."
        );
        return null;
    }

    try {
        const refreshed = await refreshClaudeCodeCreds(read.creds, read.source, opts.clientId);
        return refreshed.claudeAiOauth.accessToken;
    } catch (err: any) {
        printMsg(MSG.Err, `[!] ${err.message}`);
        return null;
    }
};
