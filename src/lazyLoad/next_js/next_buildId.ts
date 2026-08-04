import { readdir, readFile } from "fs/promises";
import path from "path";
import * as next_globals from "./next_globals.js";
import { Dirent } from "fs";
import { printMsg, MSG } from "../../utility/printMsg.js";

export const next_buildId_RSC = async (rsc_directory: string): Promise<string | null> => {
    const traverseDirectory = async (directory: string): Promise<boolean> => {
        let dirents: Dirent<string>[];
        try {
            dirents = await readdir(directory, { withFileTypes: true });
        } catch {
            printMsg(
                MSG.Err,
                `[!] Can't read subsequent requests directory. Skipping build ID extraction using this method...`
            );
            return false;
        }

        for (const dirent of dirents) {
            const fullPath = path.join(directory, dirent.name);

            if (dirent.isDirectory()) {
                if (await traverseDirectory(fullPath)) {
                    return true;
                }
                continue;
            }

            if (!dirent.isFile()) {
                continue;
            }

            const fileContent = await readFile(fullPath, "utf8");

            const lines = fileContent.split("\n");
            for (const line of lines) {
                if (line.startsWith("0:")) {
                    const buildIdLine = line.replace("0:", "");
                    const buildIdLineJSON = JSON.parse(buildIdLine);

                    for (const [key, value] of Object.entries(buildIdLineJSON)) {
                        if (key === "b") {
                            next_globals.setBuildId(value as string);
                            return true;
                        }
                    }
                }
            }
        }

        return false;
    };

    await traverseDirectory(rsc_directory);
    return next_globals.getBuildId();
};
