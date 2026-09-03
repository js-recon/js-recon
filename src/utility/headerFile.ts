import fs from "node:fs";

/** A single private header name/value pair sourced from `--header-file`. Kept as its own type,
 * never merged into `CustomHeaderPair[]` — see `globals.ts`'s `privateHeaders` storage. */
export interface PrivateHeaderPair {
    name: string;
    value: string;
}

export class HeaderFileError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "HeaderFileError";
    }
}

const MAX_HEADER_FILE_BYTES = 272 * 1024;
const MIN_ENTRIES = 1;
const MAX_ENTRIES = 16;
const MAX_NAME_BYTES = 256;
const MAX_VALUE_BYTES = 16_384;

// RFC 7230 token characters — the same grammar HTTP field-names are restricted to.
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const FORBIDDEN_BYTES = [String.fromCharCode(0), String.fromCharCode(13), String.fromCharCode(10)];
const containsForbiddenBytes = (value: string): boolean => FORBIDDEN_BYTES.some((b) => value.includes(b));

/**
 * Parses the decoded text content of a `--header-file`. Pure and side-effect-free: no filesystem
 * access here, only string validation. Fails closed on the first violation found — unlike
 * `targetInputs.ts`'s per-line warn-and-skip convention, a malformed private-header file must never
 * silently drop an entry, since a caller relying on a header actually being sent must be told loudly
 * if it wasn't parsed as expected.
 *
 * Error messages intentionally name only the line number, never the header name, value, or raw line
 * text — this file's whole purpose is to keep those out of every log/error surface.
 */
export const parseHeaderFileContent = (content: string): PrivateHeaderPair[] => {
    // Tolerate a UTF-8 BOM and a single trailing newline (the common "file ends with \n" case)
    // without treating either as a malformed/blank line.
    const withoutBom = content.replace(/^﻿/, "");
    const withoutTrailingNewline = withoutBom.replace(/\r?\n$/, "");

    if (withoutTrailingNewline === "") {
        throw new HeaderFileError("Header file is empty");
    }

    const lines = withoutTrailingNewline.split(/\r?\n/);
    const pairs: PrivateHeaderPair[] = [];
    const seenNames = new Set<string>();

    lines.forEach((line, index) => {
        const lineNumber = index + 1;
        if (line.trim() === "") {
            throw new HeaderFileError(`Header file has a blank line at line ${lineNumber}`);
        }
        if (line.startsWith("#")) {
            throw new HeaderFileError(`Header file has a comment at line ${lineNumber}; comments are not supported`);
        }

        const colonIdx = line.indexOf(":");
        if (colonIdx === -1) {
            throw new HeaderFileError(`Header file line ${lineNumber} is not in "Name: value" format`);
        }
        const name = line.slice(0, colonIdx);
        const rawValue = line.slice(colonIdx + 1);
        const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

        if (name === "" || !TOKEN_RE.test(name)) {
            throw new HeaderFileError(`Header file line ${lineNumber} has an invalid header name`);
        }
        if (containsForbiddenBytes(name) || containsForbiddenBytes(value)) {
            throw new HeaderFileError(`Header file line ${lineNumber} contains a NUL/CR/LF byte`);
        }
        if (value === "") {
            throw new HeaderFileError(`Header file line ${lineNumber} has an empty value`);
        }
        if (Buffer.byteLength(name, "utf8") > MAX_NAME_BYTES) {
            throw new HeaderFileError(`Header file line ${lineNumber} has a header name over ${MAX_NAME_BYTES} bytes`);
        }
        if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) {
            throw new HeaderFileError(`Header file line ${lineNumber} has a value over ${MAX_VALUE_BYTES} bytes`);
        }

        const normalizedName = name.toLowerCase();
        if (seenNames.has(normalizedName)) {
            throw new HeaderFileError(
                `Header file line ${lineNumber} duplicates a header name already defined earlier`
            );
        }
        seenNames.add(normalizedName);
        pairs.push({ name, value });
    });

    if (pairs.length < MIN_ENTRIES || pairs.length > MAX_ENTRIES) {
        throw new HeaderFileError(`Header file must contain between ${MIN_ENTRIES} and ${MAX_ENTRIES} entries`);
    }

    return pairs;
};

const readBoundedHeaderFileBytes = (descriptor: number, filePath: string): Buffer => {
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    while (bytesRead <= MAX_HEADER_FILE_BYTES) {
        const remaining = MAX_HEADER_FILE_BYTES + 1 - bytesRead;
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
        const count = fs.readSync(descriptor, chunk, 0, chunk.length, null);
        if (count === 0) break;
        chunks.push(chunk.subarray(0, count));
        bytesRead += count;
    }
    if (bytesRead > MAX_HEADER_FILE_BYTES) {
        throw new HeaderFileError(`Header file at ${filePath} exceeds the ${MAX_HEADER_FILE_BYTES}-byte size limit`);
    }
    return Buffer.concat(chunks, bytesRead);
};

/**
 * Reads, permission-checks, and parses a `--header-file`. Fails before any network activity — this
 * is called synchronously from the CLI action handler, before `run()` starts. Mirrors the hardened
 * file-open idiom already used for `--config` (`config/applicationConfig.ts`) and `-u`'s target-file
 * branch (`targetInputs.ts`): reject symlinks, open with `O_NOFOLLOW`, verify via `fstat`, and — since
 * a header file is unconditionally secret-bearing, unlike `--config` which only sometimes is — always
 * require owner-only permissions rather than gating on sniffing the content for secret-shaped values.
 */
export const readHeaderFile = (filePath: string): PrivateHeaderPair[] => {
    const noFollowFlag = process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
    let descriptor: number;
    try {
        if (fs.lstatSync(filePath).isSymbolicLink()) {
            throw new HeaderFileError(`Header file at ${filePath} must not be a symbolic link`);
        }
        descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollowFlag);
    } catch (error) {
        if (error instanceof HeaderFileError) throw error;
        if ((error as NodeJS.ErrnoException).code === "ELOOP") {
            throw new HeaderFileError(`Header file at ${filePath} must not be a symbolic link`);
        }
        throw new HeaderFileError(`Unable to open header file at ${filePath}`);
    }

    try {
        const fileStats = fs.fstatSync(descriptor);
        if (!fileStats.isFile()) {
            throw new HeaderFileError(`Header file at ${filePath} must be a regular file`);
        }
        if (fileStats.size > MAX_HEADER_FILE_BYTES) {
            throw new HeaderFileError(
                `Header file at ${filePath} exceeds the ${MAX_HEADER_FILE_BYTES}-byte size limit`
            );
        }
        if (process.platform !== "win32") {
            if ((fileStats.mode & 0o077) !== 0) {
                throw new HeaderFileError(
                    `Header file at ${filePath} must not be readable by group or other users (use chmod 600)`
                );
            }
            if (typeof process.getuid === "function" && fileStats.uid !== process.getuid()) {
                throw new HeaderFileError(`Header file at ${filePath} must be owned by this user`);
            }
        }

        const bytes = readBoundedHeaderFileBytes(descriptor, filePath);
        let text: string;
        try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
            throw new HeaderFileError(`Header file at ${filePath} is not valid UTF-8`);
        }
        return parseHeaderFileContent(text);
    } catch (error) {
        if (error instanceof HeaderFileError) throw error;
        throw new HeaderFileError(`Unable to inspect or read header file at ${filePath}`);
    } finally {
        fs.closeSync(descriptor);
    }
};

/** Normalizes a URL to a `scheme://host:port` origin string (lowercase host, explicit default port),
 * for exact same-origin comparisons. Returns null for non-HTTP(S) or unparseable URLs. */
export const normalizeOrigin = (url: string): string | null => {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}:${port}`;
};

/** Builds the first-party origin allowlist from the explicitly-supplied target URLs. Non-HTTP(S)
 * entries are silently skipped — target resolution has already validated every target is HTTP(S). */
export const buildOriginAllowlist = (urls: readonly string[]): ReadonlySet<string> => {
    const origins = new Set<string>();
    for (const url of urls) {
        const origin = normalizeOrigin(url);
        if (origin) origins.add(origin);
    }
    return origins;
};

/** True when `url`'s origin exactly matches one of the explicitly-supplied target origins. */
export const originAllowed = (url: string, allowlist: ReadonlySet<string>): boolean => {
    const origin = normalizeOrigin(url);
    return origin !== null && allowlist.has(origin);
};
