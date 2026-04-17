import { logTuiDebug } from "./debug-log.js";
import { getActiveCursorEscape } from "./cursor-tracker.js";
import { HIDE_CURSOR } from "./flicker/dec.js";
import { isRenderableFrameChunk } from "./render-output.js";

type WriteCallback = (error?: Error | null) => void;

function createWriteStreamProxy(
  stream: NodeJS.WriteStream,
  writeImpl: typeof stream.write,
): NodeJS.WriteStream {
  return new Proxy(stream, {
    get(target, prop, receiver) {
      if (prop === "write") return writeImpl;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as NodeJS.WriteStream;
}

function getWriteCallback(args: unknown[]): WriteCallback | undefined {
  const last = args.at(-1);
  return typeof last === "function" ? (last as WriteCallback) : undefined;
}

function summarizeChunk(chunk: unknown): { preview: string; bytes: number } {
  const text =
    typeof chunk === "string"
      ? chunk
      : Buffer.isBuffer(chunk)
        ? chunk.toString("utf-8")
        : String(chunk);
  return {
    preview: text.length > 200 ? `${text.slice(0, 200)}...` : text,
    bytes: Buffer.byteLength(text),
  };
}

function logSuppressedWrite(scope: string, chunk: unknown): void {
  const { preview, bytes } = summarizeChunk(chunk);
  logTuiDebug("output-controller", "suppressed-write", { scope, preview, bytes });
}

export interface NoFlickerOutputController {
  readonly renderStdout: NodeJS.WriteStream;
  readonly renderStderr: NodeJS.WriteStream;
  readonly terminalStream: Pick<NodeJS.WriteStream, "write">;
  install(): void;
  writeTerminal(chunk: string): void;
  destroy(): void;
}

export function createNoFlickerOutputController(
  stdout: NodeJS.WriteStream = process.stdout,
  stderr: NodeJS.WriteStream = process.stderr,
): NoFlickerOutputController {
  const rawStdoutWrite = stdout.write.bind(stdout);
  const rawStderrWrite = stderr.write.bind(stderr);
  let installed = false;
  let destroyed = false;

  const swallowWrite = (scope: string, chunk: unknown, args: unknown[]): true => {
    logSuppressedWrite(scope, chunk);
    getWriteCallback(args)?.(null);
    return true;
  };

  const renderStdout = createWriteStreamProxy(
    stdout,
    ((chunk: unknown, ...args: unknown[]) => {
      if (typeof chunk === "string" && isRenderableFrameChunk(chunk)) {
        const cursorEscape = getActiveCursorEscape() ?? HIDE_CURSOR;
        return (rawStdoutWrite as (...rawArgs: unknown[]) => boolean)(chunk + cursorEscape, ...args);
      }

      return (rawStdoutWrite as (...rawArgs: unknown[]) => boolean)(chunk, ...args);
    }) as typeof stdout.write,
  );

  const renderStderr = createWriteStreamProxy(
    stderr,
    ((chunk: unknown, ...args: unknown[]) =>
      (rawStderrWrite as (...rawArgs: unknown[]) => boolean)(chunk, ...args)) as typeof stderr.write,
  );

  return {
    renderStdout,
    renderStderr,
    terminalStream: {
      write: (chunk: string) => rawStdoutWrite(chunk),
    },
    install() {
      if (installed || destroyed) return;
      installed = true;
      stdout.write = ((chunk: unknown, ...args: unknown[]) =>
        swallowWrite("stdout", chunk, args)) as typeof stdout.write;
      stderr.write = ((chunk: unknown, ...args: unknown[]) =>
        swallowWrite("stderr", chunk, args)) as typeof stderr.write;
    },
    writeTerminal(chunk: string) {
      rawStdoutWrite(chunk);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (installed) {
        stdout.write = rawStdoutWrite;
        stderr.write = rawStderrWrite;
      }
    },
  };
}
