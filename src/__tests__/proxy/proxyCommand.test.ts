import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ prompt: vi.fn(), checkFeasibility: vi.fn() }));

vi.mock("inquirer", () => ({ default: { prompt: harness.prompt } }));
vi.mock("../../proxy/checkFeasibility.js", () => ({ default: harness.checkFeasibility }));

import proxy, { type ProxyCliOptions } from "../../proxy/index.js";

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
const ENDPOINT = "proxy.example.test:8001";
const FEASIBILITY = {
    feasibility: true,
    feasibilityUrl: "https://blocked.example.test/",
    proxyMethod: "oxylabs",
} as const;
const temporaryDirectories: string[] = [];

const proxyConfigPath = (): string => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "js-recon-proxy-command-test-"));
    temporaryDirectories.push(directory);
    return path.join(directory, ".proxy_config.json");
};

const options = (overrides: Partial<ProxyCliOptions>): ProxyCliOptions =>
    ({
        init: false,
        destroyAll: false,
        list: false,
        feasibility: false,
        config: proxyConfigPath(),
        ...overrides,
    }) as ProxyCliOptions;

beforeEach(() => {
    for (const name of PROXY_ENVIRONMENT) {
        vi.stubEnv(name, undefined);
    }
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    harness.prompt.mockReset();
    harness.checkFeasibility.mockReset();
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe("proxy --feasibility with the oxylabs method", () => {
    it("refuses an application-config endpoint for an environment password before any request", async () => {
        const run = proxy(
            options({
                ...FEASIBILITY,
                oxylabsUsername: "operator",
                oxylabsPassword: "secret",
                oxylabsPasswordSource: "env",
                oxylabsEndpoint: ENDPOINT,
                oxylabsEndpointSource: "config",
            })
        );

        await expect(run).rejects.toThrow(/endpoint.*password/i);
        expect(harness.checkFeasibility).not.toHaveBeenCalled();
    });

    it("refuses an application-config endpoint for a proxy config file password before any request", async () => {
        const config = proxyConfigPath();
        fs.writeFileSync(config, JSON.stringify({ oxylabs: { username: "file-user", password: "file-pass" } }));
        const run = proxy(
            options({ ...FEASIBILITY, config, oxylabsEndpoint: ENDPOINT, oxylabsEndpointSource: "config" })
        );

        await expect(run).rejects.toThrow(/endpoint.*password/i);
        expect(harness.checkFeasibility).not.toHaveBeenCalled();
    });

    it("rejects an endpoint that is not host:port before any request", async () => {
        const run = proxy(
            options({
                ...FEASIBILITY,
                oxylabsUsername: "operator",
                oxylabsPassword: "secret",
                oxylabsPasswordSource: "cli",
                oxylabsEndpoint: "proxy.example.test",
                oxylabsEndpointSource: "cli",
            })
        );

        await expect(run).rejects.toThrow(/host:port/);
        expect(harness.checkFeasibility).not.toHaveBeenCalled();
    });

    it("reads proxy environment variables only through the command's own options", async () => {
        vi.stubEnv("JS_RECON_OXYLABS_USERNAME", "env-user");
        vi.stubEnv("JS_RECON_OXYLABS_PASSWORD", "env-pass");
        vi.spyOn(console, "error").mockImplementation(() => undefined);

        await proxy(options({ ...FEASIBILITY, oxylabsEndpoint: ENDPOINT, oxylabsEndpointSource: "config" }));

        expect(harness.checkFeasibility).not.toHaveBeenCalled();
    });

    it("checks feasibility through an operator endpoint with operator credentials", async () => {
        await proxy(
            options({
                ...FEASIBILITY,
                oxylabsUsername: "operator",
                oxylabsPassword: "secret",
                oxylabsPasswordSource: "cli",
                oxylabsEndpoint: ENDPOINT,
                oxylabsEndpointSource: "env",
            })
        );

        expect(harness.checkFeasibility).toHaveBeenCalledWith(
            expect.objectContaining({ method: "oxylabs", oxylabs: expect.objectContaining({ endpoint: ENDPOINT }) }),
            FEASIBILITY.feasibilityUrl
        );
    });
});

describe("proxy -i with the oxylabs method", () => {
    it("refuses an application-config endpoint before prompting for the password it would receive", async () => {
        const run = proxy(
            options({ init: true, proxyMethod: "oxylabs", oxylabsEndpoint: ENDPOINT, oxylabsEndpointSource: "config" })
        );

        await expect(run).rejects.toThrow(/endpoint.*password/i);
        expect(harness.prompt).not.toHaveBeenCalled();
    });

    it("saves an operator endpoint with a typed password", async () => {
        harness.prompt.mockResolvedValue({ username: "operator", password: "typed" });
        const config = proxyConfigPath();
        vi.spyOn(console, "log").mockImplementation(() => undefined);

        await proxy(
            options({
                init: true,
                proxyMethod: "oxylabs",
                config,
                oxylabsEndpoint: ENDPOINT,
                oxylabsEndpointSource: "env",
            })
        );

        expect(JSON.parse(fs.readFileSync(config, "utf8"))).toMatchObject({
            method: "oxylabs",
            oxylabs: { username: "operator", password: "typed", endpoint: ENDPOINT },
        });
    });
});
