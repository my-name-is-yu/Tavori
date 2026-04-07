import * as p from "@clack/prompts";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadProviderConfig } from "../../../../base/llm/provider-config.js";
import { getPulseedDirPath } from "../../../../base/utils/paths.js";
import { SEEDY_PIXEL } from "../../../tui/seedy-art.js";
import { maskKey } from "../setup-shared.js";
import { guardCancel } from "./utils.js";

export { guardCancel } from "./utils.js";

export function getBanner(): string {
  const green = "\x1b[38;2;76;175;80m";
  const bold = "\x1b[1m";
  const reset = "\x1b[0m";
  return `
${green}  ██████╗ ██╗   ██╗██╗     ███████╗███████╗███████╗██████╗
  ██╔══██╗██║   ██║██║     ██╔════╝██╔════╝██╔════╝██╔══██╗
  ██████╔╝██║   ██║██║     ███████╗█████╗  █████╗  ██║  ██║
  ██╔═══╝ ██║   ██║██║     ╚════██║██╔══╝  ██╔══╝  ██║  ██║
  ██║     ╚██████╔╝███████╗███████║███████╗███████╗██████╔╝
  ╚═╝      ╚═════╝ ╚══════╝╚══════╝╚══════╝╚══════╝╚═════╝${reset}

  ${bold}🌱 Welcome to ${green}PulSeed${reset}${bold} setup!${reset}
`;
}

export async function stepExistingConfig(): Promise<"keep" | "modify" | "reset" | null> {
  const configPath = path.join(getPulseedDirPath(), "provider.json");
  if (!fs.existsSync(configPath)) return null;

  const current = await loadProviderConfig();
  p.note(
    [
      `Provider: ${current.provider}`,
      `Model:    ${current.model}`,
      `Adapter:  ${current.adapter}`,
      `API Key:  ${maskKey(current.api_key)}`,
    ].join("\n"),
    "Existing configuration found"
  );

  const choice = guardCancel(
    await p.select({
      message: "What would you like to do?",
      options: [
        { value: "keep" as const, label: "Keep current config", hint: "exit wizard" },
        { value: "modify" as const, label: "Modify", hint: "continue with current values as defaults" },
        { value: "reset" as const, label: "Reset", hint: "start fresh" },
      ],
    })
  );
  return choice;
}

export async function stepUserName(): Promise<string> {
  const name = guardCancel(
    await p.text({
      message: "What should I call you?",
      placeholder: "Your name",
      validate: (v) => {
        if (!v || !v.trim()) return "Name cannot be empty.";
        return undefined;
      },
    })
  );
  return name;
}

export async function stepSeedyName(): Promise<string> {
  p.note(SEEDY_PIXEL + "\n\n" + "Hi! I'm your new agent companion.", "Meet your agent");

  const name = guardCancel(
    await p.text({
      message: "What should your agent be called?",
      placeholder: "Seedy",
      defaultValue: "Seedy",
    })
  );
  return name;
}
