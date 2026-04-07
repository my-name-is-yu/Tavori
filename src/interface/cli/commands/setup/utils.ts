import * as p from "@clack/prompts";

export function guardCancel<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }
  return value as T;
}
