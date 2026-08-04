const baseHelpMenu = {
    help: "Show this help menu",
    exit: "Exit the interactive mode",
    clear: "Clear the output box",
    go: "Usage: go <option>\n  to <functionID>: Go to a specific function\n  back:          Go back to the previous function\n  ahead:         Go to the next function",
    set: "Usage: set <option> <value>\n  funcwritefile <filename>: Set file to write function code to\n  writeimports [true/false]: When using `go *` command, also write all the imports to the file\n  funcdesc <functionId> <description>: Set the description of the provided function ID with provided value",
    trace: "Usage: trace <functionID>\n  Traces imports/exports for a function",
    esquery:
        "Usage: esquery <chunkId|*> <code-snippet>\n  Find AST nodes whose minified source contains the (also minified) snippet, and print a loose + strict esquery selector for each. Use `*` (or `all`) as the chunk to scan every chunk. Example: esquery * fetch(`/api/docs/${file}`)",
};

export { baseHelpMenu };
