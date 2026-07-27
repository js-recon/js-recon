import { execSync, spawn } from "child_process";
import path from "path";
import { parse as shellParse } from "shell-quote";
import { printMsg, MSG } from "../utility/printMsg.js";

const isSjInstalled = (sjBin: string): boolean => {
    try {
        execSync(`which ${sjBin}`, { stdio: "pipe" });
        return true;
    } catch {
        return false;
    }
};

export const runSwaggerJacker = (
    mappedOpenapiJsonPath: string,
    sjBin: string,
    sjArgsRaw: string,
    workingDir: string
): Promise<void> => {
    return new Promise((resolve) => {
        if (!isSjInstalled(sjBin)) {
            printMsg(MSG.Err, `[!] ${sjBin} not found in PATH.`);
            printMsg(MSG.Warn, "    Install: go install github.com/BishopFox/sj@latest");
            printMsg(MSG.Warn, "    Then re-run with --sj.");
            process.exit(28);
        }

        printMsg(MSG.Header, "[i] Running sj (swagger-jacker) against the mapped OpenAPI spec");

        const baseArgs = [
            "automate",
            "-l",
            path.resolve(mappedOpenapiJsonPath),
            "--force",
            "-q",
            "-F",
            "json",
            "-o",
            "swagger-jacker-results.json",
        ];
        const extraArgs = shellParse(sjArgsRaw).filter((token): token is string => typeof token === "string");
        const args = [...baseArgs, ...extraArgs];

        const proc = spawn(sjBin, args, {
            cwd: workingDir,
            stdio: ["ignore", "pipe", "pipe"],
        });

        proc.stdout.on("data", (chunk: Buffer) => {
            const msg = chunk.toString().trim();
            if (msg) {
                printMsg(MSG.Run, `[sj] ${msg}`);
            }
        });

        proc.stderr.on("data", (chunk: Buffer) => {
            const msg = chunk.toString().trim();
            if (msg) {
                printMsg(MSG.Warn, `[sj] ${msg}`);
            }
        });

        proc.on("close", (code) => {
            if (code === 0) {
                printMsg(MSG.Run, "[✓] sj run complete");
            } else {
                printMsg(MSG.Warn, `[!] sj exited with code ${code}`);
            }
            resolve();
        });
    });
};
