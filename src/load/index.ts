import chalk from "chalk";
import fs from "fs";
import { URL } from "url";
import zlib from "zlib";
import * as globals from "../utility/globals.js";
import { printMsg, MSG } from "../utility/printMsg.js";
import { getCacheIdentityDigest } from "../utility/makeReq.js";
import { getCacheDb, writeCacheEntryUnsafe } from "../utility/cacheDb.js";

interface CaidoEntry {
    id: number;
    host: string;
    method: string;
    path: string;
    port: number;
    raw: string;
    is_tls: boolean;
    query: string | null;
    response?: {
        id: number;
        status_code: number;
        raw: string;
    };
}

const DEFAULT_PORTS: Record<string, number> = { "http:": 80, "https:": 443 };

async function* streamCaidoEntries(filePath: string, rawFilter: (raw: string) => boolean): AsyncGenerator<CaidoEntry> {
    const stream = fs.createReadStream(filePath, { encoding: "utf8", highWaterMark: 1024 * 1024 });
    let depth = 0;
    let inString = false;
    let escape = false;
    let started = false;
    let inObject = false;
    let pending: string[] = [];
    let startIdx = -1;

    for await (const chunk of stream) {
        const buf = chunk as string;
        for (let i = 0; i < buf.length; i++) {
            const c = buf[i];
            if (!started) {
                if (c === "[") started = true;
                continue;
            }
            if (!inObject) {
                if (c === "{") {
                    inObject = true;
                    depth = 1;
                    startIdx = i;
                }
                continue;
            }
            if (inString) {
                if (escape) escape = false;
                else if (c === "\\") escape = true;
                else if (c === '"') inString = false;
                continue;
            }
            if (c === '"') {
                inString = true;
            } else if (c === "{") {
                depth++;
            } else if (c === "}") {
                depth--;
                if (depth === 0) {
                    pending.push(buf.slice(startIdx, i + 1));
                    const objStr = pending.length === 1 ? pending[0] : pending.join("");
                    pending = [];
                    inObject = false;
                    startIdx = -1;
                    if (rawFilter(objStr)) {
                        try {
                            yield JSON.parse(objStr) as CaidoEntry;
                        } catch {
                            // skip malformed object
                        }
                    }
                }
            }
        }
        if (inObject && startIdx !== -1) {
            pending.push(buf.slice(startIdx));
            startIdx = 0;
        }
    }
}

function splitHttpMessage(raw: Buffer): { headerText: string; body: Buffer } | null {
    const sep = Buffer.from("\r\n\r\n");
    const idx = raw.indexOf(sep);
    if (idx === -1) {
        const lfSep = Buffer.from("\n\n");
        const idx2 = raw.indexOf(lfSep);
        if (idx2 === -1) return null;
        return { headerText: raw.slice(0, idx2).toString("utf8"), body: raw.slice(idx2 + 2) };
    }
    return { headerText: raw.slice(0, idx).toString("utf8"), body: raw.slice(idx + 4) };
}

function parseHeaders(headerText: string): { firstLine: string; headers: Record<string, string> } {
    const lines = headerText.split(/\r?\n/);
    const firstLine = lines.shift() || "";
    const headers: Record<string, string> = {};
    for (const line of lines) {
        if (!line) continue;
        const colon = line.indexOf(":");
        if (colon === -1) continue;
        const key = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (!key) continue;
        headers[key] = value;
    }
    return { firstLine, headers };
}

function decodeBody(body: Buffer, headers: Record<string, string>): Buffer {
    const enc = Object.entries(headers)
        .find(([k]) => k.toLowerCase() === "content-encoding")?.[1]
        ?.toLowerCase();
    if (!enc) return body;
    try {
        if (enc.includes("gzip")) return zlib.gunzipSync(body);
        if (enc.includes("br")) return zlib.brotliDecompressSync(body);
        if (enc.includes("deflate")) {
            try {
                return zlib.inflateSync(body);
            } catch {
                return zlib.inflateRawSync(body);
            }
        }
        if (enc.includes("zstd") && (zlib as any).zstdDecompressSync) {
            return (zlib as any).zstdDecompressSync(body);
        }
    } catch {
        // fall through and return raw body
    }
    return body;
}

function buildUrlVariants(entry: CaidoEntry): string[] {
    const scheme = entry.is_tls ? "https:" : "http:";
    const defaultPort = DEFAULT_PORTS[scheme];
    const hasNonDefaultPort = entry.port && entry.port !== defaultPort;
    const hostWithPort = hasNonDefaultPort ? `${entry.host}:${entry.port}` : entry.host;
    const hostNoPort = entry.host;
    const path = entry.path || "/";
    const query = entry.query ? `?${entry.query}` : "";

    const variants = new Set<string>();
    variants.add(`${scheme}//${hostWithPort}${path}${query}`);
    if (hasNonDefaultPort) {
        variants.add(`${scheme}//${hostNoPort}${path}${query}`);
    } else {
        variants.add(`${scheme}//${entry.host}:${entry.port}${path}${query}`);
    }
    if (path === "/" && !query) {
        variants.add(`${scheme}//${hostWithPort}`);
        if (hasNonDefaultPort) variants.add(`${scheme}//${hostNoPort}`);
    }
    return Array.from(variants);
}

const load = async (caidoFile: string, targetUrl: string): Promise<void> => {
    printMsg(MSG.Header, "[i] Loading 'Load' module");

    if (!fs.existsSync(caidoFile)) {
        printMsg(MSG.Err, `[!] Caido file not found: ${caidoFile}`);
        process.exit(1);
    }

    let targetHost: string;
    let targetPort: number;
    let targetScheme: string;
    try {
        const u = new URL(targetUrl);
        targetHost = u.hostname;
        targetScheme = u.protocol;
        targetPort = u.port ? parseInt(u.port, 10) : DEFAULT_PORTS[u.protocol];
    } catch {
        printMsg(MSG.Err, `[!] Invalid target URL: ${targetUrl}`);
        process.exit(1);
    }

    const cacheFile = globals.getRespCacheFile();
    try {
        getCacheDb();
    } catch (err) {
        printMsg(MSG.Err, `[!] Could not open response cache database: ${err?.message || err}`);
        process.exit(32);
    }

    printMsg(MSG.Header, `[i] Filtering Caido entries for ${targetScheme}//${targetHost}:${targetPort} → ${cacheFile}`);

    let scanned = 0;
    let matched = 0;
    let stored = 0;

    const hostNeedle = `"host":"${targetHost}"`;
    const rawFilter = (raw: string): boolean => raw.includes(hostNeedle);

    for await (const entry of streamCaidoEntries(caidoFile, rawFilter)) {
        scanned++;
        if (scanned % 5000 === 0) {
            process.stdout.write(chalk.dim(`\r[i] Scanned ${scanned} entries (matched ${matched})`));
        }

        if (!entry || !entry.host) continue;
        if (entry.host !== targetHost) continue;
        if (entry.port !== targetPort) continue;
        const entryScheme = entry.is_tls ? "https:" : "http:";
        if (entryScheme !== targetScheme) continue;
        if (!entry.response) continue;

        matched++;

        let respRaw: Buffer;
        let reqRaw: Buffer;
        try {
            respRaw = Buffer.from(entry.response.raw, "base64");
            reqRaw = Buffer.from(entry.raw, "base64");
        } catch {
            continue;
        }

        const respParts = splitHttpMessage(respRaw);
        if (!respParts) continue;
        const reqParts = splitHttpMessage(reqRaw);

        const respParsed = parseHeaders(respParts.headerText);
        const reqHeaders = reqParts ? parseHeaders(reqParts.headerText).headers : {};

        const decodedBody = decodeBody(respParts.body, respParsed.headers);
        const bodyB64 = decodedBody.toString("base64");

        const respHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(respParsed.headers)) {
            const lk = k.toLowerCase();
            if (lk === "content-length" || lk === "content-encoding" || lk === "transfer-encoding") continue;
            respHeaders[k] = v;
        }

        const status = entry.response.status_code || parseInt(respParsed.firstLine.split(/\s+/)[1] || "200", 10);

        for (const url of buildUrlVariants(entry)) {
            const identityDigest = getCacheIdentityDigest(url, reqHeaders);
            writeCacheEntryUnsafe({
                identityDigest,
                url,
                status,
                statusText: "",
                bodyBase64: bodyB64,
                responseHeaders: respHeaders,
            });
            stored++;
        }
    }

    process.stdout.write("\r");

    printMsg(
        MSG.Run,
        `[✓] Load complete — scanned ${scanned}, matched ${matched}, wrote ${stored} cache entries to ${cacheFile}`
    );
};

export default load;
