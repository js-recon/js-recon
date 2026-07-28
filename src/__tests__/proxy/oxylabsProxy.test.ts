import { describe, it, expect } from "vitest";
import { composeOxylabsUsername, buildOxylabsProxyUrl } from "../../proxy/oxylabsProxy.js";

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

describe("buildOxylabsProxyUrl", () => {
    it("builds the full proxy URL against the fixed entry endpoint", () => {
        const url = buildOxylabsProxyUrl({ username: "testuser", password: "fakepassword123", country: "US" });
        expect(url).toBe("http://user-testuser-country-US:fakepassword123@dc.oxylabs.io:8000");
    });
});
