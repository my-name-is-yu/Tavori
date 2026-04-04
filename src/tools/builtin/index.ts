export { GlobTool } from "./glob.js";
export { GrepTool } from "./grep.js";
export { ReadTool } from "./read.js";
export { ShellTool } from "./shell.js";
export { HttpFetchTool } from "./http-fetch.js";
export { JsonQueryTool } from "./json-query.js";

import { GlobTool } from "./glob.js";
import { GrepTool } from "./grep.js";
import { ReadTool } from "./read.js";
import { ShellTool } from "./shell.js";
import { HttpFetchTool } from "./http-fetch.js";
import { JsonQueryTool } from "./json-query.js";
import type { ITool } from "../types.js";

/** All built-in tools, sorted alphabetically by name. */
export function createBuiltinTools(): ITool[] {
  return [
    new GlobTool(),
    new GrepTool(),
    new HttpFetchTool(),
    new JsonQueryTool(),
    new ReadTool(),
    new ShellTool(),
  ];
}
