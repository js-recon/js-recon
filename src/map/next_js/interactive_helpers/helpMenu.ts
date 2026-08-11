import { baseHelpMenu } from "../../interactive-mode/helpMenu.js";

const helpMenu = {
    ...baseHelpMenu,
    list: "Usage: list <option>\n  fetch:          List functions that contain fetch instances\n  axios:          List functions that are axios clients\n  all:            List all functions\n  desc:           List all functions with non-empty descriptions\n  nav:            List navigation history\n  server_actions: List all discovered Next.js Server Actions with route, body args, and source locations\n  exportnames <option>: List export names for a chunk\n    <chunkId>: List export names for a specific chunk\n    all: List export names for all chunks\n    nonempty: List export names for all non-empty chunks",
};

export { helpMenu };
