import chalk from "chalk";
import { Chunks } from "../../../../utility/interfaces.js";

const vueCommandHelpers = {
    /**
     * Lists every distinct source file referenced by chunks, with the number of
     * chunks per file. Useful for navigating a Vite build directory-by-directory.
     */
    listFiles: (chunks: Chunks): string => {
        const counts = new Map<string, number>();
        for (const chunk of Object.values(chunks)) {
            counts.set(chunk.file, (counts.get(chunk.file) ?? 0) + 1);
        }
        let returnText = chalk.cyan(`List of files (${counts.size})\n`);
        const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        for (const [file, count] of sorted) {
            returnText += chalk.green(`- ${file}`) + chalk.gray(` (${count} chunk${count === 1 ? "" : "s"})\n`);
        }
        return returnText;
    },

    /**
     * Lists every chunk that originates from a given file.
     */
    listFunctionsInFile: (chunks: Chunks, file: string): string => {
        if (!file) {
            return chalk.red("[!] Missing file argument");
        }
        const matches = Object.values(chunks).filter((c) => c.file === file);
        if (matches.length === 0) {
            return chalk.yellow(`No chunks found for file ${file}`);
        }
        let returnText = chalk.cyan(`Chunks in ${file} (${matches.length})\n`);
        for (const chunk of matches) {
            returnText += chalk.green(`- ${chunk.id}: ${chunk.description}\n`);
        }
        return returnText;
    },
};

export default vueCommandHelpers;
