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

/** Why each kind is a barrier, for the findings' `explanation.confinements.reason`. */
const WHY: Record<string, string> = {
    path: "a same-origin path",
    query: "the query",
    fragment: "the fragment",
    origin: "a fixed origin",
    selector: 'a jQuery selector that doesn\'t start with "<" (not parsed as HTML in jQuery >= 1.9)',
    sink: "a sink API that confines it (same-origin pushState/replaceState, or a pinned postMessage target)",
};

/** The rule's barrier kinds; own keys only, so a rule id like "constructor" gets none. */
const safeKinds = (ruleId: string): readonly string[] | undefined =>
    Object.prototype.hasOwnProperty.call(SAFE, ruleId) ? SAFE[ruleId] : undefined;

/** True when one of the finding's confinements is a barrier for its rule. */
export const isConfined = (ruleId: string, confinements: { kind: string }[] = []): boolean =>
    confinements.some((c) => safeKinds(ruleId)?.includes(c.kind) ?? false);

/**
 * The reasoning that the finding's confinements give, kept apart from its interceptors: whether they make it safe for
 * its rule (the policy `--suppress-confined` applies), the kinds found, and why. Undefined without confinements.
 */
export const explainConfinements = (ruleId: string, confinements: { kind: string }[] = []) => {
    if (!confinements.length) return undefined;
    const kinds = [...new Set(confinements.map((c) => c.kind))];
    const policy = safeKinds(ruleId);
    const safe = kinds.filter((k) => policy?.includes(k));
    const reason = safe.length
        ? `the value lands in ${safe.map((k) => WHY[k] ?? k).join(" and ")}, a barrier for ${ruleId}`
        : policy
          ? `${kinds.join(", ")} is not a barrier for ${ruleId} (only ${policy.join(", ")})`
          : `no confinement is a barrier for ${ruleId}`;
    return { barrier: safe.length > 0, kinds, reason };
};

/**
 * The reasoning that the finding's interceptors give. There is no interceptor policy yet: they describe the conditions
 * before the sink but are never judged a barrier, so `barrier` is always null. Undefined without interceptors.
 */
export const explainInterceptors = (interceptors: { kind: string }[] = []) =>
    interceptors.length
        ? {
              barrier: null,
              kinds: [...new Set(interceptors.map((i) => i.kind))],
              reason: "conditions before the sink; not judged a barrier (no interceptor policy)",
          }
        : undefined;

/** A finding's `explanation` (taintwire.json and SARIF `properties`): each side only when the finding has its rows. */
export const explain = (f: {
    ruleId: string;
    interceptors?: { kind: string }[];
    confinements?: { kind: string }[];
}) => {
    const interceptors = explainInterceptors(f.interceptors);
    const confinements = explainConfinements(f.ruleId, f.confinements);
    return { ...(interceptors && { interceptors }), ...(confinements && { confinements }) };
};
