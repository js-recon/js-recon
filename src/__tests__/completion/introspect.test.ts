import { describe, it, expect } from "vitest";
import { Command, Argument } from "commander";
import { buildCommandTree } from "../../completion/introspect.js";

function buildTestProgram(): Command {
    const program = new Command();

    program
        .command("widget")
        .description("Manage widgets")
        .option("-u, --url <url>", "Target URL")
        .option("--no-sandbox", "Disable sandbox");

    const nested = program.command("proxy").description("Manage proxy configuration");
    nested.command("aws").description("Rotate outbound IP").option("-i, --init", "Initialize the config file");

    program
        .command("completion")
        .description("Install shell completion")
        .addArgument(new Argument("<shell>", "Shell type").choices(["bash", "zsh", "fish"]));

    return program;
}

describe("buildCommandTree", () => {
    it("merges short and long option forms into one entry", () => {
        const tree = buildCommandTree(buildTestProgram());
        const widget = tree.find((n) => n.name === "widget")!;
        const urlOption = widget.options.find((o) => o.flags.includes("--url"))!;
        expect(urlOption.flags).toEqual(["-u", "--url"]);
        expect(urlOption.description).toBe("Target URL");
    });

    it("keeps long-only (negated) options as a single flag", () => {
        const tree = buildCommandTree(buildTestProgram());
        const widget = tree.find((n) => n.name === "widget")!;
        const noSandbox = widget.options.find((o) => o.flags.includes("--no-sandbox"))!;
        expect(noSandbox.flags).toEqual(["--no-sandbox"]);
    });

    it("does not include the auto-injected -h/--help option", () => {
        const tree = buildCommandTree(buildTestProgram());
        const widget = tree.find((n) => n.name === "widget")!;
        expect(widget.options.some((o) => o.flags.includes("-h") || o.flags.includes("--help"))).toBe(false);
    });

    it("recurses into nested subcommands with their own options", () => {
        const tree = buildCommandTree(buildTestProgram());
        const proxy = tree.find((n) => n.name === "proxy")!;
        expect(proxy.options).toEqual([]);
        expect(proxy.subcommands).toHaveLength(1);

        const aws = proxy.subcommands[0];
        expect(aws.name).toBe("aws");
        expect(aws.description).toBe("Rotate outbound IP");
        expect(aws.options.find((o) => o.flags.includes("--init"))?.flags).toEqual(["-i", "--init"]);
        expect(aws.subcommands).toEqual([]);
    });

    it("exposes registered argument choices", () => {
        const tree = buildCommandTree(buildTestProgram());
        const completionCmd = tree.find((n) => n.name === "completion")!;
        expect(completionCmd.argumentChoices).toEqual(["bash", "zsh", "fish"]);
    });

    it("returns an empty argumentChoices array when no argument is registered", () => {
        const tree = buildCommandTree(buildTestProgram());
        const widget = tree.find((n) => n.name === "widget")!;
        expect(widget.argumentChoices).toEqual([]);
    });
});
