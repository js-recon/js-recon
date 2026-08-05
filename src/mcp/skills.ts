import fs from "fs";
import os from "os";
import path from "path";
import YAML from "yaml";

const SKILLS_DIR = path.join(os.homedir(), ".js-recon", "skills");

export interface SkillParam {
    name: string;
    required?: boolean;
    description?: string;
}

export interface SkillPreAction {
    tool: "run" | "lazyload";
    args: Record<string, string>;
}

export interface Skill {
    name: string;
    description: string;
    params: SkillParam[];
    preActions: SkillPreAction[];
    body: string;
    filePath: string;
}

let cache: Skill[] | null = null;

const parseFrontmatter = (raw: string): { meta: any; body: string } => {
    if (!raw.startsWith("---")) return { meta: {}, body: raw };
    const end = raw.indexOf("\n---", 3);
    if (end === -1) return { meta: {}, body: raw };
    const yamlBlock = raw.slice(3, end).trim();
    const body = raw.slice(end + 4).replace(/^\n/, "");
    let meta: any = {};
    try {
        meta = YAML.parse(yamlBlock) || {};
    } catch {
        meta = {};
    }
    return { meta, body };
};

const readSkillFile = (filePath: string): Skill | null => {
    const raw = fs.readFileSync(filePath, "utf-8");
    const { meta, body } = parseFrontmatter(raw);
    const name = meta.name || path.basename(filePath, path.extname(filePath));
    if (!name) return null;
    const preActions: SkillPreAction[] = Array.isArray(meta.pre_actions)
        ? meta.pre_actions
              .filter((a: any) => a && (a.tool === "run" || a.tool === "lazyload"))
              .map((a: any) => ({ tool: a.tool, args: a.args && typeof a.args === "object" ? a.args : {} }))
        : [];
    return {
        name,
        description: meta.description || "",
        params: Array.isArray(meta.params) ? meta.params : [],
        preActions,
        body,
        filePath,
    };
};

export const getSkillsDir = (): string => SKILLS_DIR;

export const loadSkills = (force = false): Skill[] => {
    if (cache && !force) return cache;
    const skills: Skill[] = [];
    if (fs.existsSync(SKILLS_DIR)) {
        for (const entry of fs.readdirSync(SKILLS_DIR)) {
            if (!entry.endsWith(".md")) continue;
            const skill = readSkillFile(path.join(SKILLS_DIR, entry));
            if (skill) skills.push(skill);
        }
    }
    cache = skills;
    return skills;
};

export const findSkill = (name: string): Skill | undefined => {
    return loadSkills().find((s) => s.name === name);
};

/**
 * Parses skill argument strings like `--target https://x --foo=bar`.
 * Bare values fold into the first declared param if it isn't set explicitly.
 */
export const parseSkillArgs = (input: string, skill?: Skill): Record<string, string> => {
    const out: Record<string, string> = {};
    const positional: string[] = [];
    // eslint-disable-next-line security/detect-unsafe-regex -- alternatives are mutually exclusive by first char and input is one bounded CLI command line — not exploitable
    const tokens = input.match(/(?:[^\s"]+|"[^"]*")+/g) || [];

    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i].replace(/^"|"$/g, "");
        if (tok.startsWith("--")) {
            const eq = tok.indexOf("=");
            if (eq !== -1) {
                out[tok.slice(2, eq)] = tok.slice(eq + 1);
            } else {
                const key = tok.slice(2);
                const next = tokens[i + 1];
                if (next && !next.startsWith("--")) {
                    out[key] = next.replace(/^"|"$/g, "");
                    i++;
                } else {
                    out[key] = "true";
                }
            }
        } else {
            positional.push(tok);
        }
    }

    if (skill && positional.length > 0) {
        const firstParam = skill.params[0];
        if (firstParam && !(firstParam.name in out)) {
            out[firstParam.name] = positional.join(" ");
        }
    }

    return out;
};

export interface RenderResult {
    ok: boolean;
    prompt?: string;
    error?: string;
}

export const renderSkill = (skill: Skill, args: Record<string, string>): RenderResult => {
    for (const p of skill.params) {
        if (p.required && !args[p.name]) {
            return { ok: false, error: `Missing required parameter: --${p.name}` };
        }
    }
    let body = skill.body;
    for (const [k, v] of Object.entries(args)) {
        body = body.split(`<${k}>`).join(v);
    }
    return { ok: true, prompt: body };
};
