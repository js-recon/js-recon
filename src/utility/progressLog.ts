import { printMsg, MSG } from "./printMsg.js";

interface BarLogger {
    log(data: string): void;
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
export const watchBarResize = (bar: any, overhead: number): (() => void) => {
    const handler = () => {
        bar.options.barsize = computeBarSize(overhead);
    };
    process.on("SIGWINCH", handler);
    return () => process.off("SIGWINCH", handler);
};

let activeBarLogger: BarLogger | null = null;

export const setActiveBarLogger = (logger: BarLogger | null): void => {
    activeBarLogger = logger;
};

export const progressLog = (message: string): void => {
    if (activeBarLogger) {
        activeBarLogger.log(message + "\n");
    } else {
        printMsg(MSG.Plain, message);
    }
};

export const progressError = (message: string): void => {
    if (activeBarLogger) {
        activeBarLogger.log(message + "\n");
    } else {
        printMsg(MSG.Err, message);
    }
};

export const progressWarn = (message: string): void => {
    if (activeBarLogger) {
        activeBarLogger.log(message + "\n");
    } else {
        printMsg(MSG.Warn, message);
    }
};
