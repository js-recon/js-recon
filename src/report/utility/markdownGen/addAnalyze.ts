import Database from "better-sqlite3";
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

/**
 * Adds an analyze section to the markdown.
 *
 * @param markdown - The markdown string to add the analyze section to
 * @param db - The database containing the findings
 *
 * @returns A promise that resolves with the markdown string containing the analyze section
 */
const addAnalyze = async (markdown: string, db: Database.Database): Promise<string> => {
    let toReturn = markdown;
    toReturn += `\n## Analyze Results\n`;
    const findings = db.prepare(`SELECT * FROM analysis_findings`).all() as AnalysisFinding[];
    if (findings.length > 0) {
        const groupedFindings: { [key: string]: AnalysisFinding[] } = {};
        for (const finding of findings) {
            if (!groupedFindings[finding.ruleType]) {
                groupedFindings[finding.ruleType] = [];
            }
            groupedFindings[finding.ruleType].push(finding);
        }

        for (const ruleType in groupedFindings) {
            toReturn += `### ${ruleType.toUpperCase()}\n`;
            for (const finding of groupedFindings[ruleType]) {
                toReturn += `#### ${finding.ruleName}, ${finding.ruleDescription}\n`;
                let findingLocationBlock = "";
                if (ruleType.toLowerCase() === "ast") {
                    findingLocationBlock = "```js\n" + finding.findingLocation + "\n```";
                } else {
                    findingLocationBlock = "```\n" + finding.findingLocation + "\n```";
                }
                toReturn += `${findingLocationBlock}\n`;
                toReturn += `- **Rule ID:** ${finding.ruleId}\n`;
                toReturn += `- **Severity:** ${severityBadgeHtml(finding.severity)}\n`;
                toReturn += `- **Message:** ${finding.message}\n`;
                toReturn += `- **Author:** ${finding.ruleAuthor}\n`;
                toReturn += `- **Technology:** ${finding.ruleTech}\n\n`;
            }
        }
    }

    return toReturn;
};

export default addAnalyze;
