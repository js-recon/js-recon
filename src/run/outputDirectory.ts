import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toOutputHost } from "../lazyLoad/outputPath.js";

const MAX_OUTPUT_SUFFIX = 10_000;
const RUN_LOCK_FILENAME = ".js-recon.lock";
const RUN_OWNER_FILENAME = ".js-recon-output";
const RUN_OWNER_CONTENT = "js-recon output directory v1\n";

interface ReservationMetadata {
    readonly version: 1;
    readonly pid: number;
    readonly hostname: string;
    readonly createdAt: string;
    readonly token: string;
}

const activeReleases = new Set<() => void>();
const terminationHandlers = new Map<NodeJS.Signals, () => void>();

export interface ReservedRunOutputDirectory {
    readonly path: string;
    readonly redirected: boolean;
    readonly occupied: boolean;
    readonly release: () => void;
}

export class RunOutputDirectoryError extends Error {
    constructor(
        message: string,
        readonly cause?: unknown
    ) {
        super(message);
        this.name = "RunOutputDirectoryError";
    }
}

const canonicalizePath = (resolved: string): string => {
    const missingSegments: string[] = [];
    let cursor = resolved;
    while (true) {
        try {
            return path.join(fs.realpathSync(cursor), ...missingSegments.reverse());
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw new RunOutputDirectoryError(`Unable to resolve output path ${resolved}`, error);
            }
            const parent = path.dirname(cursor);
            if (parent === cursor) throw new RunOutputDirectoryError(`Unable to resolve output path ${resolved}`);
            missingSegments.push(path.basename(cursor));
            cursor = parent;
        }
    }
};

const assertUnprotectedDirectory = (resolved: string): void => {
    if (resolved === path.parse(resolved).root) {
        throw new RunOutputDirectoryError("The filesystem root cannot be used as an output directory");
    }
    const workingDirectory = fs.realpathSync(process.cwd());
    if (resolved === workingDirectory) {
        throw new RunOutputDirectoryError(
            "Refusing to clear the current working directory; choose a dedicated output directory"
        );
    }
    const relativeToWorkingDirectory = path.relative(resolved, workingDirectory);
    const isWorkingDirectoryAncestor =
        relativeToWorkingDirectory !== "" &&
        relativeToWorkingDirectory !== ".." &&
        !relativeToWorkingDirectory.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relativeToWorkingDirectory);
    const homeDirectory = canonicalizePath(path.resolve(os.homedir()));
    const temporaryDirectory = canonicalizePath(path.resolve(os.tmpdir()));
    if (resolved === homeDirectory || resolved === temporaryDirectory || isWorkingDirectoryAncestor) {
        throw new RunOutputDirectoryError(
            `Refusing to clear protected directory ${resolved}; choose a dedicated output directory`
        );
    }
};

const assertSafeDedicatedDirectory = (directory: string): string => {
    const resolved = path.resolve(directory);
    assertUnprotectedDirectory(resolved);
    const canonical = canonicalizePath(resolved);
    assertUnprotectedDirectory(canonical);
    return canonical;
};

const rejectFinalSymlink = (directory: string): void => {
    try {
        if (fs.lstatSync(directory).isSymbolicLink()) {
            throw new RunOutputDirectoryError(`Output path ${directory} must not be a symbolic link`);
        }
    } catch (error) {
        if (error instanceof RunOutputDirectoryError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw new RunOutputDirectoryError(`Unable to inspect output path ${directory}`, error);
        }
    }
};

const inspectDirectory = (directory: string): "missing" | "empty" | "occupied" | "not-directory" | "symbolic-link" => {
    try {
        const stats = fs.lstatSync(directory);
        if (stats.isSymbolicLink()) return "symbolic-link";
        if (!stats.isDirectory()) return "not-directory";
        const entries = fs.readdirSync(directory);
        const hasOnlyOwnerMarker =
            entries.length === 1 && entries[0] === RUN_OWNER_FILENAME && hasValidOwnerMarker(directory);
        return entries.length === 0 || hasOnlyOwnerMarker ? "empty" : "occupied";
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
        throw new RunOutputDirectoryError(`Unable to inspect output directory ${directory}`, error);
    }
};

const hasValidOwnerMarker = (directory: string): boolean => {
    const markerPath = path.join(directory, RUN_OWNER_FILENAME);
    try {
        const stats = fs.lstatSync(markerPath);
        return !stats.isSymbolicLink() && stats.isFile() && fs.readFileSync(markerPath, "utf8") === RUN_OWNER_CONTENT;
    } catch {
        return false;
    }
};

const ensureOwnerMarker = (directory: string): void => {
    if (hasValidOwnerMarker(directory)) return;
    const markerPath = path.join(directory, RUN_OWNER_FILENAME);
    let descriptor: number;
    try {
        descriptor = fs.openSync(markerPath, "wx", 0o600);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST" && hasValidOwnerMarker(directory)) return;
        throw new RunOutputDirectoryError(`Unable to establish js-recon ownership of ${directory}`, error);
    }
    try {
        fs.writeFileSync(descriptor, RUN_OWNER_CONTENT, "utf8");
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
};

const isProcessAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
};

const parseReservationMetadata = (source: string): ReservationMetadata | null => {
    try {
        const value = JSON.parse(source) as Partial<ReservationMetadata>;
        if (
            value.version !== 1 ||
            !Number.isSafeInteger(value.pid) ||
            Number(value.pid) <= 0 ||
            typeof value.hostname !== "string" ||
            typeof value.createdAt !== "string" ||
            typeof value.token !== "string" ||
            value.token === ""
        ) {
            return null;
        }
        return value as ReservationMetadata;
    } catch {
        return null;
    }
};

const reclaimStaleReservation = (directory: string): void => {
    const lockPath = path.join(directory, RUN_LOCK_FILENAME);
    let source: string;
    try {
        const stats = fs.lstatSync(lockPath);
        if (stats.isSymbolicLink() || !stats.isFile()) return;
        source = fs.readFileSync(lockPath, "utf8");
    } catch {
        return;
    }
    const metadata = parseReservationMetadata(source);
    if (!metadata || metadata.hostname !== os.hostname() || isProcessAlive(metadata.pid)) return;
    try {
        if (fs.readFileSync(lockPath, "utf8") === source) fs.unlinkSync(lockPath);
    } catch {
        // A concurrent owner won the race or cleanup failed; acquisition remains safely blocked.
    }
};

const removeTerminationHandlers = (): void => {
    if (activeReleases.size > 0) return;
    for (const [signal, handler] of terminationHandlers) process.removeListener(signal, handler);
    terminationHandlers.clear();
};

const installTerminationHandlers = (): void => {
    if (terminationHandlers.size > 0) return;
    for (const signal of ["SIGHUP", "SIGTERM"] as const) {
        const handler = (): void => {
            for (const release of [...activeReleases].reverse()) release();
            removeTerminationHandlers();
            process.exit(signal === "SIGTERM" ? 143 : 129);
        };
        terminationHandlers.set(signal, handler);
        process.once(signal, handler);
    }
};

const reserveMissingDirectory = (directory: string): boolean => {
    try {
        fs.mkdirSync(directory);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw new RunOutputDirectoryError(`Unable to create output directory ${directory}`, error);
    }
};

const acquireReservation = (
    directory: string,
    redirected: boolean,
    occupied: boolean
): ReservedRunOutputDirectory | null => {
    const lockPath = path.join(directory, RUN_LOCK_FILENAME);
    const metadata: ReservationMetadata = Object.freeze({
        version: 1,
        pid: process.pid,
        hostname: os.hostname(),
        createdAt: new Date().toISOString(),
        token: randomUUID(),
    });
    const lockContents = `${JSON.stringify(metadata)}\n`;
    let descriptor: number;
    try {
        descriptor = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
        throw new RunOutputDirectoryError(`Unable to reserve output directory ${directory}`, error);
    }
    try {
        try {
            fs.writeFileSync(descriptor, lockContents, "utf8");
            fs.fsyncSync(descriptor);
        } finally {
            fs.closeSync(descriptor);
        }
    } catch (error) {
        try {
            fs.unlinkSync(lockPath);
        } catch {
            // Preserve the reservation initialization failure below.
        }
        throw new RunOutputDirectoryError(`Unable to initialize output reservation ${directory}`, error);
    }

    let released = false;
    const finishRelease = (): void => {
        released = true;
        activeReleases.delete(release);
        process.removeListener("exit", release);
        removeTerminationHandlers();
    };
    const release = (): void => {
        if (released) return;
        try {
            const stats = fs.lstatSync(lockPath);
            if (stats.isSymbolicLink() || !stats.isFile() || fs.readFileSync(lockPath, "utf8") !== lockContents) {
                finishRelease();
                return;
            }
            fs.unlinkSync(lockPath);
            finishRelease();
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") finishRelease();
            // Other cleanup errors remain registered for exit/signal retry and stale-owner recovery.
        }
    };
    activeReleases.add(release);
    process.once("exit", release);
    installTerminationHandlers();
    return Object.freeze({ path: directory, redirected, occupied, release });
};

export const reserveRunOutputDirectory = (
    preferredDirectory: string,
    overwrite: boolean
): ReservedRunOutputDirectory => {
    if (typeof preferredDirectory !== "string" || preferredDirectory.trim() === "") {
        throw new RunOutputDirectoryError("Output directory must be a non-empty path");
    }

    const requested = path.resolve(preferredDirectory);
    if (overwrite) rejectFinalSymlink(requested);
    const preferred = overwrite ? assertSafeDedicatedDirectory(requested) : requested;
    if (preferred === path.parse(preferred).root) {
        throw new RunOutputDirectoryError("The filesystem root cannot be used as an output directory");
    }

    try {
        fs.mkdirSync(path.dirname(preferred), { recursive: true });
    } catch (error) {
        throw new RunOutputDirectoryError(`Unable to create parent directory for ${preferred}`, error);
    }

    reclaimStaleReservation(preferred);
    const preferredState = inspectDirectory(preferred);
    if (preferredState === "symbolic-link" && overwrite) {
        throw new RunOutputDirectoryError(`Output path ${preferred} must not be a symbolic link`);
    }
    if (preferredState === "not-directory") {
        if (overwrite) throw new RunOutputDirectoryError(`Output path ${preferred} must be a directory`);
    } else if (preferredState === "empty" || (overwrite && preferredState === "occupied")) {
        if (preferredState === "occupied" && !hasValidOwnerMarker(preferred)) {
            throw new RunOutputDirectoryError(
                `Refusing to overwrite unowned directory ${preferred}; choose a js-recon output directory`
            );
        }
        ensureOwnerMarker(preferred);
        const reservation = acquireReservation(preferred, false, preferredState === "occupied");
        if (reservation) return reservation;
        if (overwrite) {
            throw new RunOutputDirectoryError(`Output directory ${preferred} is already reserved by another run`);
        }
    } else if (preferredState === "missing" && reserveMissingDirectory(preferred)) {
        ensureOwnerMarker(preferred);
        const reservation = acquireReservation(preferred, false, false);
        if (reservation) return reservation;
    }

    for (let suffix = 2; suffix <= MAX_OUTPUT_SUFFIX; suffix += 1) {
        const candidate = `${preferred}-${suffix}`;
        reclaimStaleReservation(candidate);
        const state = inspectDirectory(candidate);
        if (state === "empty") {
            ensureOwnerMarker(candidate);
            const reservation = acquireReservation(candidate, true, false);
            if (reservation) return reservation;
        }
        if (state === "missing" && reserveMissingDirectory(candidate)) {
            ensureOwnerMarker(candidate);
            const reservation = acquireReservation(candidate, true, false);
            if (reservation) return reservation;
        }
    }
    throw new RunOutputDirectoryError(
        `Unable to reserve an output directory after ${MAX_OUTPUT_SUFFIX - 1} attempts for ${preferred}`
    );
};

/** Removes only the contents of a validated output directory, preserving the directory itself. */
export const clearRunOutputDirectory = (directory: string): void => {
    const requested = path.resolve(directory);
    rejectFinalSymlink(requested);
    const resolved = assertSafeDedicatedDirectory(requested);
    let stats: fs.Stats;
    try {
        stats = fs.lstatSync(resolved);
    } catch (error) {
        throw new RunOutputDirectoryError(`Unable to inspect output directory ${resolved}`, error);
    }
    if (stats.isSymbolicLink()) {
        throw new RunOutputDirectoryError(`Output path ${resolved} must not be a symbolic link`);
    }
    if (!stats.isDirectory()) {
        throw new RunOutputDirectoryError(`Output path ${resolved} must be a directory`);
    }
    if (!hasValidOwnerMarker(resolved)) {
        throw new RunOutputDirectoryError(
            `Refusing to clear unowned directory ${resolved}; choose a js-recon output directory`
        );
    }

    try {
        for (const entry of fs.readdirSync(resolved)) {
            if (entry === RUN_LOCK_FILENAME || entry === RUN_OWNER_FILENAME) continue;
            fs.rmSync(path.join(resolved, entry), { recursive: true, force: true });
        }
    } catch (error) {
        throw new RunOutputDirectoryError(`Unable to clear output directory ${resolved}`, error);
    }
};

export const getBatchTargetDirectoryName = (target: string, disambiguate: boolean): string => {
    const parsed = new URL(target);
    const host = toOutputHost(parsed.host);
    if (!disambiguate) return host;
    const digest = createHash("sha256").update(parsed.href).digest("hex").slice(0, 12);
    return `${host}--${digest}`;
};
