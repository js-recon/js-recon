import fs from "fs";
import path from "path";

/** Files under `dir` (recursively) ending in one of `extensions`, skipping hidden entries such as `.github`. */
export const listFilesRecursive = (dir: string, extensions: string[]): string[] => {
    let results: string[] = [];
    for (const entry of fs.readdirSync(dir)) {
        if (entry.startsWith(".")) continue;
        const file = path.join(dir, entry);
        if (fs.statSync(file).isDirectory()) results = results.concat(listFilesRecursive(file, extensions));
        else if (extensions.some((e) => file.endsWith(e))) results.push(file);
    }
    return results;
};

/** The `.js`/`.mjs` files under a downloaded-JS directory, relative to it and sorted, without `___subsequent_requests`. */
export const listJsFiles = (directory: string): string[] =>
    (fs.readdirSync(directory, { recursive: true, encoding: "utf8" }) as string[])
        .filter((f) => (f.endsWith(".js") || f.endsWith(".mjs")) && !f.includes("___subsequent_requests"))
        .filter((f) => !fs.lstatSync(path.join(directory, f)).isDirectory())
        .sort();
