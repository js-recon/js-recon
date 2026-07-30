import chalk from "chalk";

const COMMANDS = [
    "lazyload",
    "endpoints",
    "strings",
    "proxy",
    "map",
    "refactor",
    "analyze",
    "report",
    "run",
    "load",
    "fingerprint",
    "mcp",
    "cs-mast",
    "sourcemaps",
    "completion",
];

const FLAGS: Record<string, string[]> = {
    lazyload: [
        "-u",
        "--url",
        "-o",
        "--output",
        "--strict-scope",
        "-s",
        "--scope",
        "-t",
        "--threads",
        "--subsequent-requests",
        "--urls-file",
        "--proxy-config",
        "--ignore-proxy-env",
        "--oxylabs-waf-fallback",
        "--oxylabs-fallback-max-requests",
        "--oxylabs-fallback-max-total",
        "--oxylabs-fallback-max-origins",
        "--cache-file",
        "--disable-cache",
        "--cache-only",
        "-y",
        "--yes",
        "--timeout",
        "-k",
        "--insecure",
        "--no-sandbox",
        "--build-id",
        "--sourcemap-dir",
        "--research",
        "--research-output",
        "--max-iterations",
        "--max-js-size",
        "--lazyload-timeout",
        "--detection-timeout",
        "--max-pages",
        "--include-methods",
        "--exclude-methods",
        "--list-methods",
    ],
    endpoints: [
        "-u",
        "--url",
        "-d",
        "--directory",
        "-o",
        "--output",
        "--output-format",
        "-t",
        "--tech",
        "-l",
        "--list",
        "--mapped-json",
    ],
    strings: [
        "-d",
        "--directory",
        "-o",
        "--output",
        "-e",
        "--extract-urls",
        "--extracted-url-path",
        "-p",
        "--permutate",
        "--openapi",
        "-s",
        "--scan-secrets",
        "--trufflehog",
    ],
    proxy: [
        "-i",
        "--init",
        "-d",
        "--destroy",
        "--destroy-all",
        "-r",
        "--region",
        "--aws-access-key",
        "--aws-secret-key",
        "-c",
        "--config",
        "-l",
        "--list",
        "--feasibility",
        "--feasibility-url",
        "--proxy-method",
        "--proxy",
        "--oxylabs-username",
        "--oxylabs-password",
        "--oxylabs-country",
        "--oxylabs-city",
        "--oxylabs-session-id",
    ],
    map: [
        "-d",
        "--directory",
        "-t",
        "--tech",
        "-l",
        "--list",
        "-o",
        "--output",
        "-f",
        "--format",
        "-i",
        "--interactive",
        "-c",
        "--command",
        "--ai",
        "--ai-threads",
        "--ai-provider",
        "--ai-endpoint",
        "--openai-api-key",
        "--model",
        "--openapi",
        "--openapi-output",
        "--openapi-chunk-tag",
        "--no-graphql",
        "--ngql",
        "--max-recursion-depth",
        "--max-heap",
    ],
    refactor: [
        "-m",
        "--mapped-json",
        "-o",
        "--output",
        "-t",
        "--tech",
        "-l",
        "--list",
        "--collisions",
        "--sq",
        "--signature-quality",
        "--refresh-cache",
        "--skip-cache-checks",
        "--no-remote",
        "--remote-collisions",
        "--scat",
        "--detect-version",
        "--detect-version-config",
        "--detect-version-dynamic-threshold",
        "--detect-version-dynamic-conf-purge",
    ],
    analyze: [
        "-r",
        "--rules",
        "--disable-rules-version-check",
        "-m",
        "--mapped-json",
        "-t",
        "--tech",
        "--openapi",
        "-l",
        "--list",
        "--validate",
        "-o",
        "--output",
    ],
    report: [
        "-s",
        "--sqlite-db",
        "-m",
        "--mapped-json",
        "-a",
        "--analyze-json",
        "-e",
        "--endpoints-json",
        "--map-openapi",
        "--mapped-openapi-json",
        "-o",
        "--output",
    ],
    run: [
        "-u",
        "--url",
        "-r",
        "--rules",
        "--disable-rules-version-check",
        "-c",
        "--command",
        "-o",
        "--output",
        "--output-overwrite",
        "--strict-scope",
        "-s",
        "--scope",
        "-t",
        "--threads",
        "--proxy-config",
        "--ignore-proxy-env",
        "--proxy-waf-fallback",
        "--oxylabs-waf-fallback",
        "--oxylabs-fallback-max-requests",
        "--oxylabs-fallback-max-total",
        "--oxylabs-fallback-max-origins",
        "--cache-file",
        "--disable-cache",
        "--cache-only",
        "-y",
        "--yes",
        "--secrets",
        "--trufflehog",
        "--ai",
        "--ai-threads",
        "--ai-provider",
        "--ai-endpoint",
        "--openai-api-key",
        "--model",
        "--map-openapi-chunk-tag",
        "--no-graphql",
        "--ngql",
        "--timeout",
        "-k",
        "--insecure",
        "--no-sandbox",
        "--sourcemap-dir",
        "--research",
        "--research-output",
        "--max-iterations",
        "--max-js-size",
        "--lazyload-timeout",
        "--detection-timeout",
        "--max-heap",
        "--max-pages",
        "--include-methods",
        "--exclude-methods",
        "--list-methods",
        "--cs-mast-tech-detect-threshold",
        "--disable-refactor",
    ],
    load: ["-c", "--caido", "-u", "--url", "--cache-file"],
    fingerprint: [
        "-u",
        "--url",
        "-o",
        "--output",
        "-f",
        "--format",
        "-t",
        "--threads",
        "--timeout",
        "-k",
        "--insecure",
        "--no-sandbox",
    ],
    mcp: [
        "--cli",
        "--server",
        "-c",
        "--chat",
        "--config",
        "--api-key",
        "--model",
        "--provider",
        "--no-refresh-claude-creds",
        "--claude-client-id",
    ],
    "cs-mast": [
        "-o",
        "--output",
        "--ct",
        "--collision-table",
        "--min-collisions",
        "--co",
        "--collision-output",
        "--cf",
        "--collision-format",
        "--scat",
        "--sinc",
        "--all-scat-permutations",
        "--perm-output",
        "--perm-concurrency",
    ],
    sourcemaps: ["-i", "--input", "-o", "--output"],
    completion: ["bash", "zsh", "fish"],
};

function generateBashCompletion(): string {
    const cmdList = COMMANDS.join(" ");
    const cmdPattern = COMMANDS.join("|");
    const caseBranches = Object.entries(FLAGS)
        .map(([cmd, flags]) => `        ${cmd})\n            opts="${flags.join(" ")}"\n            ;;`)
        .join("\n");

    return `# js-recon bash completion
# Add to ~/.bashrc:  eval "$(js-recon completion bash)"
_js_recon_completion() {
    local cur prev words cword opts
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
    words=("\${COMP_WORDS[@]}")
    cword=\${COMP_CWORD}

    if [[ \${prev} == "--config" ]]; then
        COMPREPLY=( \$(compgen -f -- "\${cur}") )
        return 0
    fi

    local cmd=""
    local word
    for word in "\${words[@]}"; do
        case "\${word}" in
            ${cmdPattern}) cmd="\${word}"; break ;;
        esac
    done
    if [[ -z \${cmd} ]]; then
        COMPREPLY=( \$(compgen -W "--config ${cmdList}" -- "\${cur}") )
        return 0
    fi

    opts=""
    case "\${cmd}" in
${caseBranches}
    esac

    COMPREPLY=( \$(compgen -W "\${opts}" -- "\${cur}") )
    return 0
}
complete -F _js_recon_completion js-recon
`;
}

function generateZshCompletion(): string {
    const commandDescriptions = [
        "'lazyload:Run lazy load module'",
        "'endpoints:Extract client-side endpoints'",
        "'strings:Extract strings from JS files'",
        "'proxy:Manage proxy configuration (AWS API Gateway IP rotation, SOCKS/HTTP, Oxylabs)'",
        "'map:Map all the functions'",
        "'refactor:Refactor the code'",
        "'analyze:Analyze the code'",
        "'report:Generate a report'",
        "'run:Run all modules'",
        "'load:Populate response cache from a Caido/Burp request history export'",
        "'fingerprint:Detect front-end frameworks across one or more URLs'",
        "'mcp:AI-powered CLI / one-shot chat / MCP server'",
        "'cs-mast:Compute CS-MAST hashes for downloaded JS files'",
        "'sourcemaps:Extract source files from .map sourcemap file(s)'",
        "'completion:Generate shell completion scripts'",
    ].join("\n                ");

    const caseBranches = Object.entries(FLAGS)
        .map(([cmd, flags]) => {
            const flagArgs = flags.map((f) => `'${f}'`).join(" ");
            return `                (${cmd})\n                    _arguments '*: :(${flagArgs})'\n                    ;;`;
        })
        .join("\n");

    return `#compdef js-recon
# js-recon zsh completion
# Add to ~/.zshrc:  eval "$(js-recon completion zsh)"
# Or:               js-recon completion zsh > "\${fpath[1]}/_js-recon"

_js_recon() {
    local state line
    typeset -A opt_args

    _arguments -C \\
        '(-h --help)'{-h,--help}'[Show help]' \\
        '(-V --version)'{-V,--version}'[Show version]' \\
        '--config[Application YAML config]:file:_files' \\
        '1: :->command' \\
        '*: :->args'

    case \$state in
        command)
            local -a commands
            commands=(
                ${commandDescriptions}
            )
            _describe -t commands 'js-recon command' commands
            ;;
        args)
            case \$line[1] in
${caseBranches}
            esac
            ;;
    esac
}

_js_recon "\$@"
`;
}

function generateFishCompletion(): string {
    const cmdCompletions = COMMANDS.map((cmd) => `complete -c js-recon -f -n '__fish_use_subcommand' -a ${cmd}`).join(
        "\n"
    );

    const flagCompletions = Object.entries(FLAGS)
        .flatMap(([cmd, flags]) =>
            flags.map((flag) => {
                if (flag.startsWith("--")) {
                    return `complete -c js-recon -n '__fish_seen_subcommand_from ${cmd}' -l ${flag.slice(2)}`;
                } else if (flag.startsWith("-") && flag.length === 2) {
                    return `complete -c js-recon -n '__fish_seen_subcommand_from ${cmd}' -s ${flag.slice(1)}`;
                }
                // positional (e.g. shell names for 'completion' subcommand)
                return `complete -c js-recon -n '__fish_seen_subcommand_from ${cmd}' -a ${flag}`;
            })
        )
        .join("\n");

    return `# js-recon fish completion
# Save to: ~/.config/fish/completions/js-recon.fish
# Or run: js-recon completion fish > ~/.config/fish/completions/js-recon.fish

function __fish_use_subcommand
    set -l cmd (commandline -poc)
    set -e cmd[1]
    set -l skip_next 0
    for c in $cmd
        if test $skip_next -eq 1
            set skip_next 0
            continue
        end
        if test "$c" = "--config"
            set skip_next 1
            continue
        end
        if string match -q -- '--config=*' "$c"
            continue
        end
        if string match -qr '^[^-]' -- $c
            return 1
        end
    end
    return 0
end

function __fish_seen_subcommand_from
    set -l cmd (commandline -poc)
    set -e cmd[1]
    for subcmd in $argv
        if contains -- $subcmd $cmd
            return 0
        end
    end
    return 1
end

${cmdCompletions}

complete -c js-recon -l config -r -F

${flagCompletions}
`;
}

export default function completion(shell: string | undefined): void {
    if (!shell) {
        console.error(chalk.red("[!] Shell type required. Usage: js-recon completion <bash|zsh|fish>"));
        process.exit(1);
    }

    switch (shell.toLowerCase()) {
        case "bash":
            process.stdout.write(generateBashCompletion());
            break;
        case "zsh":
            process.stdout.write(generateZshCompletion());
            break;
        case "fish":
            process.stdout.write(generateFishCompletion());
            break;
        default:
            console.error(chalk.red(`[!] Unknown shell: "${shell}". Supported shells: bash, zsh, fish`));
            process.exit(1);
    }
}
