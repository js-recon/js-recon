import { makeInteractive, makeRunCommands, State } from "../interactive-mode/interactive.js";
import { handleCommand } from "./interactive_helpers/commandHandler.js";

const interactive = makeInteractive(handleCommand);
const runCommands = makeRunCommands(handleCommand);

export { runCommands, State };
export default interactive;
