import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    containsRenderedPageSegment,
    decodeHtmlFlight,
    saveRsfLeak,
    RSF_LEAKS_DIR,
} from "../../lazyLoad/next_js/next_rsf/rsfShared.js";
import { isRedirectBodyLeak, isRscLeakResponse } from "../../lazyLoad/next_js/next_rsf/next_rsfRedirectLeak.js";
import { extractInterceptionSegments } from "../../lazyLoad/next_js/next_rsf/next_interceptRouteNextUrl.js";
import { VALID_METHODS } from "../../lazyLoad/methodFilter.js";

const REDIRECT_ROW = '7:E{"digest":"NEXT_REDIRECT;replace;/login;307;"}';

/** A 16.4-shaped `__PAGE__` segment row whose page slot is `pageSlot`. */
const page16 = (pageSlot: string): string =>
    `9:[["children",{"s":"__PAGE__","h":514,"d":{"r":["$","$1","c",{"children":[${pageSlot},null,["$","$La",null,{"children":"$@c"}]]}],"p":true,"v":"$d"}}]]`;

/** Wraps Flight text the way Next.js inlines it into HTML. */
const asHtml = (flight: string): string =>
    flight
        .split(/(?<=\n)/)
        .map((chunk) => `<script>self.__next_f.push([1,${JSON.stringify(chunk)}])</script>`)
        .join("");

const rsc = (body: string, status = 200) => ({
    status,
    headers: { "content-type": "text/x-component" },
    body,
});

describe("containsRenderedPageSegment", () => {
    it("detects an inline element in the 16.4 object-shaped page segment (static layout redirect)", () => {
        const flight = `${page16('["$","div",null,{"children":"hidden text"}]')}\n${REDIRECT_ROW}\n`;
        expect(containsRenderedPageSegment(flight)).toBe(true);
    });

    it("follows a lazy reference to an element row (partially prerendered page)", () => {
        const flight = `${page16('"$Le"')}\n${REDIRECT_ROW}\ne:["$","div",null,{"children":"hidden text"}]\n`;
        expect(containsRenderedPageSegment(flight)).toBe(true);
    });

    it("follows a reference to a text row", () => {
        expect(containsRenderedPageSegment(`${page16('"$Le"')}\ne:T5,hello\n`)).toBe(true);
    });

    it("finds a row that starts after a ',' in a resumed stream", () => {
        expect(containsRenderedPageSegment(`${page16('"$Le"')}\n1d:o61,e:["$","p",null,{}]\n`)).toBe(true);
    });

    it("rejects a page that itself called redirect() (its slot is the error row)", () => {
        const flight = `${page16('"$L7"')}\n${REDIRECT_ROW}\n`;
        expect(containsRenderedPageSegment(flight)).toBe(false);
    });

    it("rejects a page slot that rendered nothing", () => {
        expect(containsRenderedPageSegment(page16("null"))).toBe(false);
    });

    it("rejects a reference to a row that isn't in the payload", () => {
        expect(containsRenderedPageSegment(page16('"$L42"'))).toBe(false);
    });

    it("stops on a reference cycle", () => {
        expect(containsRenderedPageSegment(`${page16('"$La"')}\na:"$Lb"\nb:"$La"\n`)).toBe(false);
    });

    it("rejects internal string markers such as $undefined", () => {
        expect(containsRenderedPageSegment(page16('"$undefined"'))).toBe(false);
    });

    it("detects the older array-shaped page segment", () => {
        const flight = '2:["__PAGE__",{},["$","$1","c",{"children":[["$","p",null,{"children":"x"}],null]}]]';
        expect(containsRenderedPageSegment(flight)).toBe(true);
    });

    it("returns false without a page segment", () => {
        expect(containsRenderedPageSegment(REDIRECT_ROW)).toBe(false);
        expect(containsRenderedPageSegment("")).toBe(false);
    });
});

describe("decodeHtmlFlight", () => {
    it("joins and unescapes every __next_f.push string in order", () => {
        const flight = `0:"a"\n${REDIRECT_ROW}\n`;
        expect(decodeHtmlFlight(asHtml(flight))).toBe(flight);
    });

    it("skips the bootstrap push and malformed chunks", () => {
        const html = '<script>self.__next_f.push([0])</script><script>self.__next_f.push([1,"ok"])</script>';
        expect(decodeHtmlFlight(html)).toBe("ok");
    });

    it("returns an empty string for HTML without Flight data", () => {
        expect(decodeHtmlFlight("<html><body>hi</body></html>")).toBe("");
    });
});

describe("isRedirectBodyLeak", () => {
    const leakFlight = `${page16('["$","div",null,{"children":"hidden text"}]')}\n${REDIRECT_ROW}\n`;

    it("flags a 3xx HTML body carrying a rendered page next to the redirect", () => {
        expect(isRedirectBodyLeak({ status: 307, headers: {}, body: asHtml(leakFlight) })).toBe(true);
    });

    it("ignores a 2xx response", () => {
        expect(isRedirectBodyLeak({ status: 200, headers: {}, body: asHtml(leakFlight) })).toBe(false);
    });

    it("ignores an empty middleware/proxy redirect", () => {
        expect(isRedirectBodyLeak({ status: 307, headers: {}, body: "" })).toBe(false);
    });

    it("ignores a redirect whose page slot is the redirect error", () => {
        const body = asHtml(`${page16('"$L7"')}\n${REDIRECT_ROW}\n`);
        expect(isRedirectBodyLeak({ status: 307, headers: {}, body })).toBe(false);
    });

    it("requires the NEXT_REDIRECT record", () => {
        const body = asHtml(page16('["$","div",null,{}]'));
        expect(isRedirectBodyLeak({ status: 302, headers: {}, body })).toBe(false);
    });
});

describe("isRscLeakResponse", () => {
    const leak = `${page16('"$Le"')}\n${REDIRECT_ROW}\ne:["$","div",null,{}]\n`;

    it("flags a 200 RSC payload with a rendered page and a redirect record", () => {
        expect(isRscLeakResponse(rsc(leak))).toBe(true);
    });

    it("requires text/x-component", () => {
        expect(isRscLeakResponse({ ...rsc(leak), headers: { "content-type": "text/html" } })).toBe(false);
    });

    it("requires a 200", () => {
        expect(isRscLeakResponse(rsc(leak, 307))).toBe(false);
    });

    it("ignores an ordinary page with no redirect", () => {
        expect(isRscLeakResponse(rsc(page16('["$","div",null,{}]')))).toBe(false);
    });
});

describe("extractInterceptionSegments", () => {
    it("reads 16.4 object-shaped and older array-shaped intercepting segments", () => {
        expect(extractInterceptionSegments('a:[["children",{"s":"(..)pub","h":1}]]\nb:["(.)photo",{}]')).toEqual([
            "(..)pub",
            "(.)photo",
        ]);
    });

    it("reads the (...) and (..)(..) markers", () => {
        expect(extractInterceptionSegments('["(...)feed"],["(..)(..)item"]')).toEqual(["(...)feed", "(..)(..)item"]);
    });

    it("decodes HTML-inlined Flight data first", () => {
        expect(extractInterceptionSegments(asHtml('e:[["children",{"s":"(..)pub"}]]\n'))).toEqual(["(..)pub"]);
    });

    it("ignores route groups and plain parenthesized text", () => {
        expect(extractInterceptionSegments('["(marketing)",{}],"(see docs)"')).toEqual([]);
    });
});

describe("saveRsfLeak", () => {
    let dir: string;
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("writes the body under ___rsf_revealed/<method>/ and returns its index entry", () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "rsf-"));
        const entry = saveRsfLeak(
            dir,
            { method: "next_rsfRscHeaderLeak", url: "http://h/org/1/secret?_rsc=x", body: "BODY", ext: "rsc" },
            ["http://h/_next/static/chunks/a.js"]
        );
        expect(entry.file.startsWith(path.join(RSF_LEAKS_DIR, "next_rsfRscHeaderLeak", "org_1_secret-"))).toBe(true);
        expect(entry.file.endsWith(".rsc")).toBe(true);
        expect(fs.readFileSync(path.join(dir, entry.file), "utf8")).toBe("BODY");
        expect(entry.chunks).toEqual(["http://h/_next/static/chunks/a.js"]);
    });

    it("keeps the root path and distinct request headers apart", () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "rsf-"));
        const base = { method: "next_interceptRouteNextUrl", url: "http://h/", body: "x", ext: "html" as const };
        const a = saveRsfLeak(dir, { ...base, requestHeaders: { "Next-Url": "/a" } }, []);
        const b = saveRsfLeak(dir, { ...base, requestHeaders: { "Next-Url": "/b" } }, []);
        expect(path.basename(a.file).startsWith("index-")).toBe(true);
        expect(a.file).not.toBe(b.file);
    });

    it("never writes outside the leaks directory", () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "rsf-"));
        const entry = saveRsfLeak(
            dir,
            { method: "next_rsfRedirectBodyLeak", url: "http://h/..%2F..%2Fetc/passwd", body: "x", ext: "html" },
            []
        );
        expect(path.resolve(dir, entry.file).startsWith(path.resolve(dir, RSF_LEAKS_DIR) + path.sep)).toBe(true);
    });
});

describe("method registry", () => {
    it("registers both redirect-response methods", () => {
        expect(VALID_METHODS).toContain("next_rsfRedirectBodyLeak");
        expect(VALID_METHODS).toContain("next_rsfRscHeaderLeak");
    });
});
