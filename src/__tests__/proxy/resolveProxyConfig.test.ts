import { describe, it, expect } from "vitest";
import { resolveProxyConfig } from "../../proxy/resolveProxyConfig.js";

describe("resolveProxyConfig", () => {
    it("returns method: null when nothing is configured anywhere", () => {
        const result = resolveProxyConfig({
            cli: {},
            env: {},
            ignoreEnv: false,
            configFileParsed: {},
        });
        expect(result).toEqual({ method: null });
    });

    it("prefers CLI method over env and config file", () => {
        const result = resolveProxyConfig({
            cli: { proxyMethod: "socks", proxyUrl: "socks5://cli-host:1080" },
            env: { JS_RECON_PROXY_METHOD: "http", JS_RECON_PROXY_URL: "http://env-host:8080" },
            ignoreEnv: false,
            configFileParsed: { method: "aws" },
        });
        expect(result.method).toBe("socks");
        expect(result.url).toBe("socks5://cli-host:1080");
    });

    it("falls back to env when CLI is not set", () => {
        const result = resolveProxyConfig({
            cli: {},
            env: { JS_RECON_PROXY_METHOD: "http", JS_RECON_PROXY_URL: "http://env-host:8080" },
            ignoreEnv: false,
            configFileParsed: { method: "socks", socks: { url: "socks5://file-host:1080" } },
        });
        expect(result.method).toBe("http");
        expect(result.url).toBe("http://env-host:8080");
    });

    it("skips env vars entirely when ignoreEnv is true, falling through to config file", () => {
        const result = resolveProxyConfig({
            cli: {},
            env: { JS_RECON_PROXY_METHOD: "http", JS_RECON_PROXY_URL: "http://env-host:8080" },
            ignoreEnv: true,
            configFileParsed: { method: "socks", socks: { url: "socks5://file-host:1080" } },
        });
        expect(result.method).toBe("socks");
        expect(result.url).toBe("socks5://file-host:1080");
    });

    it("falls back to config file when neither CLI nor env set anything", () => {
        const result = resolveProxyConfig({
            cli: {},
            env: {},
            ignoreEnv: false,
            configFileParsed: { method: "http", http: { url: "http://file-host:8080" } },
        });
        expect(result.method).toBe("http");
        expect(result.url).toBe("http://file-host:8080");
    });

    it("resolves oxylabs config with CLI > env > file precedence per field", () => {
        const result = resolveProxyConfig({
            cli: { proxyMethod: "oxylabs", oxylabsUsername: "cli-user" },
            env: {
                JS_RECON_OXYLABS_USERNAME: "env-user",
                JS_RECON_OXYLABS_PASSWORD: "env-pass",
                JS_RECON_OXYLABS_COUNTRY: "US",
            },
            ignoreEnv: false,
            configFileParsed: {
                oxylabs: { username: "file-user", password: "file-pass", country: "FR", city: "paris" },
            },
        });
        expect(result.method).toBe("oxylabs");
        expect(result.oxylabs).toEqual({
            username: "cli-user",
            password: "env-pass",
            country: "US",
            city: "paris",
            sessionId: undefined,
        });
    });

    it("returns method: null for oxylabs when username or password is missing everywhere", () => {
        const result = resolveProxyConfig({
            cli: { proxyMethod: "oxylabs" },
            env: {},
            ignoreEnv: false,
            configFileParsed: {},
        });
        expect(result).toEqual({ method: null });
    });

    it("resolves the aws method's preserved gateway map from the config file", () => {
        const awsMap = {
            "js_recon-123-1": {
                id: "abc",
                name: "js_recon-123-1",
                description: "test",
                created_at: 123,
                region: "us-east-1",
                access_key: "AKIA...",
                secret_key: "secret",
            },
        };
        const result = resolveProxyConfig({
            cli: { proxyMethod: "aws" },
            env: {},
            ignoreEnv: false,
            configFileParsed: { aws: awsMap },
        });
        expect(result.method).toBe("aws");
        expect(result.awsGatewayMap).toEqual(awsMap);
    });

    it("ignores an unrecognized method value and returns null", () => {
        const result = resolveProxyConfig({
            cli: { proxyMethod: "not-a-real-method" },
            env: {},
            ignoreEnv: false,
            configFileParsed: {},
        });
        expect(result).toEqual({ method: null });
    });
});
