import chalk from "chalk";

// file deepcode ignore HardcodedNonCryptoSecret: False positive
const secret_patterns = {
    Cloudinary: "cloudinary://.*",
    "Firebase URL": ".*firebaseio\\.com",
    "Slack Token": "(xox[p|b|o|a]-[0-9]{12}-[0-9]{12}-[0-9]{12}-[a-z0-9]{32})",
    "RSA private key": "-----BEGIN RSA PRIVATE KEY-----",
    "SSH (DSA) private key": "-----BEGIN DSA PRIVATE KEY-----",
    "SSH (EC) private key": "-----BEGIN EC PRIVATE KEY-----",
    "PGP private key block": "-----BEGIN PGP PRIVATE KEY BLOCK-----",
    "Amazon AWS Access Key ID": "AKIA[0-9A-Z]{16}",
    "Amazon MWS Auth Token": "amzn\\.mws\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
    "Facebook Access Token": "EAACEdEose0cBA[0-9A-Za-z]+",
    "Facebook OAuth": "[f|F][a|A][c|C][e|E][b|B][o|O][o|O][k|K].*['|\"][0-9a-f]{32}['|\"]",
    GitHub: "[g|G][i|I][t|T][h|H][u|U][b|B].*['|\"][0-9a-zA-Z]{35,40}['|\"]",
    "Generic API Key": "[a|A][p|P][i|I][_]?[k|K][e|E][y|Y].*['|\"][0-9a-zA-Z]{32,45}['|\"]",
    "Generic Secret": "[s|S][e|E][c|C][r|R][e|E][t|T].*['|\"][0-9a-zA-Z]{32,45}['|\"]",
    "Google API Key": "AIza[0-9A-Za-z\\-_]{35}",
    "Google Cloud Platform API Key": "AIza[0-9A-Za-z\\-_]{35}",
    "Google Cloud Platform OAuth": "[0-9]+-[0-9A-Za-z_]{32}\\.apps\\.googleusercontent\\.com",
    "Google Drive API Key": "AIza[0-9A-Za-z\\-_]{35}",
    "Google Drive OAuth": "[0-9]+-[0-9A-Za-z_]{32}\\.apps\\.googleusercontent\\.com",
    "Google (GCP) Service-account": '\\"type\\": \\"service_account\\"',
    "Google Gmail API Key": "AIza[0-9A-Za-z\\-_]{35}",
    "Google Gmail OAuth": "[0-9]+-[0-9A-Za-z_]{32}\\.apps\\.googleusercontent\\.com",
    "Google OAuth Access Token": "ya29\\.[0-9A-Za-z\\-_]+",
    "Google YouTube API Key": "AIza[0-9A-Za-z\\-_]{35}",
    "Google YouTube OAuth": "[0-9]+-[0-9A-Za-z_]{32}\\.apps\\.googleusercontent\\.com",
    "Heroku API Key - 1":
        "[h|H][e|E][r|R][o|O][k|K][u|U].*[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}",
    "Heroku API Key - 2": "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
    "MailChimp API Key": "[0-9a-f]{32}-us[0-9]{1,2}",
    "Mailgun API Key": "key-[0-9a-zA-Z]{32}",
    "Password in URL": "[a-zA-Z]{3,10}://[^/\\s:@]{3,20}:[^/\\s:@]{3,20}@.{1,100}[\\\"'\\s]",
    "PayPal Braintree Access Token": "access_token\\$production\\$[0-9a-z]{16}\\$[0-9a-f]{32}",
    "Picatic API Key": "sk_live_[0-9a-z]{32}",
    "Slack Webhook": "https://hooks.slack.com/services/T[a-zA-Z0-9_]{8}/B[a-zA-Z0-9_]{8}/[a-zA-Z0-9_]{24}",
    "Stripe API Key": "sk_live_[0-9a-zA-Z]{24}",
    "Stripe Restricted API Key": "rk_live_[0-9a-zA-Z]{24}",
    "Square Access Token": "sq0atp-[0-9A-Za-z\\-_]{22}",
    "Square OAuth Secret": "sq0csp-[0-9A-Za-z\\-_]{43}",
    "Twilio API Key": "SK[0-9a-fA-F]{32}",
    "Twitter Access Token": "[t|T][w|W][i|I][t|T][t|T][e|E][r|R].*[1-9][0-9]+-[0-9a-zA-Z]{40}",
    "Twitter OAuth": "[t|T][w|W][i|I][t|T][t|T][e|E][r|R].*['|\"][0-9a-zA-Z]{35,44}['|\"]",
    "OpenAI User API Key": "sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}",
    "OpenAI User Project Key": "sk-proj-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}",
    "OpenAI Service ID": "^[A-Za-z0-9]+(-*[A-Za-z0-9]+)*$",
    "OpenAI Service Key": "sk-{SERVICE ID}-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}",
    Wakatime: "waka_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
    "Artifactory API Token": '(?:\\s|=|:|"|^)AKC[a-zA-Z0-9]{10,}',
    "Artifactory Password": '(?:\\s|=|:|"|^)AP[\\dABCDEF][a-zA-Z0-9]{8,}',
    "Authorization Basic": "basic [a-zA-Z0-9_:\\\.=\-]+",
    "Authorization Bearer": "bearer [a-zA-Z0-9_\\\.=\-]+",
    "AWS Client ID": "(A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}",
    "AWS MWS Key": "amzn\\.mws\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
    Base64: "(eyJ|YTo|Tzo|PD[89]|aHR0cHM6L|aHR0cDo|rO0)[a-zA-Z0-9+/]+={0,2}",
    "Basic Auth Credentials": "(?<=:\/\/ )[a-zA-Z0-9]+:[a-zA-Z0-9]+@[a-zA-Z0-9]+\\.[a-zA-Z]+",
    "Cloudinary Basic Auth": "cloudinary:\/\/[0-9]{15}:[0-9A-Za-z]+@[a-z]+",
    "Facebook Client ID": "(?:[Ff](?:[Aa][Cc][Ee][Bb][Oo][Oo][Kk])|[Ff][Bb])(?:.{0,20})?['\"][0-9]{13,17}",
    "Facebook Secret Key": "(?:[Ff](?:[Aa][Cc][Ee][Bb][Oo][Oo][Kk])|[Ff][Bb])(?:.{0,20})?['\"][0-9a-fA-F]{32}",
    "Google Oauth Access Token": "ya29\\.[0-9A-Za-z\\-_]+",
    "Heroku API Key":
        "[h|H][e|E][r|R][o|O][k|K][u|U].{0,30}[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}",
    "LinkedIn Client ID": "(?:[Ll]inked[Ii]n)(?:.{0,20})?['\"][0-9a-zA-Z]{12}['\"]",
    "LinkedIn Secret Key": "(?:[Ll]inked[Ii]n)(?:.{0,20})?['\"][0-9a-zA-Z]{16}['\"]",
    "MD5 Hash": "[a-f0-9]{32}",
};

interface SecretMatch {
    name: string;
    value: string;
}

/**
 * Scans source code for potential secrets and sensitive information using regex patterns.
 *
 * This function searches through source code to identify various types of secrets including:
 * - API keys (AWS, Google, Facebook, etc.)
 * - OAuth tokens and access tokens
 * - Private keys and certificates
 * - Database credentials and connection strings
 * - Authentication tokens and passwords
 *
 * @param source - The source code string to scan for secrets
 * @returns Promise that resolves to an array of found secrets with their names and values
 */
const secrets = async (source: string): Promise<SecretMatch[]> => {
    const foundSecrets: SecretMatch[] = [];
    for (const [secretName, pattern] of Object.entries(secret_patterns)) {
        // eslint-disable-next-line security/detect-non-literal-regexp -- pattern is a hardcoded value from the static secret_patterns map, not external input
        const regex = new RegExp(pattern, "g");
        const matches = source.matchAll(regex);
        for (const match of matches) {
            foundSecrets.push({
                name: secretName,
                value: match[0],
            });
        }
    }
    return foundSecrets;
};

export default secrets;
