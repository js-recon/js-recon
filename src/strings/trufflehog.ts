import { execSync, spawn } from "child_process";
import inquirer from "inquirer";
import { printMsg, MSG } from "../utility/printMsg.js";
import { downloadTrufflehog } from "./trufflehogDownload.js";
import { isConsentGiven, giveConsent } from "./trufflehogConfig.js";

const isTrufflehogInstalled = (bin: string): boolean => {
    try {
        execSync(`which ${bin}`, { stdio: "pipe" });
        return true;
    } catch {
        return false;
    }
};

/**
 * Resolves the trufflehog binary to invoke: an explicit `--trufflehog-bin`/PATH binary if
 * present, otherwise auto-downloads from TruffleHog's official GitHub releases after
 * obtaining one-time consent (interactive prompt, or `--trufflehog-accept-terms` for CI).
 */
const resolveTrufflehogBin = async (trufflehogBin: string, acceptTerms: boolean): Promise<string> => {
    if (isTrufflehogInstalled(trufflehogBin)) {
        return trufflehogBin;
    }

    if (!isConsentGiven()) {
        if (acceptTerms) {
            giveConsent();
        } else if (process.stdin.isTTY) {
            printMsg(MSG.Header, "[i] --trufflehog was set but the trufflehog binary was not found.");
            printMsg(
                MSG.Warn,
                "    JS Recon can download it directly from trufflesecurity/trufflehog's official GitHub releases"
            );
            printMsg(MSG.Warn, "    and run it as a separate process. TruffleHog is licensed under AGPL-3.0.");
            const { confirmed } = await inquirer.prompt([
                {
                    type: "confirm",
                    name: "confirmed",
                    message: "Download and run TruffleHog?",
                    default: true,
                },
            ]);
            if (!confirmed) {
                printMsg(MSG.Err, "[!] TruffleHog download declined.");
                printMsg(
                    MSG.Warn,
                    "    Re-run with --trufflehog-accept-terms, or point --trufflehog-bin at an existing install."
                );
                process.exit(32);
            }
            giveConsent();
        } else {
            printMsg(MSG.Err, "[!] trufflehog not found and terms not accepted.");
            printMsg(
                MSG.Warn,
                "    Re-run with --trufflehog-accept-terms to allow auto-download in non-interactive contexts,"
            );
            printMsg(MSG.Warn, "    or point --trufflehog-bin at an existing install.");
            process.exit(32);
        }
    }

    return downloadTrufflehog(process.env.HOME || "~");
};

const maskSecret = (value: string): string => {
    if (!value || value.length <= 4) return "****";
    return value.slice(0, 4) + "****";
};

export const runTrufflehog = async (
    directory: string,
    trufflehogBin: string = "trufflehog",
    acceptTerms: boolean = false
): Promise<void> => {
    const resolvedBin = await resolveTrufflehogBin(trufflehogBin, acceptTerms);

    return new Promise((resolve) => {
        printMsg(MSG.Header, "[i] Running TruffleHog on output directory");

        const proc = spawn(resolvedBin, ["filesystem", directory, "--json", "--no-update"], {
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
