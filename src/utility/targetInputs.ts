import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import chalk from "chalk";

const MAX_TARGET_FILE_BYTES = 1024 * 1024;
const MAX_TARGETS = 10_000;
const MAX_INPUT_LENGTH = 64 * 1024;

export type TargetInput = string | readonly string[] | null | undefined;

export interface ResolvedTargetInputs {
    readonly targets: readonly string[];
    readonly isBatch: boolean;
}

export class TargetInputError extends Error {
    constructor(
        message: string,
        readonly cause?: unknown
    ) {
        super(message);
        this.name = "TargetInputError";
    }
}

export const collectTargetInput = (value: string, previous?: readonly string[]): string[] => [
    ...(previous ?? []),
    value,
];

const expandHome = (value: string): string => {
    if (value === "~") return os.homedir();
    if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
    return value;
};

const parseHttpUrl = (value: string): URL | null => {
    try {
        const parsed = new URL(value);
        return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
    } catch {
        return null;
    }
};

const redactTarget = (value: string): string => {
    const redacted = value.replace(/([a-z][a-z\d+.-]*:\/\/)[^/@\s]+@/i, "$1***@");
    return redacted.length > 200 ? `${redacted.slice(0, 197)}...` : redacted;
};

const splitUrlList = (value: string): readonly string[] => {
    const pieces = value.split(",").map((entry) => entry.trim());
    const hasSubsequentHttpTarget = /,\s*https?:\/\//i.test(value);
    if (
        pieces.length > 1 &&
        (hasSubsequentHttpTarget || pieces.every((entry) => entry !== "" && parseHttpUrl(entry) !== null))
    ) {
        return pieces;
    }
    return [value];
};

const requireHttpTarget = (value: string, invalidMessage: string): URL => {
    const parsed = parseHttpUrl(value);
    if (!parsed) throw new TargetInputError(invalidMessage);
    if (parsed.username !== "" || parsed.password !== "") {
        throw new TargetInputError(`Target URLs must not include credentials: ${redactTarget(value)}`);
    }
    return parsed;
};

const readBoundedTargetSource = (descriptor: number, filePath: string): string => {
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    while (bytesRead <= MAX_TARGET_FILE_BYTES) {
        const remaining = MAX_TARGET_FILE_BYTES + 1 - bytesRead;
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
        const count = fs.readSync(descriptor, chunk, 0, chunk.length, null);
        if (count === 0) break;
        chunks.push(chunk.subarray(0, count));
        bytesRead += count;
    }
    if (bytesRead > MAX_TARGET_FILE_BYTES) {
        throw new TargetInputError(`Target file ${filePath} exceeds the ${MAX_TARGET_FILE_BYTES}-byte size limit`);
    }
    return Buffer.concat(chunks, bytesRead).toString("utf8");
};

const readTargetFile = (filePath: string): readonly string[] => {
    let descriptor: number;
    const noFollowFlag = process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
    try {
        if (fs.lstatSync(filePath).isSymbolicLink()) {
            throw new TargetInputError(`Target file ${filePath} must not be a symbolic link`);
        }
        descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollowFlag);
    } catch (error) {
        if (error instanceof TargetInputError) throw error;
        if ((error as NodeJS.ErrnoException).code === "ELOOP") {
            throw new TargetInputError(`Target file ${filePath} must not be a symbolic link`, error);
        }
        throw new TargetInputError(`Unable to open target file ${filePath}`, error);
    }

    let source: string;
    try {
        const stats = fs.fstatSync(descriptor);
        if (!stats.isFile()) {
            throw new TargetInputError(`Target path ${filePath} must be a regular file`);
        }
        if (stats.size > MAX_TARGET_FILE_BYTES) {
            throw new TargetInputError(`Target file ${filePath} exceeds the ${MAX_TARGET_FILE_BYTES}-byte size limit`);
        }
        source = readBoundedTargetSource(descriptor, filePath);
    } catch (error) {
        if (error instanceof TargetInputError) throw error;
        throw new TargetInputError(`Unable to inspect or read target file ${filePath}`, error);
    } finally {
        fs.closeSync(descriptor);
    }

    const targets = source.split(/\r?\n/).flatMap((line, index) => {
        const trimmed = (index === 0 ? line.replace(/^\uFEFF/, "") : line).trim();
        if (trimmed === "") return [];
        const entries = splitUrlList(trimmed);
        return entries.filter((entry) => {
            try {
                requireHttpTarget(entry, `Invalid HTTP(S) target in ${filePath}:${index + 1}`);
                return true;
            } catch (error) {
                if (!(error instanceof TargetInputError)) throw error;
                console.warn(chalk.yellow(`[!] ${error.message} \u2014 skipping this target.`));
                return false;
            }
        });
    });
    if (targets.length === 0) {
        throw new TargetInputError(`Target file ${filePath} does not contain any targets`);
    }
    return targets;
};

export const resolveTargetInputs = (input: TargetInput): ResolvedTargetInputs => {
    const rawInputs = (Array.isArray(input) ? input : input == null ? [] : [input]).map((entry) => entry.trim());
    if (rawInputs.length === 0 || rawInputs.every((entry) => entry === "")) {
        throw new TargetInputError("At least one target URL or target file is required");
    }

    let batchInput = rawInputs.length > 1;
    const expandedTargets: string[] = [];
    for (const rawInput of rawInputs) {
        if (rawInput === "") throw new TargetInputError("Target values cannot be empty");
        if (rawInput.length > MAX_INPUT_LENGTH) {
            throw new TargetInputError(`Target input exceeds the ${MAX_INPUT_LENGTH}-character size limit`);
        }

        const possiblePath = expandHome(rawInput);
        if (fs.existsSync(possiblePath)) {
            batchInput = true;
            expandedTargets.push(...readTargetFile(possiblePath));
            continue;
        }

        const entries = splitUrlList(rawInput);
        if (entries.length > 1) batchInput = true;
        for (const entry of entries) {
            requireHttpTarget(entry, `Invalid target URL or file path: ${redactTarget(entry)}`);
            expandedTargets.push(entry);
        }
    }

    const seen = new Set<string>();
    const targets = expandedTargets.filter((target) => {
        const identity = parseHttpUrl(target)!.href;
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
    });
    if (targets.length > MAX_TARGETS) {
        throw new TargetInputError(`Target input exceeds the ${MAX_TARGETS}-target limit`);
    }
    if (targets.length === 0) {
        throw new TargetInputError("No unique HTTP(S) targets were supplied");
    }

    return Object.freeze({ targets: Object.freeze([...targets]), isBatch: batchInput || targets.length > 1 });
};
