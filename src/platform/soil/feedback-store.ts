import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  SoilCompileMissObservationSchema,
  type SoilCompileMissObservation,
} from "./contracts.js";

function compileMissLogPath(baseDir: string): string {
  return path.join(baseDir, "dream", "soil-feedback", "compile-misses.jsonl");
}

export async function appendSoilCompileMissObservations(input: {
  baseDir: string;
  observations: SoilCompileMissObservation[];
}): Promise<void> {
  if (input.observations.length === 0) {
    return;
  }
  const filePath = compileMissLogPath(input.baseDir);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const lines = input.observations
    .map((observation) => JSON.stringify(SoilCompileMissObservationSchema.parse(observation)))
    .join("\n");
  await fsp.appendFile(filePath, `${lines}\n`, "utf8");
}

export async function loadSoilCompileMissObservations(input: {
  baseDir: string;
  limit?: number;
}): Promise<SoilCompileMissObservation[]> {
  const raw = await fsp.readFile(compileMissLogPath(input.baseDir), "utf8").catch(() => "");
  if (!raw.trim()) {
    return [];
  }
  const observations: SoilCompileMissObservation[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      observations.push(SoilCompileMissObservationSchema.parse(JSON.parse(line)));
    } catch {
      // Ignore malformed feedback lines; health reporting should stay best-effort.
    }
  }
  const limit = input.limit ?? observations.length;
  return observations.slice(Math.max(0, observations.length - limit));
}

