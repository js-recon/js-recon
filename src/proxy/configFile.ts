import fs from "fs";

/** Reads and parses the whole `.proxy_config.json` file (or `{}` if missing). */
export const readProxyConfigFile = (configFile: string): Record<string, unknown> => {
    if (!fs.existsSync(configFile)) {
        return {};
    }
    try {
        return JSON.parse(fs.readFileSync(configFile, "utf8"));
    } catch (error) {
        throw new Error(`Failed to parse proxy config file ${configFile}: ${error.message}`);
    }
};

/** Overwrites the whole `.proxy_config.json` file. */
export const writeProxyConfigFile = (configFile: string, full: Record<string, unknown>): void => {
    fs.writeFileSync(configFile, JSON.stringify(full, null, 4));
};

/** Sets the active `method` key, preserving every other key already in the file. */
export const setActiveProxyMethod = (configFile: string, method: string): void => {
    const full = readProxyConfigFile(configFile);
    full.method = method;
    writeProxyConfigFile(configFile, full);
};

/** Writes a method's config block (`socks`/`http`/`oxylabs`) and activates it, preserving other keys (e.g. `aws`). */
export const writeMethodConfig = (configFile: string, method: "socks" | "http" | "oxylabs", data: unknown): void => {
    const full = readProxyConfigFile(configFile);
    full.method = method;
    full[method] = data;
    writeProxyConfigFile(configFile, full);
};
