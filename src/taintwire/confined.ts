/**
 * Which confinements make a taintwire finding safe, per rule (`taintwire analyze --suppress-confined`). A confinement
 * (taintwire-queries `lib/confinements.pgq`) says where the tainted value lands in its sink; only some positions are a
 * barrier for a given sink:
 *
 * - Navigation and link sinks: a same-origin path, the query, the fragment or a fixed origin can't send the page
 *   elsewhere or turn into a javascript: URL.
 * - Request sinks (client-side path traversal): only the query or fragment. After a fixed path or origin the value
 *   can still hold "../" and reach another endpoint.
 * - jQuery selector sinks: a selector string that doesn't start with "<" (jQuery >= 1.9 doesn't parse it as HTML).
 * - history.pushState/replaceState and a postMessage with a pinned target origin: the sink API itself.
 *
 * Rules not listed here (script_injection_url, open_redirect_location_parts, ...) are never suppressed: a same-origin
 * script URL can still load a JSONP endpoint, and a location part isn't a whole URL.
 */
const SAFE: Record<string, readonly string[]> = {
    open_redirect_url: ["path", "query", "fragment", "origin"],
    link_manipulation_url: ["path", "query", "fragment", "origin"],
    cspt_url_request: ["query", "fragment"],
    cspt_extended_request: ["query", "fragment"],
    jquery_selector_url: ["selector"],
    dom_xss_framework_sinks: ["selector"],
    dom_data_manipulation: ["sink"],
    web_message_manipulation: ["sink"],
};

/** True when one of the finding's confinements is a barrier for its rule. */
export const isConfined = (ruleId: string, confinements: { kind: string }[] = []): boolean =>
    confinements.some((c) => SAFE[ruleId]?.includes(c.kind) ?? false);
