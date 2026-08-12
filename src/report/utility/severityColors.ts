/**
 * Shared severity → color mapping and badge rendering, used by both the
 * DataTables findings table and the markdown finding write-up so the two
 * surfaces stay visually consistent.
 */

export interface SeverityColor {
    bg: string;
    text: string;
    border: string;
}

export const SEVERITY_COLORS: Record<string, SeverityColor> = {
    info: { bg: "var(--sev-info-bg)", text: "var(--sev-info-text)", border: "var(--sev-info-border)" },
    low: { bg: "var(--sev-low-bg)", text: "var(--sev-low-text)", border: "var(--sev-low-border)" },
    medium: { bg: "var(--sev-medium-bg)", text: "var(--sev-medium-text)", border: "var(--sev-medium-border)" },
    high: { bg: "var(--sev-high-bg)", text: "var(--sev-high-text)", border: "var(--sev-high-border)" },
};

const escapeHtml = (value: unknown): string => {
    const str = value === null || value === undefined ? "" : String(value);
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
};

/**
 * Renders a severity value as a colored badge span.
 *
 * @param severity - The severity string (e.g. "info", "low", "medium", "high")
 * @returns HTML for a `<span class="badge badge-<severity>">` element. Unknown
 * severities fall back to a neutral "badge-unknown" style.
 */
export const severityBadgeHtml = (severity: string | null | undefined): string => {
    const key = (severity || "").toString().toLowerCase().trim();
    const known = Object.prototype.hasOwnProperty.call(SEVERITY_COLORS, key);
    const cls = known ? `badge-${key}` : "badge-unknown";
    const label = escapeHtml(severity ?? "unknown");
    return `<span class="badge ${cls}">${label}</span>`;
};
