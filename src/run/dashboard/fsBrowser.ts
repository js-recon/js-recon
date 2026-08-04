import fs from "fs";
import path from "path";

export interface FileTreeEntry {
    name: string;
    type: "file" | "directory";
    path: string;
    children?: FileTreeEntry[];
}

/**
 * Resolves a user-supplied relative path against a target's output directory,
 * rejecting anything that escapes it (path traversal via `../`, absolute paths, etc).
 * Returns null if the resolved path is outside `baseDir`.
 */
export const resolveSafePath = (baseDir: string, relativePath: string): string | null => {
    const resolvedBase = path.resolve(baseDir);
    const resolved = path.resolve(resolvedBase, relativePath || ".");
    if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + path.sep)) {
        return null;
    }
    return resolved;
};

/**
 * Recursively builds a file tree for the dashboard's per-target file browser.
 */
export const buildFileTree = (baseDir: string, dir: string = baseDir): FileTreeEntry[] => {
    if (!fs.existsSync(dir)) return [];

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries
        .map((entry) => {
            const fullPath = path.join(dir, entry.name);
            const relativePath = path.relative(baseDir, fullPath).split(path.sep).join("/");
            if (entry.isDirectory()) {
                return {
                    name: entry.name,
                    type: "directory" as const,
                    path: relativePath,
                    children: buildFileTree(baseDir, fullPath),
                };
            }
            return { name: entry.name, type: "file" as const, path: relativePath };
        })
        .sort((a, b) => {
            if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
};
