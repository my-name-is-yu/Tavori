import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { writeJsonFile } from "../utils/json-io.js";

export class PIDManager {
  private pidPath: string;

  constructor(baseDir: string, pidFile: string = "pulseed.pid") {
    this.pidPath = path.join(baseDir, pidFile);
  }

  /** Write current process PID to file (atomic write) */
  async writePID(): Promise<void> {
    const info = {
      pid: process.pid,
      started_at: new Date().toISOString(),
    };
    const tmpPath = this.pidPath + ".tmp";
    await writeJsonFile(tmpPath, info);
    await fsp.rename(tmpPath, this.pidPath);
  }

  /** Read PID from file. Returns null if file doesn't exist or is invalid */
  async readPID(): Promise<{ pid: number; started_at: string } | null> {
    try {
      const content = await fsp.readFile(this.pidPath, "utf-8");
      const data = JSON.parse(content) as { pid: number; started_at: string };
      if (typeof data.pid !== "number") return null;
      return data;
    } catch {
      return null;
    }
  }

  /** Check if a process with the stored PID is actually running */
  async isRunning(): Promise<boolean> {
    const info = await this.readPID();
    if (!info) return false;
    try {
      // signal 0 doesn't kill, just checks if process exists
      process.kill(info.pid, 0);
      return true;
    } catch {
      // Process doesn't exist - clean up stale PID file
      await this.cleanup();
      return false;
    }
  }

  /** Remove PID file */
  async cleanup(): Promise<void> {
    try {
      await fsp.unlink(this.pidPath);
    } catch {
      // Ignore cleanup errors (file may not exist)
    }
  }

  /** Get the PID file path */
  getPath(): string {
    return this.pidPath;
  }
}
