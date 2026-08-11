import type { Command } from "commander";

export interface OptionEntry {
    /** e.g. ["-u", "--url"], ["--no-sandbox"], or ["-i"] */
    flags: string[];
    description: string;
}

export interface CommandNode {
    name: string;
    description: string;
    options: OptionEntry[];
    /** Choices registered on a positional argument, e.g. ["bash", "zsh", "fish"] for `completion <shell>` */
    argumentChoices: string[];
    subcommands: CommandNode[];
}

function toNode(cmd: Command): CommandNode {
    return {
        name: cmd.name(),
        description: cmd.description(),
        options: cmd.options.map((option) => ({
            flags: [option.short, option.long].filter((flag): flag is string => !!flag),
            description: option.description,
        })),
        argumentChoices: cmd.registeredArguments.flatMap((argument) => argument.argChoices ?? []),
        subcommands: cmd.commands.map(toNode),
    };
}

/** Builds a plain, serializable command tree from a fully-configured Commander program. */
export function buildCommandTree(program: Command): CommandNode[] {
    return program.commands.map(toNode);
}
