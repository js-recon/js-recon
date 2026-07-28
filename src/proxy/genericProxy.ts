export interface ParsedProxyUrl {
    protocol: "socks5" | "http" | "https";
    host: string;
    port: number;
    username?: string;
    password?: string;
}

/**
 * Parses a socks5://[user:pass@]host:port or http(s)://[user:pass@]host:port proxy URL.
 */
export const parseProxyUrl = (url: string): ParsedProxyUrl => {
    const parsed = new URL(url);
    const protocol = parsed.protocol.replace(":", "");
    if (protocol !== "socks5" && protocol !== "http" && protocol !== "https") {
        throw new Error(`Unsupported proxy protocol: ${protocol}. Expected socks5, http, or https.`);
    }
    if (!parsed.hostname || !parsed.port) {
        throw new Error(`Invalid proxy URL: ${url}. Expected format: ${protocol}://[user:pass@]host:port`);
    }
    return {
        protocol,
        host: parsed.hostname,
        port: Number(parsed.port),
        username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
        password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    };
};
