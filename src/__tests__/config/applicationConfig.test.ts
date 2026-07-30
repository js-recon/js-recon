import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDocument } from "yaml";
import {
    ApplicationConfigError,
    buildDefaultApplicationConfig,
    getDefaultApplicationConfigPath,
    getLoadedApplicationConfig,
    prepareProgramConfiguration,
} from "../../config/applicationConfig.js";

const temporaryDirectories: string[] = [];

const makeTemporaryDirectory = (): string => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "js-recon-config-test-"));
    temporaryDirectories.push(directory);
    return directory;
};

const makeProgram = (capture?: (options: Record<string, unknown>) => void): Command => {
    const program = new Command().exitOverride().option("--config <file>", "Application YAML config");
    program
        .command("scan")
        .requiredOption("--url <url>")
        .option("--threads <threads>", "Worker count", "1")
        .option("--feature", "Enable feature", false)
        .option("--no-sandbox", "Disable sandbox")
        .option(
            "--command <command>",
            "Repeatable command",
            (value: string, previous: string[]) => [...previous, value],
            [] as string[]
        )
        .action((options) => capture?.(options));
    return program;
};

afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe("application YAML configuration", () => {
    it("uses ~/.config/js-recon/config.yaml as the default path", () => {
        expect(getDefaultApplicationConfigPath("/home/operator")).toBe("/home/operator/.config/js-recon/config.yaml");
    });

    it("creates a complete, restrictive default file without overwriting it", () => {
        const root = makeTemporaryDirectory();
        const configPath = path.join(root, ".config", "js-recon", "config.yaml");
        const program = makeProgram();

        prepareProgramConfiguration(program, {
            argv: ["node", "js-recon", "scan"],
            env: {},
            defaultConfigPath: configPath,
        });

        expect(fs.existsSync(configPath)).toBe(true);
        expect(fs.statSync(path.dirname(configPath)).mode & 0o777).toBe(0o700);
        expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
        const document = parseDocument(fs.readFileSync(configPath, "utf8"));
        expect(document.errors).toEqual([]);
        expect(document.toJS()).toMatchObject({
            version: 1,
            oxylabs: { username: null, password: null, country: null },
            commands: {
                scan: {
                    url: null,
                    threads: "1",
                    feature: false,
                    sandbox: true,
                    command: [],
                },
            },
        });

        fs.writeFileSync(configPath, "version: 1\ncommands: {}\n");
        const writeSpy = vi.spyOn(fs, "writeFileSync");
        const chmodSpy = vi.spyOn(fs, "chmodSync");
        prepareProgramConfiguration(makeProgram(), {
            argv: ["node", "js-recon", "scan"],
            env: {},
            defaultConfigPath: configPath,
        });
        expect(fs.readFileSync(configPath, "utf8")).toBe("version: 1\ncommands: {}\n");
        expect(writeSpy).not.toHaveBeenCalled();
        expect(chmodSpy).not.toHaveBeenCalled();
    });

    it("does not leave a truncated default config when its initial write fails", () => {
        const root = makeTemporaryDirectory();
        const configPath = path.join(root, ".config", "js-recon", "config.yaml");
        const writeError = Object.assign(new Error("disk full"), { code: "ENOSPC" });
        vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
            throw writeError;
        });

        expect(() =>
            prepareProgramConfiguration(makeProgram(), {
                argv: ["node", "js-recon", "scan"],
                env: {},
                defaultConfigPath: configPath,
            })
        ).toThrow(/Unable to create default config/);

        expect(fs.existsSync(configPath)).toBe(false);
        expect(fs.readdirSync(path.dirname(configPath))).toEqual([]);
    });

    it("generates a key for every declared command option", () => {
        const defaults = buildDefaultApplicationConfig(makeProgram());
        expect(Object.keys(defaults.commands.scan).sort()).toEqual(["command", "feature", "sandbox", "threads", "url"]);
    });

    it("applies environment over CLI over YAML while preserving false values", () => {
        const root = makeTemporaryDirectory();
        const defaultConfigPath = path.join(root, "default", "config.yaml");
        const explicitConfigPath = path.join(root, "operator.yaml");
        fs.writeFileSync(
            explicitConfigPath,
            [
                "version: 1",
                "commands:",
                "  scan:",
                "    url: https://config.example.test",
                "    threads: 2",
                "    feature: true",
                "    sandbox: false",
                "    command:",
                "      - from-config",
                "",
            ].join("\n")
        );
        let captured: Record<string, unknown> | undefined;
        const program = makeProgram((options) => {
            captured = options;
        });
        const argv = [
            "node",
            "js-recon",
            "--config",
            explicitConfigPath,
            "scan",
            "--threads",
            "3",
            "--feature",
            "--command",
            "from-cli",
        ];

        prepareProgramConfiguration(program, {
            argv,
            env: {
                JS_RECON_SCAN_THREADS: "4",
                JS_RECON_SCAN_FEATURE: "false",
            },
            defaultConfigPath,
        });
        program.parse(argv);

        expect(captured).toEqual({
            url: "https://config.example.test",
            threads: "4",
            feature: false,
            sandbox: false,
            command: ["from-cli"],
        });
        expect(getLoadedApplicationConfig()).toMatchObject({
            path: explicitConfigPath,
            source: "cli",
            explicitlySupplied: true,
        });
    });

    it("uses JS_RECON_CONFIG ahead of --config", () => {
        const root = makeTemporaryDirectory();
        const defaultConfigPath = path.join(root, "default.yaml");
        const cliPath = path.join(root, "cli.yaml");
        const envPath = path.join(root, "env.yaml");
        fs.writeFileSync(cliPath, "version: 1\ncommands:\n  scan:\n    url: https://cli.example.test\n");
        fs.writeFileSync(envPath, "version: 1\ncommands:\n  scan:\n    url: https://env.example.test\n");
        let captured: Record<string, unknown> | undefined;
        const program = makeProgram((options) => {
            captured = options;
        });
        const argv = ["node", "js-recon", "--config", cliPath, "scan"];

        prepareProgramConfiguration(program, {
            argv,
            env: { JS_RECON_CONFIG: envPath },
            defaultConfigPath,
        });
        program.parse(argv);

        expect(captured?.url).toBe("https://env.example.test");
        expect(getLoadedApplicationConfig()).toMatchObject({ path: envPath, source: "env" });
        expect(program.opts().config).toBe(envPath);
    });

    it("preserves established environment aliases with environment precedence", () => {
        const root = makeTemporaryDirectory();
        const configPath = path.join(root, "operator.yaml");
        fs.writeFileSync(configPath, "version: 1\ncommands:\n  run:\n    outputOverwrite: true\n");
        let captured: Record<string, unknown> | undefined;
        const program = new Command().exitOverride().option("--config <file>");
        program
            .command("run")
            .option("--output-overwrite", "Overwrite output", false)
            .action((options) => {
                captured = options;
            });
        const argv = ["node", "js-recon", "--config", configPath, "run", "--output-overwrite"];

        prepareProgramConfiguration(program, {
            argv,
            env: { JS_RECON_OUTPUT_OVERWRITE: "false" },
            defaultConfigPath: path.join(root, "default.yaml"),
        });
        program.parse(argv);

        expect(captured?.outputOverwrite).toBe(false);
    });

    it("keeps proxy and MCP command-local --config flags distinct from application config", () => {
        const root = makeTemporaryDirectory();
        const defaultConfigPath = path.join(root, "default.yaml");
        let captured: Record<string, unknown> | undefined;
        const program = new Command().exitOverride().option("--config <file>");
        program
            .command("proxy")
            .option("--config <file>", "Legacy proxy config", ".proxy_config.json")
            .action((options) => {
                captured = options;
            });
        const argv = ["node", "js-recon", "proxy", "--config", "operator-proxy.json"];

        prepareProgramConfiguration(program, { argv, env: {}, defaultConfigPath });
        program.parse(argv);

        expect(captured?.config).toBe("operator-proxy.json");
        expect(getLoadedApplicationConfig()).toMatchObject({
            path: defaultConfigPath,
            source: "default",
            explicitlySupplied: false,
        });
    });

    it("uses configured accumulator values only when CLI and environment do not replace them", () => {
        const root = makeTemporaryDirectory();
        const configPath = path.join(root, "operator.yaml");
        fs.writeFileSync(
            configPath,
            "version: 1\ncommands:\n  scan:\n    url: https://config.example.test\n    command: [one, two]\n"
        );
        let captured: Record<string, unknown> | undefined;
        const program = makeProgram((options) => {
            captured = options;
        });
        const argv = ["node", "js-recon", "--config", configPath, "scan"];

        prepareProgramConfiguration(program, {
            argv,
            env: {},
            defaultConfigPath: path.join(root, "unused-default.yaml"),
        });
        program.parse(argv);

        expect(captured?.command).toEqual(["one", "two"]);
    });

    it("does not require or create the default config for explicit or informational invocations", () => {
        const root = makeTemporaryDirectory();
        const blocker = path.join(root, "not-a-directory");
        fs.writeFileSync(blocker, "blocker");
        const impossibleDefaultPath = path.join(blocker, "config.yaml");
        const explicitPath = path.join(root, "operator.yaml");
        fs.writeFileSync(explicitPath, "version: 1\ncommands:\n  scan:\n    url: https://config.example.test\n");

        expect(() =>
            prepareProgramConfiguration(makeProgram(), {
                argv: ["node", "js-recon", "--config", explicitPath, "scan"],
                env: {},
                defaultConfigPath: impossibleDefaultPath,
            })
        ).not.toThrow();
        expect(() =>
            prepareProgramConfiguration(makeProgram(), {
                argv: ["node", "js-recon", "--help"],
                env: {},
                defaultConfigPath: impossibleDefaultPath,
            })
        ).not.toThrow();
    });

    it("does not mistake required option values for informational flags", () => {
        const root = makeTemporaryDirectory();
        const configPath = path.join(root, "operator.yaml");
        fs.writeFileSync(
            configPath,
            "version: 1\ncommands:\n  scan:\n    url: https://config.example.test\n    threads: 7\n"
        );
        let captured: Record<string, unknown> | undefined;
        const program = makeProgram((options) => {
            captured = options;
        });
        const argv = ["node", "js-recon", "--config", configPath, "scan", "--command", "-h"];

        prepareProgramConfiguration(program, {
            argv,
            env: {},
            defaultConfigPath: path.join(root, "unused-default.yaml"),
        });
        program.parse(argv);

        expect(captured).toMatchObject({
            url: "https://config.example.test",
            threads: "7",
            command: ["-h"],
        });
    });

    it("bounds YAML resources and wraps alias conversion failures without source disclosure", () => {
        const root = makeTemporaryDirectory();
        const defaultConfigPath = path.join(root, "unused-default.yaml");
        const oversizedPath = path.join(root, "oversized.yaml");
        fs.writeFileSync(oversizedPath, " ".repeat(1024 * 1024 + 1));
        expect(() =>
            prepareProgramConfiguration(makeProgram(), {
                argv: ["node", "js-recon", "--config", oversizedPath, "scan"],
                env: {},
                defaultConfigPath,
            })
        ).toThrow(/size limit/);

        const aliasPath = path.join(root, "alias.yaml");
        fs.writeFileSync(aliasPath, "version: &version 1\ncommands: *version\n");
        expect(() =>
            prepareProgramConfiguration(makeProgram(), {
                argv: ["node", "js-recon", "--config", aliasPath, "scan"],
                env: {},
                defaultConfigPath,
            })
        ).toThrow(ApplicationConfigError);

        const malformedPath = path.join(root, "malformed-secret.yaml");
        fs.writeFileSync(malformedPath, "version: 1\noxylabs:\n  password: never-print-this-secret\ncommands: [\n");
        try {
            prepareProgramConfiguration(makeProgram(), {
                argv: ["node", "js-recon", "--config", malformedPath, "scan"],
                env: {},
                defaultConfigPath,
            });
            throw new Error("expected malformed YAML to fail");
        } catch (error) {
            expect(error).toBeInstanceOf(ApplicationConfigError);
            expect((error as Error).message).not.toContain("never-print-this-secret");
        }
    });

    it("rejects symlinked configs and insecure permissions on credential-bearing configs", () => {
        const root = makeTemporaryDirectory();
        const defaultConfigPath = path.join(root, "unused-default.yaml");
        const targetPath = path.join(root, "target.yaml");
        const symlinkPath = path.join(root, "linked.yaml");
        fs.writeFileSync(targetPath, "version: 1\ncommands: {}\n");
        fs.symlinkSync(targetPath, symlinkPath);
        expect(() =>
            prepareProgramConfiguration(makeProgram(), {
                argv: ["node", "js-recon", "--config", symlinkPath, "scan"],
                env: {},
                defaultConfigPath,
            })
        ).toThrow(/symbolic link/);

        const credentialsPath = path.join(root, "credentials.yaml");
        fs.writeFileSync(
            credentialsPath,
            "version: 1\noxylabs:\n  username: operator\n  password: secret\ncommands: {}\n",
            { mode: 0o644 }
        );
        fs.chmodSync(credentialsPath, 0o644);
        expect(() =>
            prepareProgramConfiguration(makeProgram(), {
                argv: ["node", "js-recon", "--config", credentialsPath, "scan"],
                env: {},
                defaultConfigPath,
            })
        ).toThrow(/chmod 600/);
        fs.chmodSync(credentialsPath, 0o600);
        expect(() =>
            prepareProgramConfiguration(makeProgram(), {
                argv: ["node", "js-recon", "--config", credentialsPath, "scan"],
                env: {},
                defaultConfigPath,
            })
        ).not.toThrow();

        const proxyCredentialsPath = path.join(root, "proxy-credentials.yaml");
        fs.writeFileSync(
            proxyCredentialsPath,
            "version: 1\ncommands:\n  proxy:\n    proxy: http://operator:secret@proxy.example.test:8080\n",
            { mode: 0o644 }
        );
        fs.chmodSync(proxyCredentialsPath, 0o644);
        const proxyProgram = new Command().exitOverride().option("--config <file>");
        proxyProgram.command("proxy").option("--proxy <url>");
        expect(() =>
            prepareProgramConfiguration(proxyProgram, {
                argv: ["node", "js-recon", "--config", proxyCredentialsPath, "proxy"],
                env: {},
                defaultConfigPath,
            })
        ).toThrow(/chmod 600/);
    });

    it("rejects malformed YAML, unknown commands, options, and unsupported versions", () => {
        const root = makeTemporaryDirectory();
        const defaultConfigPath = path.join(root, "default.yaml");
        const cases = [
            "version: [",
            "version: 1\nversion: 1\ncommands: {}\n",
            "version: 2\ncommands: {}\n",
            "version: 1\ncommands:\n  unknown:\n    value: true\n",
            "version: 1\ncommands:\n  scan:\n    typo: true\n",
        ];

        for (const [index, source] of cases.entries()) {
            const explicitPath = path.join(root, `invalid-${index}.yaml`);
            fs.writeFileSync(explicitPath, source);
            expect(() =>
                prepareProgramConfiguration(makeProgram(), {
                    argv: ["node", "js-recon", "--config", explicitPath, "scan"],
                    env: {},
                    defaultConfigPath,
                })
            ).toThrow(ApplicationConfigError);
        }
    });
});
