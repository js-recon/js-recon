import { baseHelpMenu } from "../../interactive-mode/helpMenu.js";

const helpMenu = {
    ...baseHelpMenu,
    list: "Usage: list <option>\n  all:   List all functions\n  desc:  List all functions with non-empty descriptions\n  nav:   List navigation history\n  files: List unique source files (with chunk counts)\n  file <file>: List functions defined in a specific source file\n  exportnames <option>: List export names for a chunk\n    <chunkId>: List export names for a specific chunk\n    all: List export names for all chunks\n    nonempty: List export names for all non-empty chunks",
};

export { helpMenu };
