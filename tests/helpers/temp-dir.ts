import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export function makeTempDir(prefix = "pulseed-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function cleanupTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
