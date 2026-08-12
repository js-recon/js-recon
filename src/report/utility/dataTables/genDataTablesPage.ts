import Database from "better-sqlite3";
import hljs from "highlight.js";
import { severityBadgeHtml } from "../severityColors.js";

interface AnalysisFinding {
    ruleId: string;
    ruleName: string;
    ruleType: string;
    ruleDescription: string;
    ruleAuthor: string;
    ruleTech: string;
    severity: string;
    message: string;
    findingLocation: string;
}

interface MappedData {
    id: string;
    description: string | null;
    containsFetch: number;
    isAxiosClient: number;
    exports: string | null;
    imports: string | null;
    file: string;
}

/**
 * Escapes HTML characters in a given string.
 * This function replaces the following characters with their HTML entity equivalents:
 * - & with &amp;
 * - < with &lt;
 * - > with &gt;
 * - " with &quot;
 * - ' with &#39;
 *
 * @param value - The string to escape. If null or undefined, an empty string is returned.
 * @returns The escaped string.
 */
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
 * Returns a boolean icon (✅ or ❌) based on the input value.
 *
 * @param b - The boolean value to convert to an icon.
 * @returns "✅" if the input is true, "❌" if the input is false.
 */
const booleanIcon = (b: number | boolean) => (b ? "✅" : "❌");

/**
 * Maps severity levels to sortable ranks.
 *
 * @param sev - The severity level to map.
 * @returns A number representing the severity rank.
 *
 * The mapping is as follows:
 * - "info" -> 0
 * - "low" -> 1
 * - "medium" -> 2
 * - "high" -> 3
 * - Any other value -> 99 (unknown values sort last)
 */
const severityRank = (sev: string): number => {
    const s = (sev || "").toString().toLowerCase().trim();
    switch (s) {
        case "info":
            return 0;
        case "low":
            return 1;
        case "medium":
            return 2;
        case "high":
            return 3;
        default:
            return 99; // unknown values sort last
    }
};

/**
 * Renders JavaScript code with syntax highlighting using highlight.js.
 *
 * @param code - The JavaScript code to render. If null or undefined, an empty string is used.
 * @returns A string containing the rendered code wrapped in a pre/code block with syntax highlighting.
 *
 * If the code cannot be highlighted (e.g., due to syntax errors), it falls back to plain text with HTML escaping.
 */
const renderJsCode = (code: string | null | undefined): string => {
    const src = code ?? "";
    try {
        const highlighted = hljs.highlight(src, { language: "javascript", ignoreIllegals: true }).value;
        return `<pre class="code-cell"><code class="hljs language-javascript">${highlighted}</code></pre>`;
    } catch {
        // Fallback to escaped plain text
        return `<pre class="code-cell">${escapeHtml(src)}</pre>`;
    }
};

/**
 * Generates a DataTables page based on the provided database.
 *
 * @param db - The database containing the findings and mapped data.
 * @returns A string containing the HTML for the DataTables page.
 *
 * The function queries the database for findings and mapped data, and generates
 * a DataTables page with sortable tables for both findings and mapped data.
 */
const genDataTablesPage = (db: Database.Database): string => {
    const findings = db.prepare(`SELECT * FROM analysis_findings`).all() as AnalysisFinding[];
    const mapped = db.prepare(`SELECT * FROM mapped`).all() as MappedData[];

    const findingsRows = findings
        .map(
            (f) => `
            <tr>
                <td>${escapeHtml(f.ruleId)}</td>
                <td>${escapeHtml(f.ruleName)}</td>
                <td>${escapeHtml(f.ruleType)}</td>
                <td>${escapeHtml(f.ruleDescription)}</td>
                <td>${escapeHtml(f.ruleAuthor)}</td>
                <td>${escapeHtml(f.ruleTech)}</td>
                <td data-order="${severityRank(f.severity)}">${severityBadgeHtml(f.severity)}</td>
                <td>${escapeHtml(f.message)}</td>
                <td>${renderJsCode(f.findingLocation)}</td>
            </tr>`
        )
        .join("\n");

    const mappedRows = mapped
        .map(
            (m) => `
            <tr>
                <td>${escapeHtml(m.id)}</td>
                <td>${escapeHtml(m.description)}</td>
                <td>${booleanIcon(m.containsFetch)}</td>
                <td>${booleanIcon(m.isAxiosClient)}</td>
                <td>${escapeHtml(m.exports)}</td>
                <td>${escapeHtml(m.imports)}</td>
                <td>${escapeHtml(m.file)}</td>
            </tr>`
        )
        .join("\n");

    const html = `
    <section>
      <h2>Analyze Findings (Sortable)</h2>
      <table id="findings-table" class="display data-table" style="width:100%">
        <thead>
          <tr>
            <th>Rule ID</th>
            <th>Name</th>
            <th>Type</th>
            <th>Description</th>
            <th>Author</th>
            <th>Tech</th>
            <th>Severity</th>
            <th>Message</th>
            <th>Location</th>
          </tr>
        </thead>
        <tbody>
          ${findingsRows}
        </tbody>
      </table>

      <h2 style="margin-top: 2rem;">Mapped Data (Sortable)</h2>
      <table id="mapped-table" class="display data-table" style="width:100%">
        <thead>
          <tr>
            <th>ID</th>
            <th>Description</th>
            <th>Contains Fetch</th>
            <th>Axios Client</th>
            <th>Exports</th>
            <th>Imports</th>
            <th>File</th>
          </tr>
        </thead>
        <tbody>
          ${mappedRows}
        </tbody>
      </table>
    </section>`;

    return html;
};

export default genDataTablesPage;
