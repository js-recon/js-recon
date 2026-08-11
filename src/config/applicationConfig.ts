import fs from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Command, Option } from "commander";
import { parseDocument, stringify } from "yaml";

export const APPLICATION_CONFIG_VERSION = 1;
export const APPLICATION_CONFIG_ENV = "JS_RECON_CONFIG";
const MAX_APPLICATION_CONFIG_BYTES = 1024 * 1024;

export type ApplicationConfigValue = string | boolean | null | string[];

export interface OxylabsApplicationConfig {
    username: string | null;
    password: string | null;
    country: string | null;
    city?: string | null;
    sessionId?: string | null;
}

export interface ApplicationConfig {
    version: typeof APPLICATION_CONFIG_VERSION;
    oxylabs: OxylabsApplicationConfig;
    commands: Record<string, Record<string, ApplicationConfigValue>>;
}

export interface LoadedApplicationConfig {
    path: string;
    source: "default" | "cli" | "env";
    explicitlySupplied: boolean;
    data: ApplicationConfig;
}

export interface PrepareProgramConfigurationOptions {
    argv?: readonly string[];
    env?: Readonly<Record<string, string | undefined>>;
    defaultConfigPath?: string;
}

export class ApplicationConfigError extends Error {
    readonly cause?: unknown;

    constructor(message: string, cause?: unknown) {
        super(message);
        this.name = "ApplicationConfigError";
        this.cause = cause;
    }
}

let loadedApplicationConfig: LoadedApplicationConfig | undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const cloneDefault = (value: unknown): ApplicationConfigValue => {
    if (Array.isArray(value)) {
        return value.map((entry) => String(entry));
    }
    if (typeof value === "boolean" || typeof value === "string") {
        return value;
    }
    if (typeof value === "number") {
        return String(value);
    }
    return null;
};

const optionMap = (command: Command): Map<string, Option> =>
    new Map(command.options.map((option) => [option.attributeName(), option]));

const commandMap = (program: Command): Map<string, Command> =>
    new Map(program.commands.map((command) => [command.name(), command]));

const assertKnownKeys = (value: Record<string, unknown>, allowed: ReadonlySet<string>, location: string): void => {
    const unknownKeys = Object.keys(value).filter((key) => !allowed.has(key));
    if (unknownKeys.length > 0) {
        throw new ApplicationConfigError(
            `Unknown ${location} key${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}`
        );
    }
};

const normalizeBoolean = (value: unknown, location: string): boolean => {
    if (typeof value === "boolean") return value;
    if (typeof value === "number" && (value === 0 || value === 1)) return value === 1;
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (["true", "1", "yes", "on"].includes(normalized)) return true;
        if (["false", "0", "no", "off"].includes(normalized)) return false;
    }
    throw new ApplicationConfigError(`${location} must be a boolean (true/false)`);
};

const parseOptionValue = (option: Option, value: unknown, location: string): unknown => {
    if (value === null || value === undefined) return undefined;

    const isBooleanFlag = !option.required && !option.optional;
    if (isBooleanFlag) return normalizeBoolean(value, location);

    if (option.optional && typeof value === "boolean") {
        return value;
    }

    const parseOne = (entry: unknown, previous: unknown): unknown => {
        if (!["string", "number", "boolean"].includes(typeof entry)) {
            throw new ApplicationConfigError(`${location} must contain only scalar values`);
        }
        const stringValue = String(entry);
        if (!option.parseArg) return stringValue;
        try {
            return option.parseArg(stringValue, previous);
        } catch (error) {
            throw new ApplicationConfigError(`${location} is invalid: ${(error as Error).message}`, error);
        }
    };

    if (Array.isArray(value)) {
        if (!option.parseArg && !option.variadic && !Array.isArray(option.defaultValue)) {
            throw new ApplicationConfigError(`${location} does not accept a list`);
        }
        if (!option.parseArg) {
            return value.map((entry) => parseOne(entry, undefined));
        }
        return value.reduce<unknown>((previous, entry) => parseOne(entry, previous), []);
    }

    const previous = Array.isArray(option.defaultValue) ? [] : undefined;
    return parseOne(value, previous);
};

const camelToUpperSnake = (value: string): string =>
    value
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/[^a-zA-Z0-9]+/g, "_")
        .toUpperCase();

export const getOptionEnvironmentVariable = (commandName: string, optionName: string): string =>
    `JS_RECON_${camelToUpperSnake(commandName)}_${camelToUpperSnake(optionName)}`;

const legacyEnvironmentAliases: Readonly<Record<string, readonly string[]>> = Object.freeze({
    "run.outputOverwrite": ["JS_RECON_OUTPUT_OVERWRITE"],
    "run.disableRulesVersionCheck": ["JS_RECON_DISABLE_RULES_VERSION_CHECK"],
    "analyze.disableRulesVersionCheck": ["JS_RECON_DISABLE_RULES_VERSION_CHECK"],
    "run.aiApiKey": ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
    "map.aiApiKey": ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
    "proxy.awsAccessKey": ["AWS_ACCESS_KEY_ID"],
    "proxy.awsSecretKey": ["AWS_SECRET_ACCESS_KEY"],
    "proxy.proxyMethod": ["JS_RECON_PROXY_METHOD"],
    "proxy.proxy": ["JS_RECON_PROXY_URL"],
    "proxy.oxylabsUsername": ["JS_RECON_OXYLABS_USERNAME"],
    "proxy.oxylabsPassword": ["JS_RECON_OXYLABS_PASSWORD"],
    "proxy.oxylabsCountry": ["JS_RECON_OXYLABS_COUNTRY"],
    "proxy.oxylabsCity": ["JS_RECON_OXYLABS_CITY"],
    "proxy.oxylabsSessionId": ["JS_RECON_OXYLABS_SESSION_ID"],
});

export const getDefaultApplicationConfigPath = (homeDirectory: string = os.homedir()): string =>
    path.join(homeDirectory, ".config", "js-recon", "config.yaml");

export const buildDefaultApplicationConfig = (program: Command): ApplicationConfig => {
    const commands = Object.fromEntries(
        program.commands.map((command) => [
            command.name(),
            Object.fromEntries(
                command.options.map((option) => [
                    option.attributeName(),
                    cloneDefault(command.getOptionValue(option.attributeName())),
                ])
            ),
        ])
    );

    return {
        version: APPLICATION_CONFIG_VERSION,
        oxylabs: {
            username: null,
            password: null,
            country: null,
        },
        commands,
    };
};

const createDefaultConfigIfMissing = (configPath: string, program: Command): void => {
    const directory = path.dirname(configPath);
    let temporaryPath: string | undefined;
    if (fs.existsSync(configPath)) return;
    try {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        if (fs.existsSync(configPath)) return;
        fs.chmodSync(directory, 0o700);
        temporaryPath = path.join(directory, `.${path.basename(configPath)}.${process.pid}.${randomUUID()}.tmp`);
        const descriptor = fs.openSync(temporaryPath, "wx", 0o600);
        try {
            fs.writeFileSync(descriptor, stringify(buildDefaultApplicationConfig(program)), "utf8");
            fs.fsyncSync(descriptor);
        } finally {
            fs.closeSync(descriptor);
        }
        fs.linkSync(temporaryPath, configPath);
        fs.chmodSync(configPath, 0o600);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            throw new ApplicationConfigError(`Unable to create default config at ${configPath}`, error);
        }
    } finally {
        if (temporaryPath) {
            try {
                fs.unlinkSync(temporaryPath);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    throw new ApplicationConfigError(`Unable to clean up temporary config at ${temporaryPath}`, error);
                }
            }
        }
    }
};

const normalizeOxylabsConfig = (value: unknown): OxylabsApplicationConfig => {
    if (value === undefined || value === null) {
        return { username: null, password: null, country: null };
    }
    if (!isRecord(value)) {
        throw new ApplicationConfigError("oxylabs must be a mapping");
    }
    const allowed = new Set(["username", "password", "country", "city", "sessionId"]);
    assertKnownKeys(value, allowed, "oxylabs");

    const readNullableString = (key: string): string | null | undefined => {
        const entry = value[key];
        if (entry === undefined) return undefined;
        if (entry === null) return null;
        if (typeof entry !== "string") {
            throw new ApplicationConfigError(`oxylabs.${key} must be a string or null`);
        }
        return entry;
    };

    return {
        username: readNullableString("username") ?? null,
        password: readNullableString("password") ?? null,
        country: readNullableString("country") ?? null,
        ...(value.city !== undefined ? { city: readNullableString("city") ?? null } : {}),
        ...(value.sessionId !== undefined ? { sessionId: readNullableString("sessionId") ?? null } : {}),
    };
};

const readConfigSource = (descriptor: number, configPath: string): string => {
    const chunks: Buffer[] = [];
    let bytesRead = 0;

    while (bytesRead <= MAX_APPLICATION_CONFIG_BYTES) {
        const remaining = MAX_APPLICATION_CONFIG_BYTES + 1 - bytesRead;
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
        const count = fs.readSync(descriptor, chunk, 0, chunk.length, null);
        if (count === 0) break;
        chunks.push(chunk.subarray(0, count));
        bytesRead += count;
    }

    if (bytesRead > MAX_APPLICATION_CONFIG_BYTES) {
        throw new ApplicationConfigError(
            `Config at ${configPath} exceeds the ${MAX_APPLICATION_CONFIG_BYTES}-byte size limit`
        );
    }
    return Buffer.concat(chunks, bytesRead).toString("utf8");
};

const valueContainsUrlCredentials = (value: ApplicationConfigValue): boolean => {
    const candidates = Array.isArray(value) ? value : [value];
    return candidates.some((candidate) => {
        if (typeof candidate !== "string" || candidate.trim() === "") return false;
        try {
            const parsed = new URL(candidate);
            return parsed.username !== "" || parsed.password !== "";
        } catch {
            // Be conservative for malformed-but-obviously credential-bearing URLs;
            // their validation may happen later in the selected command.
            return /^[a-z][a-z\d+.-]*:\/\/[^/@\s]+@/i.test(candidate);
        }
    });
};

const parseApplicationConfig = (configPath: string, program: Command): ApplicationConfig => {
    let descriptor: number;
    const noFollowFlag = process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
    try {
        descriptor = fs.openSync(configPath, fs.constants.O_RDONLY | noFollowFlag);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ELOOP") {
            throw new ApplicationConfigError(`Config at ${configPath} must not be a symbolic link`, error);
        }
        throw new ApplicationConfigError(`Unable to open config at ${configPath}`, error);
    }

    let fileStats: fs.Stats;
    let source: string;
    try {
        fileStats = fs.fstatSync(descriptor);
        if (!fileStats.isFile()) {
            throw new ApplicationConfigError(`Config at ${configPath} must be a regular file`);
        }
        if (fileStats.size > MAX_APPLICATION_CONFIG_BYTES) {
            throw new ApplicationConfigError(
                `Config at ${configPath} exceeds the ${MAX_APPLICATION_CONFIG_BYTES}-byte size limit`
            );
        }
        source = readConfigSource(descriptor, configPath);
    } catch (error) {
        if (error instanceof ApplicationConfigError) throw error;
        throw new ApplicationConfigError(`Unable to inspect or read config at ${configPath}`, error);
    } finally {
        fs.closeSync(descriptor);
    }

    const document = parseDocument(source, {
        schema: "core",
        uniqueKeys: true,
        prettyErrors: true,
    });
    if (document.errors.length > 0) {
        const yamlError = document.errors[0];
        const position = yamlError.linePos?.[0];
        const location = position ? ` at line ${position.line}, column ${position.col}` : "";
        throw new ApplicationConfigError(`Invalid YAML in ${configPath}${location} (${yamlError.code})`);
    }

    let raw: unknown;
    try {
        raw = document.toJS({ maxAliasCount: 0 }) as unknown;
    } catch (error) {
        throw new ApplicationConfigError(`Invalid YAML structure in ${configPath}; aliases are not allowed`, error);
    }
    if (!isRecord(raw)) {
        throw new ApplicationConfigError(`Config at ${configPath} must contain a YAML mapping`);
    }
    assertKnownKeys(raw, new Set(["version", "oxylabs", "commands"]), "top-level config");
    if (raw.version !== APPLICATION_CONFIG_VERSION) {
        throw new ApplicationConfigError(
            `Unsupported config version ${String(raw.version)}; expected ${APPLICATION_CONFIG_VERSION}`
        );
    }

    const declaredCommands = commandMap(program);
    const rawCommands = raw.commands ?? {};
    if (!isRecord(rawCommands)) {
        throw new ApplicationConfigError("commands must be a mapping");
    }
    assertKnownKeys(rawCommands, new Set(declaredCommands.keys()), "command");

    const commands: ApplicationConfig["commands"] = {};
    for (const [commandName, rawOptions] of Object.entries(rawCommands)) {
        if (!isRecord(rawOptions)) {
            throw new ApplicationConfigError(`commands.${commandName} must be a mapping`);
        }
        const command = declaredCommands.get(commandName)!;
        const declaredOptions = optionMap(command);
        assertKnownKeys(rawOptions, new Set(declaredOptions.keys()), `commands.${commandName}`);

        commands[commandName] = Object.fromEntries(
            Object.entries(rawOptions).map(([optionName, value]) => {
                const option = declaredOptions.get(optionName)!;
                const parsed = parseOptionValue(option, value, `commands.${commandName}.${optionName}`);
                return [optionName, parsed === undefined ? null : (parsed as ApplicationConfigValue)];
            })
        );
    }

    const config: ApplicationConfig = {
        version: APPLICATION_CONFIG_VERSION,
        oxylabs: normalizeOxylabsConfig(raw.oxylabs),
        commands,
    };
    const containsSensitiveValue =
        Boolean(config.oxylabs.password?.trim()) ||
        Object.values(config.commands).some((commandOptions) =>
            Object.entries(commandOptions).some(
                ([name, value]) =>
                    (/(?:password|secretKey|accessKey|apiKey)$/i.test(name) &&
                        value !== null &&
                        String(value).trim().length > 0) ||
                    valueContainsUrlCredentials(value)
            )
        );
    if (containsSensitiveValue && process.platform !== "win32") {
        if ((fileStats.mode & 0o077) !== 0) {
            throw new ApplicationConfigError(
                `Config at ${configPath} contains credentials and must not be readable by group or other users (use chmod 600)`
            );
        }
        if (typeof process.getuid === "function" && fileStats.uid !== process.getuid()) {
            throw new ApplicationConfigError(
                `Config at ${configPath} contains credentials and must be owned by this user`
            );
        }
    }
    return config;
};

const findCommandTokenIndex = (program: Command, argv: readonly string[]): number => {
    const names = new Set(program.commands.map((command) => command.name()));
    return argv.findIndex((token, index) => index >= 2 && names.has(token));
};

const findCliConfigPath = (program: Command, argv: readonly string[]): string | undefined => {
    const commandIndex = findCommandTokenIndex(program, argv);
    const command =
        commandIndex >= 0 ? program.commands.find((entry) => entry.name() === argv[commandIndex]) : undefined;
    const localConfigCollision = command?.options.some((option) => option.long === "--config") ?? false;

    for (let index = 2; index < argv.length; index += 1) {
        const token = argv[index];
        // eslint-disable-next-line security/detect-possible-timing-attacks -- comparing CLI argument/command-name strings, not secrets or credentials — timing is not security-relevant here
        if (token === "--config") {
            if (index + 1 >= argv.length) {
                throw new ApplicationConfigError("--config requires a file path");
            }
            if (commandIndex < 0 || index < commandIndex) return argv[index + 1];
            if (!localConfigCollision) {
                throw new ApplicationConfigError("Application --config must appear before the subcommand");
            }
        }
        if (token.startsWith("--config=")) {
            if (commandIndex < 0 || index < commandIndex) return token.slice("--config=".length);
            if (!localConfigCollision) {
                throw new ApplicationConfigError("Application --config must appear before the subcommand");
            }
        }
    }
    return undefined;
};

const expandConfigPath = (value: string, homeDirectory: string): string => {
    if (value === "~") return homeDirectory;
    if (value.startsWith("~/")) return path.join(homeDirectory, value.slice(2));
    return path.resolve(value);
};

const findOptionForToken = (command: Command, token: string): Option | undefined => {
    const optionToken = token.startsWith("--") && token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
    return command.options.find((option) => option.long === optionToken || option.short === optionToken);
};

const isInformationalInvocation = (program: Command, argv: readonly string[]): boolean => {
    if (argv.length <= 2) return true;

    let activeCommand = program;
    for (let index = 2; index < argv.length; index += 1) {
        const token = argv[index];
        if (["--help", "-h", "--version", "-V"].includes(token)) return true;
        if (activeCommand === program && ["help", "completion"].includes(token)) return true;

        if (activeCommand === program) {
            const subcommand = program.commands.find((command) => command.name() === token);
            if (subcommand) {
                activeCommand = subcommand;
                continue;
            }
        }

        const option = findOptionForToken(activeCommand, token);
        if (!option || token.includes("=")) continue;
        if (option.required && index + 1 < argv.length) {
            index += 1;
            continue;
        }
        if (option.optional && index + 1 < argv.length && !argv[index + 1].startsWith("-")) {
            index += 1;
        }
    }
    return false;
};

const applyCommandValues = (
    program: Command,
    values: ApplicationConfig["commands"],
    source: "config" | "env",
    includeArrays: boolean = true
): void => {
    for (const command of program.commands) {
        const commandValues = values[command.name()];
        if (!commandValues) continue;
        for (const [optionName, value] of Object.entries(commandValues)) {
            if (!includeArrays && Array.isArray(value)) continue;
            if (value !== null) command.setOptionValueWithSource(optionName, value, source);
        }
    }
};

const applyDeferredConfigArrays = (program: Command, values: ApplicationConfig["commands"]): void => {
    for (const command of program.commands) {
        const commandValues = values[command.name()];
        if (!commandValues) continue;
        for (const [optionName, value] of Object.entries(commandValues)) {
            if (!Array.isArray(value)) continue;
            const currentSource = command.getOptionValueSource(optionName);
            if (currentSource !== "cli" && currentSource !== "env") {
                command.setOptionValueWithSource(optionName, [...value], "config");
            }
        }
    }
};

const collectEnvironmentValues = (
    program: Command,
    env: Readonly<Record<string, string | undefined>>
): ApplicationConfig["commands"] => {
    const values: ApplicationConfig["commands"] = {};
    for (const command of program.commands) {
        const commandValues: Record<string, ApplicationConfigValue> = {};
        for (const option of command.options) {
            const optionName = option.attributeName();
            const variable = getOptionEnvironmentVariable(command.name(), optionName);
            const aliases = legacyEnvironmentAliases[`${command.name()}.${optionName}`] ?? [];
            const selectedVariable = [variable, ...aliases].find((candidate) => env[candidate] !== undefined);
            const raw = selectedVariable === undefined ? undefined : env[selectedVariable];
            if (raw === undefined) continue;
            commandValues[optionName] = parseOptionValue(option, raw, selectedVariable!) as ApplicationConfigValue;
        }
        if (Object.keys(commandValues).length > 0) values[command.name()] = commandValues;
    }
    return values;
};

export const getLoadedApplicationConfig = (): LoadedApplicationConfig | undefined => loadedApplicationConfig;

export const prepareProgramConfiguration = (
    program: Command,
    options: PrepareProgramConfigurationOptions = {}
): LoadedApplicationConfig => {
    // Root --config must appear before the subcommand so command-local flags such as
    // `proxy --config` and `mcp --config` retain their established meaning.
    program.enablePositionalOptions();
    const argv = options.argv ?? process.argv;
    const env = options.env ?? process.env;
    const defaultConfigPath = options.defaultConfigPath ?? getDefaultApplicationConfigPath();
    if (isInformationalInvocation(program, argv)) {
        loadedApplicationConfig = {
            path: defaultConfigPath,
            source: "default",
            explicitlySupplied: false,
            data: buildDefaultApplicationConfig(program),
        };
        return loadedApplicationConfig;
    }

    const envPath = env[APPLICATION_CONFIG_ENV];
    const cliPath = findCliConfigPath(program, argv);
    const selection =
        envPath !== undefined
            ? { path: envPath, source: "env" as const, explicitlySupplied: true }
            : cliPath !== undefined
              ? { path: cliPath, source: "cli" as const, explicitlySupplied: true }
              : { path: defaultConfigPath, source: "default" as const, explicitlySupplied: false };
    if (selection.path.trim() === "") {
        throw new ApplicationConfigError(
            `${selection.source === "env" ? APPLICATION_CONFIG_ENV : "--config"} cannot be empty`
        );
    }

    const homeDirectory = os.homedir();
    const selectedPath = expandConfigPath(selection.path, homeDirectory);
    if (!selection.explicitlySupplied) createDefaultConfigIfMissing(selectedPath, program);
    const data = parseApplicationConfig(selectedPath, program);
    const environmentValues = collectEnvironmentValues(program, env);

    applyCommandValues(program, data.commands, "config", false);
    applyCommandValues(program, environmentValues, "env");
    program.hook("preAction", () => {
        applyDeferredConfigArrays(program, data.commands);
        applyCommandValues(program, environmentValues, "env");
        if (envPath !== undefined) program.setOptionValueWithSource("config", selectedPath, "env");
    });

    if (envPath !== undefined) program.setOptionValueWithSource("config", selectedPath, "env");

    loadedApplicationConfig = {
        path: selectedPath,
        source: selection.source,
        explicitlySupplied: selection.explicitlySupplied,
        data,
    };
    return loadedApplicationConfig;
};
