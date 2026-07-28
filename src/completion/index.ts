import fs from "fs";
import os from "os";
import path from "path";
import { printMsg, MSG } from "../utility/printMsg.js";
import { buildProgram } from "../cliProgram.js";
import { buildCommandTree, type CommandNode, type OptionEntry } from "./introspect.js";

function bashLeafOpts(node: CommandNode): string {
    return [...node.options.flatMap((o) => o.flags), ...node.argumentChoices].join(" ");
}

// Recursively emits nested `case` blocks so multi-level subcommands (e.g. `proxy aws`) get their
// own flags completed, not just the parent's child-name list. `wordIndex` is the COMP_WORDS index
// this node's name occupies (1 for top-level commands, 2 for their children, and so on).
function generateBashCaseBranch(node: CommandNode, wordIndex: number): string {
    const indent = "    ".repeat(wordIndex + 1);

    if (node.subcommands.length === 0) {
        return `${indent}${node.name})
${indent}    opts="${bashLeafOpts(node)}"
${indent}    ;;`;
    }

    const childBranches = node.subcommands.map((child) => generateBashCaseBranch(child, wordIndex + 1)).join("\n");
    const childNames = node.subcommands.map((c) => c.name).join(" ");

    return `${indent}${node.name})
${indent}    case "\${words[${wordIndex + 1}]:-}" in
${childBranches}
${indent}        *)
${indent}            opts="${childNames}"
${indent}            ;;
${indent}    esac
${indent}    ;;`;
}

function generateBashCompletion(tree: CommandNode[]): string {
    const cmdList = tree.map((n) => n.name).join(" ");
    const caseBranches = tree.map((node) => generateBashCaseBranch(node, 1)).join("\n");

    return `# js-recon bash completion
# Installed automatically by: js-recon completion bash
_js_recon_completion() {
    local cur prev words cword opts
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
    words=("\${COMP_WORDS[@]}")
    cword=\${COMP_CWORD}

    if [[ \${cword} -eq 1 ]]; then
        COMPREPLY=( \$(compgen -W "${cmdList}" -- "\${cur}") )
        return 0
    fi

    opts=""
    case "\${words[1]}" in
${caseBranches}
    esac

    COMPREPLY=( \$(compgen -W "\${opts}" -- "\${cur}") )
    return 0
}
complete -F _js_recon_completion js-recon
`;
}

// zsh escaping: backslash first, then compsys metacharacters, then the shell-level single-quote
// trick last (since every spec string here is wrapped in '...').
function zshBracketDesc(desc: string): string {
    return desc.replace(/\\/g, "\\\\").replace(/\]/g, "\\]").replace(/\[/g, "\\[").replace(/'/g, "'\\''");
}

// Used inside `_describe` `name:description` arrays, where `:` is the field delimiter.
function zshDescribeDesc(desc: string): string {
    return desc.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "'\\''");
}

function zshOptionSpec(option: OptionEntry): string {
    const desc = zshBracketDesc(option.description);
    const short = option.flags.find((f) => f.length === 2 && f.startsWith("-") && !f.startsWith("--"));
    const long = option.flags.find((f) => f.startsWith("--"));
    if (short && long) return `'(${short} ${long})'{${short},${long}}'[${desc}]'`;
    if (long) return `'${long}[${desc}]'`;
    if (short) return `'${short}[${desc}]'`;
    return "";
}

function zshDescribeEntry(node: CommandNode): string {
    return `'${node.name}:${zshDescribeDesc(node.description)}'`;
}

function zshLeafArguments(node: CommandNode): string {
    const parts: string[] = [];
    if (node.argumentChoices.length > 0) {
        parts.push(`'1: :(${node.argumentChoices.join(" ")})'`);
    }
    parts.push(...node.options.map(zshOptionSpec).filter(Boolean));
    if (parts.length === 0) return ":";
    return `_arguments ${parts.join(" ")}`;
}

// Recursively emits a nested `_arguments -C` + `case $state` block for a level of subcommands.
// Reusing the generic `cmd`/`args` state labels at every nesting level is safe here because each
// `_arguments -C` call is evaluated strictly before the `case $state` that reads its result — by
// the time a nested level's `$state` is inspected, the outer level's value is no longer needed.
function zshSubcommandBlock(nodes: CommandNode[], describeTag: string): string {
    const entries = nodes.map(zshDescribeEntry).join("\n                                ");
    const branches = nodes
        .map((node) => {
            const body =
                node.subcommands.length > 0 ? zshSubcommandBlock(node.subcommands, node.name) : zshLeafArguments(node);
            return `                                (${node.name})
                                    ${body}
                                    ;;`;
        })
        .join("\n");

    return `_arguments -C \\
                        '1: :->cmd' \\
                        '*::arg:->args'

                    case \$state in
                        cmd)
                            local -a items
                            items=(
                                ${entries}
                            )
                            _describe -t items '${describeTag}' items
                            ;;
                        args)
                            case \$line[1] in
${branches}
                            esac
                            ;;
                    esac`;
}

function generateZshCompletion(tree: CommandNode[]): string {
    const commandDescriptions = tree.map(zshDescribeEntry).join("\n                ");

    const caseBranches = tree
        .map((node) => {
            const body =
                node.subcommands.length > 0
                    ? zshSubcommandBlock(node.subcommands, `${node.name} subcommand`)
                    : zshLeafArguments(node);
            return `                (${node.name})
                    ${body}
                    ;;`;
        })
        .join("\n");

    return `#compdef js-recon
# js-recon zsh completion
# Installed automatically by: js-recon completion zsh

_js_recon() {
    local state line
    typeset -A opt_args

    _arguments -C \\
        '(-h --help)'{-h,--help}'[Show help]' \\
        '(-V --version)'{-V,--version}'[Show version]' \\
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

function fishDesc(desc: string): string {
    return desc.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function fishConditionForPath(namePath: string[]): string {
    return namePath.map((name) => `__fish_seen_subcommand_from ${name}`).join("; and ");
}

// Recursively emits `complete` lines for a node's own flags/argument choices (gated on the full
// name path having been seen so far) and, for each child, both a name-completion at this level
// and a recursive call so the child's own flags are completed too (e.g. `proxy aws --<tab>`).
function generateFishNode(node: CommandNode, parentPath: string[]): string[] {
    const namePath = [...parentPath, node.name];
    const cond = fishConditionForPath(namePath);
    const lines: string[] = [];

    for (const option of node.options) {
        const short = option.flags.find((f) => f.length === 2 && f.startsWith("-") && !f.startsWith("--"));
        const long = option.flags.find((f) => f.startsWith("--"));
        const desc = fishDesc(option.description);
        if (short && long) {
            lines.push(`complete -c js-recon -n '${cond}' -s ${short.slice(1)} -l ${long.slice(2)} -d '${desc}'`);
        } else if (long) {
            lines.push(`complete -c js-recon -n '${cond}' -l ${long.slice(2)} -d '${desc}'`);
        } else if (short) {
            lines.push(`complete -c js-recon -n '${cond}' -s ${short.slice(1)} -d '${desc}'`);
        }
    }

    if (node.argumentChoices.length > 0) {
        lines.push(`complete -c js-recon -n '${cond}' -a '${node.argumentChoices.join(" ")}'`);
    }

    for (const child of node.subcommands) {
        lines.push(`complete -c js-recon -f -n '${cond}' -a ${child.name} -d '${fishDesc(child.description)}'`);
        lines.push(...generateFishNode(child, namePath));
    }

    return lines;
}

function generateFishCompletion(tree: CommandNode[]): string {
    const cmdCompletions = tree
        .map(
            (node) =>
                `complete -c js-recon -f -n '__fish_use_subcommand' -a ${node.name} -d '${fishDesc(node.description)}'`
        )
        .join("\n");

    const flagCompletions = tree.flatMap((node) => generateFishNode(node, [])).join("\n");

    return `# js-recon fish completion
# Installed automatically by: js-recon completion fish
# (written to ~/.config/fish/completions/js-recon.fish, which fish auto-loads)

function __fish_use_subcommand
    set -l cmd (commandline -poc)
    set -e cmd[1]
    for c in $cmd
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

${flagCompletions}
`;
}

const RC_MARKER = "# JS Recon shell completion";

function getCompletionDir(): string {
    return path.join(os.homedir(), ".js-recon", "completion");
}

function getFishCompletionsDir(): string {
    return path.join(os.homedir(), ".config", "fish", "completions");
}

// Path each shell's full generated script gets written to. Fish uses its own
// auto-loaded completions dir instead of ~/.js-recon, so it needs no rc-file entry.
function getInstalledScriptPath(shell: string): string {
    switch (shell) {
        case "bash":
            return path.join(getCompletionDir(), "js-recon.bash");
        case "zsh":
            return path.join(getCompletionDir(), "_js-recon");
        case "fish":
            return path.join(getFishCompletionsDir(), "js-recon.fish");
        default:
            throw new Error(`Unknown shell: ${shell}`);
    }
}

function getRcFilePath(shell: "bash" | "zsh"): string {
    return path.join(os.homedir(), shell === "bash" ? ".bashrc" : ".zshrc");
}

// Small snippet printed for `--rc-file` — this is what actually goes in the user's rc file
// (via `eval "$(js-recon completion <shell> --rc-file)"`), pointing at the full script on disk.
function generateRcFileLoader(shell: "bash" | "zsh"): string {
    const importantHeader = `# IMPORTANT: the contents of this command are expected to be present in
# the shell's rc file, invoked as \`eval "$(js-recon completion ${shell} --rc-file)"\`.
# Run \`js-recon completion ${shell}\` to (re)install.`;

    if (shell === "bash") {
        return `${importantHeader}
if [ -f "$HOME/.js-recon/completion/js-recon.bash" ]; then
    source "$HOME/.js-recon/completion/js-recon.bash"
fi
`;
    }

    return `${importantHeader}
fpath=("$HOME/.js-recon/completion" $fpath)
autoload -Uz compinit
compinit
`;
}

function generateCompletionScript(shell: string): string {
    const tree = buildCommandTree(buildProgram());
    switch (shell) {
        case "bash":
            return generateBashCompletion(tree);
        case "zsh":
            return generateZshCompletion(tree);
        case "fish":
            return generateFishCompletion(tree);
        default:
            throw new Error(`Unknown shell: ${shell}`);
    }
}

// Writes the full script to disk and, for bash/zsh, wires a tiny loader entry into the
// user's rc file (idempotent — checks RC_MARKER before appending).
function installCompletion(shell: "bash" | "zsh" | "fish"): void {
    const scriptPath = getInstalledScriptPath(shell);
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, generateCompletionScript(shell));

    if (shell === "fish") {
        printMsg(MSG.Run, `[+] Installed fish completion to ${scriptPath}`);
        printMsg(MSG.Run, "[+] Fish auto-loads this — no further action needed.");
        return;
    }

    const rcPath = getRcFilePath(shell);
    const rcContent = fs.existsSync(rcPath) ? fs.readFileSync(rcPath, "utf8") : "";

    if (rcContent.includes(RC_MARKER)) {
        printMsg(MSG.Run, `[+] Installed ${shell} completion to ${scriptPath}`);
        printMsg(MSG.Run, `[+] ${rcPath} already wired for js-recon completion.`);
        return;
    }

    const entry = `\n${RC_MARKER}\neval "$(js-recon completion ${shell} --rc-file)"\n`;
    fs.appendFileSync(rcPath, entry);

    printMsg(MSG.Run, `[+] Installed ${shell} completion to ${scriptPath}`);
    printMsg(MSG.Run, `[+] Added completion loader to ${rcPath}`);
    printMsg(MSG.Run, `[+] Restart your shell or run: source ${rcPath}`);
}

export default function completion(shell: string | undefined, rcFile?: boolean): void {
    if (!shell) {
        printMsg(MSG.Err, "[!] Shell type required. Usage: js-recon completion <bash|zsh|fish>");
        process.exit(1);
    }

    const normalizedShell = shell.toLowerCase();
    if (normalizedShell !== "bash" && normalizedShell !== "zsh" && normalizedShell !== "fish") {
        printMsg(MSG.Err, `[!] Unknown shell: "${shell}". Supported shells: bash, zsh, fish`);
        process.exit(1);
    }

    if (rcFile) {
        if (normalizedShell === "fish") {
            printMsg(
                MSG.Err,
                '[!] --rc-file is not applicable to fish; fish auto-loads completions from "~/.config/fish/completions/".'
            );
            process.exit(1);
        }
        process.stdout.write(generateRcFileLoader(normalizedShell));
        return;
    }

    installCompletion(normalizedShell);
}
