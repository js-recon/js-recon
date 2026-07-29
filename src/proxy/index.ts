import chalk from "chalk";
import inquirer from "inquirer";
import { APIGatewayClient, CreateRestApiCommand, DeleteRestApiCommand } from "@aws-sdk/client-api-gateway";
import checkFeasibility from "./checkFeasibility.js";
import { readAwsGatewayMap, writeAwsGatewayMap } from "./awsConfig.js";
import { readProxyConfigFile, setActiveProxyMethod, writeMethodConfig } from "./configFile.js";
import { parseProxyUrl } from "./genericProxy.js";
import { composeOxylabsUsername, type OxylabsConfig } from "./oxylabsProxy.js";
import { resolveProxyConfig } from "./resolveProxyConfig.js";
import * as globals from "../utility/globals.js";

type ProxyMethod = "aws" | "socks" | "http" | "oxylabs";
const VALID_PROXY_METHODS: ProxyMethod[] = ["aws", "socks", "http", "oxylabs"];

// read the docs for all the methods for api gateway at https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/api-gateway/
// for the rate limits, refer to https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html

/**
 * Selects a random AWS region from the available API Gateway regions.
 *
 * @returns A randomly selected AWS region identifier
 */
const randomRegion = (): string => {
    const apiGatewayRegions = [
        "us-east-2", // US East (Ohio)
        "us-east-1", // US East (N. Virginia)
        "us-west-1", // US West (N. California)
        "us-west-2", // US West (Oregon)
        "af-south-1", // Africa (Cape Town)
        "ap-east-1", // Asia Pacific (Hong Kong)
        "ap-south-2", // Asia Pacific (Hyderabad)
        "ap-southeast-3", // Asia Pacific (Jakarta)
        "ap-southeast-5", // Asia Pacific (Malaysia)
        "ap-southeast-4", // Asia Pacific (Melbourne)
        "ap-south-1", // Asia Pacific (Mumbai)
        "ap-northeast-3", // Asia Pacific (Osaka)
        "ap-northeast-2", // Asia Pacific (Seoul)
        "ap-southeast-1", // Asia Pacific (Singapore)
        "ap-southeast-2", // Asia Pacific (Sydney)
        "ap-east-2", // Asia Pacific (Taipei)
        "ap-southeast-7", // Asia Pacific (Thailand)
        "ap-northeast-1", // Asia Pacific (Tokyo)
        "ca-central-1", // Canada (Central)
        "ca-west-1", // Canada West (Calgary)
        "eu-central-1", // Europe (Frankfurt)
        "eu-west-1", // Europe (Ireland)
        "eu-west-2", // Europe (London)
        "eu-south-1", // Europe (Milan)
        "eu-west-3", // Europe (Paris)
        "eu-south-2", // Europe (Spain)
        "eu-north-1", // Europe (Stockholm)
        "eu-central-2", // Europe (Zurich)
        "il-central-1", // Israel (Tel Aviv)
        "mx-central-1", // Mexico (Central)
        "me-south-1", // Middle East (Bahrain)
        "me-central-1", // Middle East (UAE)
        "sa-east-1", // South America (São Paulo)
    ];
    return apiGatewayRegions[Math.floor(Math.random() * apiGatewayRegions.length)];
};

let aws_access_key;
let aws_secret_key;
let region;
let configFile = "";

/**
 * Utility function to pause execution for a specified duration.
 *
 * @param ms - Number of milliseconds to sleep
 * @returns Promise that resolves after the specified delay
 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Create a new API Gateway.
 *
 * @async
 * @returns {Promise<void>}
 */
const createGateway = async () => {
    console.log(chalk.cyan("[i] Creating API Gateway"));
    const client = new APIGatewayClient({
        region,
        credentials: {
            accessKeyId: aws_access_key,
            secretAccessKey: aws_secret_key,
        },
    });

    const apigw_created_at = Date.now();
    const apigw_name = `js_recon-${apigw_created_at}-${Math.floor(Math.random() * 1000)}`;
    const command = new CreateRestApiCommand({
        name: apigw_name,
        description: `API Gateway for JS Recon created at ${new Intl.DateTimeFormat("en-US", {
            year: "numeric",
            month: "long",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            timeZoneName: "short",
        }).format(apigw_created_at)}`,
        endpointConfiguration: {
            ipAddressType: "dualstack",
            types: ["REGIONAL"],
        },
    });
    const response = await client.send(command);
    await sleep(3000);
    console.log(chalk.green(`[✓] Created API Gateway`));
    console.log(chalk.bgGreen("ID:"), chalk.green(response.id));
    console.log(chalk.bgGreen("Name:"), chalk.green(apigw_name));
    console.log(chalk.bgGreen("Region:"), chalk.green(region));

    // load the existing aws gateway map, if any
    const config = readAwsGatewayMap(configFile);

    config[apigw_name] = {
        id: response.id,
        name: apigw_name,
        description: response.description,
        created_at: apigw_created_at,
        region: region,
        access_key: aws_access_key,
        secret_key: aws_secret_key,
    };

    writeAwsGatewayMap(configFile, config);
    console.log(chalk.green(`[✓] Config saved to ${configFile}`));
};

/**
 * Destroy an API Gateway.
 *
 * @async
 * @param {string} id - The ID of the API Gateway to destroy.
 * @returns {Promise<void>}
 */
const destroyGateway = async (id: string): Promise<void> => {
    console.log(chalk.cyan("[i] Destroying API Gateway"));
    if (!id) {
        console.error(chalk.red("[!] Please provide an API Gateway ID"));
        return;
    }
    //   read the aws gateway map
    let config = readAwsGatewayMap(configFile);
    //   get the name of the api gateway
    let name = Object.keys(config).find((key) => config[key].id === id);

    console.log(chalk.bgGreen("Name:"), chalk.green(name));
    console.log(chalk.bgGreen("ID:"), chalk.green(id));
    console.log(chalk.bgGreen("Region:"), chalk.green(config[name].region));
    region = config[name].region;

    const client = new APIGatewayClient({
        region,
        credentials: {
            accessKeyId: aws_access_key,
            secretAccessKey: aws_secret_key,
        },
    });

    const command = new DeleteRestApiCommand({
        restApiId: id,
    });
    await client.send(command);

    // remove from the config file
    delete config[name];
    writeAwsGatewayMap(configFile, config);

    await sleep(30000);

    console.log(chalk.green(`[✓] Destroyed API Gateway: ${id}`));
};

/**
 * Destroy all API Gateways.
 *
 * @async
 * @returns {Promise<void>}
 */
const destroyAllGateways = async () => {
    console.log(chalk.cyan("[i] Destroying all API Gateways"));
    //   read the aws gateway map
    let config = readAwsGatewayMap(configFile);

    //   destroy all the gateways
    for (const [key, value] of Object.entries(config)) {
        const client = new APIGatewayClient({
            region: value.region,
            credentials: {
                accessKeyId: aws_access_key,
                secretAccessKey: aws_secret_key,
            },
        });
        console.log(chalk.cyan(`[i] Destroying API Gateway: ${key} : ${value.id} : ${value.region}`));

        const command = new DeleteRestApiCommand({
            restApiId: value.id,
        });
        await sleep(30000);
        await client.send(command);
        console.log(chalk.green(`[✓] Destroyed API Gateway: ${key} : ${value.id} : ${value.region}`));
    }

    // nullify the aws gateway map
    writeAwsGatewayMap(configFile, {});
    console.log(chalk.green("[✓] Destroyed all API Gateways"));
};

/**
 * List all API Gateways.
 *
 * @async
 * @returns {Promise<void>}
 */
const listGateways = async () => {
    console.log(chalk.cyan("[i] Listing all API Gateways"));

    // read the aws gateway map
    const config = readAwsGatewayMap(configFile);

    //   if list is empty
    if (Object.keys(config).length === 0) {
        console.error(chalk.red("[!] No API Gateways found"));
        return;
    }

    console.log(chalk.green("[✓] List of API Gateways"));

    for (const [key, value] of Object.entries(config)) {
        console.log(chalk.bgGreen("Name:"), chalk.green(key));
        console.log(chalk.bgGreen("ID:"), chalk.green(value.id));
        console.log(chalk.bgGreen("Region:"), chalk.green(value.region));
        console.log("\n");
    }
};

/** Masks a credential for secure display by showing only the first and last 4 characters. */
const keyMask = (key: string): string => {
    if (key.length < 6) return key;
    return key.slice(0, 4) + "..." + key.slice(-4);
};

/** Resolves the proxy method to configure: the `--proxy-method` flag if given, otherwise an interactive prompt. */
const promptProxyMethod = async (methodInput?: string): Promise<ProxyMethod> => {
    if (methodInput) {
        if (!VALID_PROXY_METHODS.includes(methodInput as ProxyMethod)) {
            throw new Error(`Invalid proxy method: ${methodInput}. Expected one of: ${VALID_PROXY_METHODS.join(", ")}`);
        }
        return methodInput as ProxyMethod;
    }
    const { method } = await inquirer.prompt([
        {
            type: "list",
            name: "method",
            message: "Select proxy method to configure",
            choices: [
                { name: "aws     - AWS API Gateway IP rotation", value: "aws" },
                { name: "socks   - Generic SOCKS5 proxy", value: "socks" },
                { name: "http    - Generic HTTP proxy", value: "http" },
                { name: "oxylabs - Oxylabs datacenter proxy", value: "oxylabs" },
            ],
        },
    ]);
    return method;
};

/** Resolves the socks/http proxy URL: the `--proxy` flag if given (validated), otherwise an interactive prompt. */
const promptProxyUrl = async (method: "socks" | "http", urlInput?: string): Promise<string> => {
    if (urlInput) {
        parseProxyUrl(urlInput);
        return urlInput;
    }
    const example = method === "socks" ? "socks5://user:pass@host:1080" : "http://user:pass@host:8080";
    const { url } = await inquirer.prompt([
        {
            type: "input",
            name: "url",
            message: `${method === "socks" ? "SOCKS5" : "HTTP"} proxy URL (e.g. ${example})`,
            validate: (value: string) => {
                try {
                    parseProxyUrl(value);
                    return true;
                } catch (err) {
                    return err.message;
                }
            },
        },
    ]);
    return url;
};

/** Resolves the oxylabs config field-by-field: CLI flags where given, otherwise interactive prompts. */
const promptOxylabsConfig = async (opts: ProxyCliOptions): Promise<OxylabsConfig> => {
    const answers = await inquirer.prompt([
        {
            type: "input",
            name: "username",
            message: "Oxylabs username",
            when: !opts.oxylabsUsername,
            validate: (value: string) => !!value || "Username is required",
        },
        {
            type: "password",
            name: "password",
            mask: "*",
            message: "Oxylabs password",
            when: !opts.oxylabsPassword,
            validate: (value: string) => !!value || "Password is required",
        },
        {
            type: "input",
            name: "country",
            message: "Country code (optional, e.g. US)",
            when: opts.oxylabsCountry === undefined,
        },
        {
            type: "input",
            name: "city",
            message: "City (optional, requires country)",
            when: (currentAnswers: { country?: string }) =>
                opts.oxylabsCity === undefined && !!(opts.oxylabsCountry || currentAnswers.country),
        },
        {
            type: "input",
            name: "sessionId",
            message: "Sticky session id (optional)",
            when: opts.oxylabsSessionId === undefined,
        },
    ]);

    const cfg: OxylabsConfig = {
        username: opts.oxylabsUsername || answers.username,
        password: opts.oxylabsPassword || answers.password,
        country: opts.oxylabsCountry || answers.country || undefined,
        city: opts.oxylabsCity || answers.city || undefined,
        sessionId: opts.oxylabsSessionId || answers.sessionId || undefined,
    };
    composeOxylabsUsername(cfg); // throws if city was given without country
    return cfg;
};

/** Resolves AWS credentials/region for the interactive `--init` flow: flags/env first, prompts for whatever's missing. */
const resolveAwsCredentialsInteractive = async (opts: ProxyCliOptions): Promise<void> => {
    aws_access_key = opts.awsAccessKey || process.env.AWS_ACCESS_KEY_ID || undefined;
    aws_secret_key = opts.awsSecretKey || process.env.AWS_SECRET_ACCESS_KEY || undefined;
    region = opts.region || undefined;

    const answers = await inquirer.prompt([
        {
            type: "input",
            name: "accessKey",
            message: "AWS access key",
            when: !aws_access_key,
            validate: (value: string) => !!value || "Required",
        },
        {
            type: "password",
            name: "secretKey",
            mask: "*",
            message: "AWS secret key",
            when: !aws_secret_key,
            validate: (value: string) => !!value || "Required",
        },
        {
            type: "input",
            name: "region",
            message: "AWS region (leave blank for random)",
            when: !region,
        },
    ]);

    aws_access_key = aws_access_key || answers.accessKey;
    aws_secret_key = aws_secret_key || answers.secretKey;
    region = region || answers.region || randomRegion();
};

export interface ProxyCliOptions {
    init: boolean;
    destroy: string;
    destroyAll: boolean;
    list: boolean;
    region: string;
    awsAccessKey: string;
    awsSecretKey: string;
    config: string;
    feasibility: boolean;
    feasibilityUrl: string;
    proxyMethod?: string;
    proxyUrl?: string;
    oxylabsUsername?: string;
    oxylabsPassword?: string;
    oxylabsCountry?: string;
    oxylabsCity?: string;
    oxylabsSessionId?: string;
}

/**
 * Main entry point for the `proxy` module.
 *
 * `-i/--init` runs the interactive config wizard covering all 4 methods (aws/socks/http/oxylabs),
 * writing the result to `.proxy_config.json`. `-d/--destroy`, `--destroy-all`, and `-l/--list`
 * remain AWS-only lifecycle actions, unchanged from the original api-gateway module.
 *
 * @async
 * @param opts - Resolved CLI options for the `proxy` command.
 * @returns {Promise<void>}
 */
const proxy = async (opts: ProxyCliOptions): Promise<void> => {
    configFile = opts.config || ".proxy_config.json";

    // if feasibility is true, check feasibility
    if (opts.feasibility) {
        if (!opts.feasibilityUrl) {
            console.error(chalk.red("[!] Please provide a URL to check feasibility of"));
            return;
        }

        const resolved = resolveProxyConfig({
            cli: {
                proxyMethod: opts.proxyMethod,
                proxyUrl: opts.proxyUrl,
                oxylabsUsername: opts.oxylabsUsername,
                oxylabsPassword: opts.oxylabsPassword,
                oxylabsCountry: opts.oxylabsCountry,
                oxylabsCity: opts.oxylabsCity,
                oxylabsSessionId: opts.oxylabsSessionId,
            },
            env: process.env,
            ignoreEnv: false,
            configFileParsed: readProxyConfigFile(configFile),
        });

        if (!resolved.method) {
            console.error(
                chalk.red(
                    "[!] Please specify a proxy method via --proxy-method, or configure one with -i/--init first"
                )
            );
            return;
        }

        globals.setProxyConfigFile(configFile);
        globals.setProxyMethod(resolved.method);
        globals.setProxyUrl(resolved.url);
        globals.setOxylabsConfig(resolved.oxylabs);

        await checkFeasibility(resolved, opts.feasibilityUrl);
        return;
    }

    if (opts.init) {
        const method = await promptProxyMethod(opts.proxyMethod);

        if (method === "aws") {
            console.log(chalk.cyan("[i] Configuring 'Proxy' module (aws method)"));
            await resolveAwsCredentialsInteractive(opts);
            console.log(chalk.cyan(`[i] Using region: ${region}`));
            console.log(chalk.cyan(`[i] Using access key: ${keyMask(aws_access_key)}`));

            await createGateway();
            setActiveProxyMethod(configFile, "aws");
            return;
        }

        if (method === "socks" || method === "http") {
            const url = await promptProxyUrl(method, opts.proxyUrl);
            writeMethodConfig(configFile, method, { url });
            console.log(chalk.green(`[✓] Saved ${method} proxy config to ${configFile}`));
            return;
        }

        // method === "oxylabs"
        const oxylabsConfig = await promptOxylabsConfig(opts);
        writeMethodConfig(configFile, "oxylabs", oxylabsConfig);
        console.log(chalk.green(`[✓] Saved oxylabs proxy config to ${configFile}`));
        return;
    }

    // destroy / destroy-all / list remain AWS-only, non-interactive
    if (opts.destroy || opts.destroyAll || opts.list) {
        aws_access_key = opts.awsAccessKey || process.env.AWS_ACCESS_KEY_ID || undefined;
        aws_secret_key = opts.awsSecretKey || process.env.AWS_SECRET_ACCESS_KEY || undefined;
        region = opts.region || randomRegion();

        if (!aws_access_key || !aws_secret_key) {
            console.error(chalk.red("[!] AWS Access Key or Secret Key not found. Run with -h to see help"));
            process.exit(1);
        }

        if (opts.destroy) {
            await destroyGateway(opts.destroy);
        } else if (opts.destroyAll) {
            await destroyAllGateways();
        } else {
            await listGateways();
        }
        return;
    }

    console.error(
        chalk.red("[!] Please provide a valid action (-i/--init, -d/--destroy, --destroy-all, or -l/--list)")
    );
};

export default proxy;
