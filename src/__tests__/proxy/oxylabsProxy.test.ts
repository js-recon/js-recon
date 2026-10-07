import { describe, it, expect } from "vitest";
import { composeOxylabsUsername, buildOxylabsProxyUrl, resolveOxylabsEndpoint } from "../../proxy/oxylabsProxy.js";

describe("composeOxylabsUsername", () => {
    it("composes base username only", () => {
        expect(composeOxylabsUsername({ username: "testuser", password: "fakepassword123" })).toBe("user-testuser");
    });

    it("appends country", () => {
        expect(composeOxylabsUsername({ username: "testuser", password: "fakepassword123", country: "US" })).toBe(
            "user-testuser-country-US"
        );
    });

    it("throws when city is given (unsupported for datacenter proxies)", () => {
        expect(() =>
            composeOxylabsUsername({ username: "testuser", password: "fakepassword123", city: "paris" })
        ).toThrow();
    });

    it("throws when sessionId is given (unsupported via username for datacenter proxies)", () => {
        expect(() =>
            composeOxylabsUsername({ username: "testuser", password: "fakepassword123", sessionId: "abc12345" })
        ).toThrow();
    });
});

describe("resolveOxylabsEndpoint", () => {
    it.each([undefined, null, ""])("defaults to the datacenter entry endpoint for %j", (endpoint) => {
        expect(resolveOxylabsEndpoint(endpoint)).toBe("dc.oxylabs.io:8000");
    });

    it.each(["proxy.example.test:8001", "PROXY.Example.test:60000", "203.0.113.10:1", "localhost:65535"])(
        "accepts host:port %j unchanged",
        (endpoint) => {
            expect(resolveOxylabsEndpoint(endpoint)).toBe(endpoint);
        }
    );

    it.each([
        "proxy.example.test",
        ":8000",
        "proxy.example.test:",
        "proxy.example.test:0",
        "proxy.example.test:65536",
        "proxy.example.test:08a0",
        "http://proxy.example.test:8000",
        "user:secret@proxy.example.test:8000",
        "proxy.example.test:8000/path",
        " proxy.example.test:8000",
        "proxy..example.test:8000",
        "-proxy.example.test:8000",
        "proxy-.example.test:8000",
        "proxy_1.example.test:8000",
        `${"a".repeat(64)}.example.test:8000`,
        "proxy.example.test:8000;direct://",
        "[::1]:8000",
    ])("rejects %j", (endpoint) => {
        expect(() => resolveOxylabsEndpoint(endpoint)).toThrow(/host:port/);
    });

    it("rejects a non-string value from a hand-edited config file", () => {
        expect(() => resolveOxylabsEndpoint(8000)).toThrow(/host:port/);
    });
});

describe("buildOxylabsProxyUrl", () => {
    it("builds the full proxy URL against the default entry endpoint", () => {
        const url = buildOxylabsProxyUrl({ username: "testuser", password: "fakepassword123", country: "US" });
        expect(url).toBe("http://user-testuser-country-US:fakepassword123@dc.oxylabs.io:8000");
    });

    it("builds the full proxy URL against a configured entry endpoint", () => {
        const url = buildOxylabsProxyUrl({
            username: "testuser",
            password: "fakepassword123",
            endpoint: "proxy.example.test:8001",
        });
        expect(url).toBe("http://user-testuser:fakepassword123@proxy.example.test:8001");
    });

    it("refuses to build a URL for an invalid entry endpoint", () => {
        expect(() =>
            buildOxylabsProxyUrl({ username: "testuser", password: "fakepassword123", endpoint: "proxy.example.test" })
        ).toThrow(/host:port/);
    });
});
