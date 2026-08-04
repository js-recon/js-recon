#!/usr/bin/env node
/**
 * Smoke test: verifies that all expected js-recon-rules fired against the
 * vuln-all-rules lab app.
 *
 * Usage:
 *   node scripts/smoke-test.js [path-to-analyze.json]
 *
 * Default path: output/localhost_3001/analyze.json
 */

import { readFileSync } from "fs";
import { resolve } from "path";

const outputPath = process.argv[2] || "output/localhost_3001/analyze.json";
const absolutePath = resolve(outputPath);

let analyzeData;
try {
    analyzeData = JSON.parse(readFileSync(absolutePath, "utf-8"));
} catch (err) {
    console.error(`[!] Could not read ${absolutePath}: ${err.message}`);
    console.error("    Make sure js-recon run completed successfully before running smoke-test.");
    process.exit(1);
}

// All rules expected to fire against the vuln-all-rules Next.js app.
// Note: detect_angular_bypass_security_trust is excluded (angular-only).
const EXPECTED_RULES = [
    // AST rules
    "detect_dom_xss_innerHTML_url_source",
    "detect_dom_setattribute_url_param",
    "detect_dom_xss_dangerouslySetInnerHTML",
    "detect_json_injection_to_dangerouslysetinnerhtml",
    "detect_open_redirect_url_param",
    "detect_link_manipulation_href",
    "detect_storage_manipulation_url_param",
    "detect_cookie_manipulation_url_param",
    "detect_websocket_url_poisoning",
    "detect_js_injection_eval",
    "detect_redos_url_param",
    "detect_cspt_fetch_url_param",
    "detect_cspt_xhr_url_param",
    "detect_ajax_header_manipulation",
    "detect_postMessage",
    "detect_postMessage_innerHtml_sink",
    "detect_postMessage_function_href",
    "detect_postMessage_wildcard_origin",
    "detect_postmessage_eval",
    "detect_postmessage_weak_origin_check",
    "detect_hardcoded_secrets",
    "detect_css_injection_style_sink",
    "detect_react_createelement_dynamic_type",
    "detect_jquery_html_injection_url_param",
    "detect_dompurify_forcekeepattr_hook",
    "detect_client_side_authz_gate",
    "detect_insecure_random_token_storage",
    "detect_cloud_credentials_in_bundle",
    "detect_hardcoded_hmac_signing_key",
    "detect_non_global_regex_sanitizer",
    "detect_prototype_pollution_merge_gadget",
    // Request rules
    "api_path",
    "admin_api",
    "missing_authorization_header",
];

const firedRules = new Set(analyzeData.map((r) => r.ruleId));
const missingRules = EXPECTED_RULES.filter((r) => !firedRules.has(r));

console.log(`[i] Findings in analyze.json: ${analyzeData.length}`);
console.log(`[i] Distinct rule IDs that fired: ${firedRules.size}`);
console.log(`[i] Expected rules: ${EXPECTED_RULES.length}`);
console.log();

if (missingRules.length > 0) {
    console.error("[!] The following expected rules did NOT fire:");
    for (const r of missingRules) {
        console.error(`      - ${r}`);
    }
    console.error();
    console.error(`[!] ${missingRules.length} / ${EXPECTED_RULES.length} rules missing. Smoke test FAILED.`);
    process.exit(1);
}

console.log(`[✓] All ${EXPECTED_RULES.length} expected rules fired. Smoke test PASSED.`);
