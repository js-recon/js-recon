import { afterEach, describe, expect, it } from "vitest";
import type { LoadedApplicationConfig } from "../../config/applicationConfig.js";
import {
    OxylabsFallbackConfigurationError,
    claimOxylabsFallback,
    configureOxylabsFallback,
    resetOxylabsFallback,
    resolveOxylabsFallback,
} from "../../proxy/oxylabsFallback.js";

const loadedConfig = (
    oxylabs: LoadedApplicationConfig["data"]["oxylabs"],
    explicitlySupplied = true
): LoadedApplicationConfig => ({
    path: "/tmp/operator.yaml",
    source: "cli",
    explicitlySupplied,
    data: { version: 1, commands: {}, oxylabs },
});

afterEach(() => resetOxylabsFallback());

describe("Oxylabs WAF fallback configuration", () => {
    it("stays inert when the opt-in flag is disabled", () => {
        expect(
            resolveOxylabsFallback({
                enabled: false,
                maxRequestsPerOrigin: "10",
                loadedConfig: undefined,
                env: {},
                ignoreEnvironment: false,
            })
        ).toEqual({ enabled: false });
    });

    it("requires an explicitly selected YAML config with credentials", () => {
        const incomplete = loadedConfig({ username: null, password: null, country: null });

        expect(() =>
            resolveOxylabsFallback({
                enabled: true,
                maxRequestsPerOrigin: "10",
                loadedConfig: incomplete,
                env: {},
                ignoreEnvironment: false,
            })
        ).toThrow(OxylabsFallbackConfigurationError);
        expect(() =>
            resolveOxylabsFallback({
                enabled: true,
                maxRequestsPerOrigin: "10",
                loadedConfig: loadedConfig({ username: "operator", password: "secret", country: null }, false),
                env: {},
                ignoreEnvironment: false,
            })
        ).toThrow(/explicit --config or JS_RECON_CONFIG/i);
    });

    it("applies proxy environment values over YAML unless explicitly ignored", () => {
        const input = {
            enabled: true,
            maxRequestsPerOrigin: "3",
            loadedConfig: loadedConfig({ username: "yaml-user", password: "yaml-pass", country: "us" }),
            env: {
                JS_RECON_OXYLABS_USERNAME: "env-user",
                JS_RECON_OXYLABS_PASSWORD: " env-pass ",
                JS_RECON_OXYLABS_COUNTRY: "ca",
            },
        } as const;

        expect(resolveOxylabsFallback({ ...input, ignoreEnvironment: false })).toEqual({
            enabled: true,
            maxRequestsPerOrigin: 3,
            maxTotalRequests: 100,
            maxOrigins: 25,
            proxy: { username: "env-user", password: " env-pass ", country: "ca" },
        });
        expect(resolveOxylabsFallback({ ...input, ignoreEnvironment: true })).toEqual({
            enabled: true,
            maxRequestsPerOrigin: 3,
            maxTotalRequests: 100,
            maxOrigins: 25,
            proxy: { username: "yaml-user", password: "yaml-pass", country: "us" },
        });
    });

    it("validates and enforces the paid-request budget per origin", () => {
        expect(() =>
            resolveOxylabsFallback({
                enabled: true,
                maxRequestsPerOrigin: "0",
                loadedConfig: loadedConfig({ username: "user", password: "pass", country: null }),
                env: {},
                ignoreEnvironment: false,
            })
        ).toThrow(/positive integer/i);

        configureOxylabsFallback({
            enabled: true,
            maxRequestsPerOrigin: 2,
            proxy: { username: "user", password: "pass" },
        });

        expect(claimOxylabsFallback("https://cdn.example.test/a.js")).toMatchObject({ username: "user" });
        expect(claimOxylabsFallback("https://cdn.example.test/b.js")).toMatchObject({ username: "user" });
        expect(claimOxylabsFallback("https://cdn.example.test/c.js")).toBeNull();
        expect(claimOxylabsFallback("https://other.example.test/a.js")).toMatchObject({ username: "user" });
    });

    it("bounds total paid requests and distinct origins across the run", () => {
        configureOxylabsFallback({
            enabled: true,
            maxRequestsPerOrigin: 10,
            maxTotalRequests: 3,
            maxOrigins: 2,
            proxy: { username: "user", password: "pass" },
        });

        expect(claimOxylabsFallback("https://one.example.test/a.js")).not.toBeNull();
        expect(claimOxylabsFallback("https://two.example.test/a.js")).not.toBeNull();
        expect(claimOxylabsFallback("https://three.example.test/a.js")).toBeNull();
        expect(claimOxylabsFallback("https://one.example.test/b.js")).not.toBeNull();
        expect(claimOxylabsFallback("https://one.example.test/c.js")).toBeNull();
    });

    it("does not fall through to YAML when a higher-precedence environment credential is empty", () => {
        expect(() =>
            resolveOxylabsFallback({
                enabled: true,
                maxRequestsPerOrigin: "10",
                loadedConfig: loadedConfig({ username: "yaml-user", password: "yaml-pass", country: null }),
                env: { JS_RECON_OXYLABS_PASSWORD: "" },
                ignoreEnvironment: false,
            })
        ).toThrow(/JS_RECON_OXYLABS_PASSWORD cannot be empty/);
    });
});
