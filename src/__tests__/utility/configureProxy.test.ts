import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import configureProxy from "../../utility/configureProxy.js";
import { getOxylabsConfig, setOxylabsConfig, setProxyMethod, setUseProxy } from "../../utility/globals.js";

const PROXY_ENVIRONMENT = [
    "JS_RECON_PROXY_METHOD",
    "JS_RECON_PROXY_URL",
    "JS_RECON_OXYLABS_USERNAME",
    "JS_RECON_OXYLABS_PASSWORD",
    "JS_RECON_OXYLABS_COUNTRY",
    "JS_RECON_OXYLABS_ENDPOINT",
    "JS_RECON_OXYLABS_CITY",
    "JS_RECON_OXYLABS_SESSION_ID",
];
const temporaryDirectories: string[] = [];

beforeEach(() => {
    for (const name of PROXY_ENVIRONMENT) {
        vi.stubEnv(name, undefined);
    }
});

const writeProxyConfig = (config: unknown): string => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "js-recon-proxy-config-test-"));
    temporaryDirectories.push(directory);
    const configFile = path.join(directory, ".proxy_config.json");
    fs.writeFileSync(configFile, JSON.stringify(config));
    return configFile;
};

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    setUseProxy(false);
    setProxyMethod(null);
    setOxylabsConfig(undefined);
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe("configureProxy", () => {
    it("carries a configured Oxylabs entry endpoint into the proxy globals", () => {
        const proxyConfig = writeProxyConfig({
            method: "oxylabs",
            oxylabs: { username: "operator", password: "secret", endpoint: "proxy.example.test:8001" },
        });

        configureProxy({ proxyConfig, ignoreProxyEnv: true });

        expect(getOxylabsConfig()).toMatchObject({ username: "operator", endpoint: "proxy.example.test:8001" });
    });

    it("exits before any request when the Oxylabs entry endpoint is not host:port", () => {
        const proxyConfig = writeProxyConfig({
            method: "oxylabs",
            oxylabs: { username: "operator", password: "secret", endpoint: "http://proxy.example.test:8001" },
        });
        const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
            throw new Error(`exit ${code}`);
        }) as never);
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

        expect(() => configureProxy({ proxyConfig, ignoreProxyEnv: true })).toThrow("exit 1");

        expect(exit).toHaveBeenCalledWith(1);
        expect(error.mock.calls.flat().join("\n")).toMatch(/Invalid Oxylabs config: .*host:port/);
        expect(getOxylabsConfig()).toBeUndefined();
    });

    it("exits before any request when a proxy config file endpoint would receive environment credentials", () => {
        vi.stubEnv("JS_RECON_OXYLABS_USERNAME", "env-user");
        vi.stubEnv("JS_RECON_OXYLABS_PASSWORD", "env-pass");
        const proxyConfig = writeProxyConfig({ method: "oxylabs", oxylabs: { endpoint: "proxy.example.test:8001" } });
        const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
            throw new Error(`exit ${code}`);
        }) as never);
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

        expect(() => configureProxy({ proxyConfig })).toThrow("exit 1");

        expect(exit).toHaveBeenCalledWith(1);
        expect(error.mock.calls.flat().join("\n")).toMatch(/Invalid Oxylabs config: .*endpoint.*password/);
        expect(getOxylabsConfig()).toBeUndefined();
    });
});
