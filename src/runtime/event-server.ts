import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as http from "node:http";
import type { DriveSystem } from "../drive/drive-system.js";
import { PulSeedEventSchema } from "../types/drive.js";
import { getEventsDir } from "../utils/paths.js";
import type { Logger } from "./logger.js";

export interface EventServerConfig {
  host?: string; // default: "127.0.0.1" (localhost only!)
  port?: number; // default: 41700
  eventsDir?: string; // default: ~/.pulseed/events/
}

export class EventServer {
  private server: http.Server | null = null;
  private driveSystem: DriveSystem;
  private host: string;
  private port: number;
  private eventsDir: string;
  private fileWatcher: fs.FSWatcher | null = null;
  private readonly logger?: Logger;

  constructor(driveSystem: DriveSystem, config?: EventServerConfig, logger?: Logger) {
    this.driveSystem = driveSystem;
    this.host = config?.host ?? "127.0.0.1";
    this.port = config?.port ?? 41700;
    // Default events directory: ~/.pulseed/events/
    this.eventsDir = config?.eventsDir ?? getEventsDir();
    this.logger = logger;
  }

  /** Start HTTP server */
  async start(): Promise<void> {
    await fsp.mkdir(this.eventsDir, { recursive: true });
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      const server = this.server;
      server.listen(this.port, this.host, () => {
        // When port 0 is used, capture the OS-assigned port
        const addr = server.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
        }
        resolve();
      });
      this.server.on("error", reject);
    });
  }

  /** Stop HTTP server */
  async stop(): Promise<void> {
    this.stopFileWatcher();
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }

  /**
   * Start watching the events directory for new `.json` files.
   * When a file appears:
   *   1. Read and parse it
   *   2. Validate via PulSeedEventSchema
   *   3. Dispatch to DriveSystem (writeEvent)
   *   4. Move to events/processed/ subdirectory
   *   5. Log errors for malformed files but don't crash
   *
   * Creates the events directory if it doesn't exist.
   */
  startFileWatcher(): void {
    if (this.fileWatcher) return; // already watching

    fs.mkdirSync(this.eventsDir, { recursive: true });

    this.fileWatcher = fs.watch(this.eventsDir, (eventType, filename) => {
      if ((eventType !== "rename" && eventType !== "change") || !filename) return;
      if (!filename.endsWith(".json") || filename.endsWith(".tmp")) return;

      const filePath = path.join(this.eventsDir, filename);
      void this.processEventFile(filePath, filename).catch((err) => {
        this.logger?.error(
          `EventServer: unhandled error processing event file "${filename}": ${String(err)}`
        );
      });
    });
  }

  /** Stop the file watcher and clean up the handle. */
  stopFileWatcher(): void {
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }
  }

  /**
   * Read, validate, dispatch, and move a single event file.
   * Errors are logged but never propagated (caller must not crash).
   */
  private async processEventFile(filePath: string, filename: string): Promise<void> {
    try {
      let stat;
      try {
        // Retry on ENOENT: on macOS, fs.watch fires 'rename' before the file
        // is visible to fsp.stat, so retry up to 3 times with 20ms delay.
        let lastErr: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            stat = await fsp.stat(filePath);
            break;
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== "ENOENT") throw err;
            lastErr = err;
            await new Promise((r) => setTimeout(r, 20));
          }
        }
        if (!stat) {
          // File never appeared — already removed
          void lastErr; // suppress unused warning
          return;
        }
      } catch {
        return; // non-ENOENT error — file already removed or inaccessible
      }
      if (!stat.isFile()) return;

      const content = await fsp.readFile(filePath, "utf-8");
      const raw = JSON.parse(content) as unknown;
      const event = PulSeedEventSchema.parse(raw);

      // Dispatch to DriveSystem
      await this.driveSystem.writeEvent(event);

      // Move to processed/
      const processedDir = path.join(this.eventsDir, "processed");
      await fsp.mkdir(processedDir, { recursive: true });
      const dstPath = path.join(processedDir, filename);
      await fsp.rename(filePath, dstPath);
    } catch (err) {
      this.logger?.error(
        `EventServer: failed to process event file "${filename}": ${String(err)}`
      );
      // Do not re-throw — watcher must keep running
    }
  }

  /** Handle incoming HTTP request */
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Only accept POST /events
    if (req.method !== "POST" || req.url !== "/events") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    const MAX_BODY_SIZE = 1_048_576; // 1 MB
    let body = "";
    let bytesReceived = 0;
    req.on("data", (chunk: Buffer) => {
      bytesReceived += chunk.length;
      if (bytesReceived > MAX_BODY_SIZE) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Payload too large" }));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      try {
        const data = JSON.parse(body) as unknown;
        const event = PulSeedEventSchema.parse(data);
        // Write event to file queue (DriveSystem will pick it up)
        // Fire-and-forget: writeEvent is now async but HTTP handler responds immediately
        void this.driveSystem.writeEvent(event).catch((err) => {
          this.logger?.error(`EventServer: writeEvent failed: ${String(err)}`);
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "accepted", event_type: event.type }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid event", details: String(err) }));
      }
    });
  }

  /** Check if server is running */
  isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  /** Check if file watcher is active (internal use) */
  private isWatching(): boolean {
    return this.fileWatcher !== null;
  }

  getPort(): number {
    return this.port;
  }

  getHost(): string {
    return this.host;
  }

  private getEventsDir(): string {
    return this.eventsDir;
  }
}
