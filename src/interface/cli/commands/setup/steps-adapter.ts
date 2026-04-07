import * as p from "@clack/prompts";
import { RECOMMENDED_ADAPTERS, getAdaptersForModel } from "../setup-shared.js";
import type { Provider } from "../setup-shared.js";
import { guardCancel } from "./utils.js";

export async function stepAdapter(model: string, provider: Provider): Promise<string> {
  const adapters = getAdaptersForModel(model, provider);
  const recommendedAdapter = RECOMMENDED_ADAPTERS[provider];

  if (adapters.length === 0) {
    p.log.error(`No compatible adapters found for model "${model}".`);
    return "";
  }

  if (adapters.length <= 1) {
    const adapter = adapters[0];
    p.log.info(`Adapter: ${adapter} (auto-selected)`);
    return adapter;
  }

  const options = adapters.map((adapter) => ({
    value: adapter,
    label: adapter,
    hint: adapter === recommendedAdapter ? "recommended" : undefined,
  }));

  const adapter = guardCancel(await p.select({ message: "Select execution adapter:", options }));
  return adapter;
}
