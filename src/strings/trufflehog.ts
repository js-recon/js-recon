import { execSync, spawn } from "child_process";
import { printMsg, MSG } from "../utility/printMsg.js";

const isTrufflehogInstalled = (): boolean => {
    try {
        execSync("which trufflehog", { stdio: "pipe" });
        return true;
    } catch {
        return false;
    }
};

const maskSecret = (value: string): string => {
    if (!value || value.length <= 4) return "****";
    return value.slice(0, 4) + "****";
};

export const runTrufflehog = (directory: string): Promise<void> => {
    return new Promise((resolve) => {
        if (!isTrufflehogInstalled()) {
            printMsg(MSG.Err, "[!] trufflehog not found in PATH.");
            printMsg(
                MSG.Warn,
                "    Install: curl -sSfL https://raw.githubusercontent.com/trufflesecurity/trufflehog/main/scripts/install.sh | sh"
            );
            printMsg(MSG.Warn, "    Or: brew install trufflehog");
            printMsg(MSG.Warn, "    Then re-run with --trufflehog.");
            process.exit(1);
        }

        printMsg(MSG.Header, "[i] Running TruffleHog on output directory");

        const proc = spawn("trufflehog", ["filesystem", directory, "--json", "--no-update"], {
            stdio: ["ignore", "pipe", "pipe"],
        });

        let totalFindings = 0;
        let buffer = "";

        proc.stdout.on("data", (chunk: Buffer) => {
            buffer += chunk.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const finding = JSON.parse(line);
                    const detector = finding.DetectorName ?? finding.detectorName ?? "Unknown";
                    const raw = finding.Raw ?? finding.raw ?? "";
                    const file =
                        finding.SourceMetadata?.Data?.Filesystem?.file ??
                        finding.sourceMetadata?.data?.filesystem?.file ??
                        "unknown file";
                    printMsg(MSG.Run, `[✓] [trufflehog] ${detector} found in ${file}`);
                    printMsg(MSG.Run, `  → ${maskSecret(raw)}`);
                    totalFindings++;
                } catch {
                    // not valid JSON, skip
                }
            }
        });

        proc.stderr.on("data", (chunk: Buffer) => {
            const msg = chunk.toString().trim();
            if (msg) {
                printMsg(MSG.Warn, `[trufflehog] ${msg}`);
            }
        });

        proc.on("close", () => {
            if (totalFindings === 0) {
                printMsg(MSG.Warn, "[!] TruffleHog found no secrets");
            } else {
                printMsg(MSG.Run, `[✓] TruffleHog found ${totalFindings} secrets`);
            }
            resolve();
        });
    });
};
