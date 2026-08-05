import fs from "fs";
import path from "path";
import YAML from "yaml";

export interface TrufflehogConfig {
    terms_accepted: boolean;
}

const DEFAULT_CONFIG: TrufflehogConfig = {
    terms_accepted: false,
};

const CONFIG_DIR = path.join(process.env.HOME || "~", ".js-recon");
const CONFIG_FILE = path.join(CONFIG_DIR, "trufflehog.yaml");

const ensureConfigDir = (): void => {
    if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
};

const loadConfig = (): TrufflehogConfig => {
    ensureConfigDir();
    if (!fs.existsSync(CONFIG_FILE)) {
        return { ...DEFAULT_CONFIG };
    }

    try {
        const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
        const parsed = YAML.parse(raw) as Partial<TrufflehogConfig>;
        return { ...DEFAULT_CONFIG, ...parsed };
    } catch {
        return { ...DEFAULT_CONFIG };
    }
};

const saveConfig = (config: TrufflehogConfig): void => {
    ensureConfigDir();
    fs.writeFileSync(CONFIG_FILE, YAML.stringify(config), "utf-8");
};

export const isConsentGiven = (): boolean => loadConfig().terms_accepted;

export const giveConsent = (): void => {
    saveConfig({ ...loadConfig(), terms_accepted: true });
};
