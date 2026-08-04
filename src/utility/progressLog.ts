import type { Options, SingleBar } from "cli-progress";
import { printMsg, MSG } from "./printMsg.js";

interface BarLogger {
    log(data: string): void;
}

interface ActiveBarLogger {
    readonly token: symbol;
    readonly logger: BarLogger;
}

type ResizeOptions = Partial<
    Pick<Options, "barsize" | "barCompleteChar" | "barCompleteString" | "barIncompleteChar" | "barIncompleteString">
>;

export interface ResizableProgressBar {
    readonly options?: ResizeOptions;
}

/**
 * Computes a progress bar width that fits within the current terminal.
 * @param formatOverhead Total visible characters in the format string excluding the bar itself
 *                       (label before `[{bar}]` + stats after `[{bar}]` + surrounding brackets).
 */
export const computeBarSize = (formatOverhead: number): number => {
    const cols = process.stdout.columns || 80;
    return Math.max(10, cols - formatOverhead);
};

/**
 * Registers a SIGWINCH listener that keeps `bar.options.barsize` in sync with
 * the terminal width for the lifetime of the bar. Call the returned cleanup
 * function when the bar stops.
 */
export const watchBarResize = (bar: SingleBar | ResizableProgressBar, overhead: number): (() => void) => {
    // cli-progress exposes these options at runtime but omits them from the
    // public SingleBar declaration. Keep that implementation detail contained
    // here rather than weakening callers to `any`.
    const options = (bar as ResizableProgressBar).options;
    const handler = () => {
        if (!options) return;
        const barsize = computeBarSize(overhead);
        options.barsize = barsize;

        // cli-progress precomputes these strings when the bar is created. Keep
        // them in sync or a wider terminal would still render the old width.
        if (typeof options.barCompleteChar === "string") {
            options.barCompleteString = options.barCompleteChar.repeat(barsize + 1);
        }
        if (typeof options.barIncompleteChar === "string") {
            options.barIncompleteString = options.barIncompleteChar.repeat(barsize + 1);
        }
    };
    process.on("SIGWINCH", handler);
    return () => process.off("SIGWINCH", handler);
};

let activeBarLoggers: ReadonlyArray<ActiveBarLogger> = [];

/**
 * Routes progress-aware output through `logger` until the returned cleanup is
 * called. Activations may be nested; releasing an inner logger restores the
 * previous one, and each idempotent cleanup removes only the scope it owns.
 */
export const activateBarLogger = (logger: BarLogger, enabled: boolean = true): (() => void) => {
    if (!enabled) return () => undefined;

    const token = Symbol("activeBarLogger");
    activeBarLoggers = [...activeBarLoggers, { token, logger }];

    return () => {
        activeBarLoggers = activeBarLoggers.filter((entry) => entry.token !== token);
    };
};

/** Attempts every progress cleanup step without replacing the work error. */
export const cleanupProgressResources = (...cleanupSteps: ReadonlyArray<() => void>): void => {
    for (const cleanup of cleanupSteps) {
        try {
            cleanup();
        } catch {
            // Cleanup is best-effort: later steps must still restore the
            // logger, signal listener, and terminal state.
        }
    }
};

/** Runs async progress work and always releases its terminal resources. */
export const withProgressResources = async <T>(
    work: () => Promise<T>,
    ...cleanupSteps: ReadonlyArray<() => void>
): Promise<T> => {
    try {
        return await work();
    } finally {
        cleanupProgressResources(...cleanupSteps);
    }
};

const getActiveBarLogger = (): BarLogger | undefined => activeBarLoggers[activeBarLoggers.length - 1]?.logger;

export const progressLog = (message: string): void => {
    const activeBarLogger = getActiveBarLogger();
    if (activeBarLogger) {
        activeBarLogger.log(message + "\n");
    } else {
        printMsg(MSG.Plain, message);
    }
};

export const progressError = (message: string): void => {
    const activeBarLogger = getActiveBarLogger();
    if (activeBarLogger) {
        activeBarLogger.log(message + "\n");
    } else {
        printMsg(MSG.Err, message);
    }
};

export const progressWarn = (message: string): void => {
    const activeBarLogger = getActiveBarLogger();
    if (activeBarLogger) {
        activeBarLogger.log(message + "\n");
    } else {
        printMsg(MSG.Warn, message);
    }
};
