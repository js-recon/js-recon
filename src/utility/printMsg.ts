import chalk from "chalk";

export enum MSG {
    Err = "Err",
    Warn = "Warn",
    Info = "Info",
    Run = "Run",
    Header = "Header",
    Plain = "Plain",
}

const COLOR: Record<MSG, (s: string) => string> = {
    [MSG.Err]: chalk.red,
    [MSG.Warn]: chalk.yellow,
    [MSG.Info]: chalk.dim,
    [MSG.Run]: chalk.green,
    [MSG.Header]: chalk.bold.cyan,
    [MSG.Plain]: (s: string) => s,
};

let locked = false;

/**
 * While locked, printMsg() silently discards messages instead of printing them.
 * Used to swallow stray output from orphaned in-flight steps while the
 * Ctrl-C interrupt menu is being shown/answered (see run/interruptHandler.ts).
 */
export const lockPrintMsg = (): void => {
    locked = true;
};

export const unlockPrintMsg = (): void => {
    locked = false;
};

export const printMsg = (level: MSG, message: string): void => {
    if (locked) return;

    const output = COLOR[level](message);

    if (level === MSG.Err || level === MSG.Warn) {
        console.error(output);
    } else {
        console.log(output);
    }
};
