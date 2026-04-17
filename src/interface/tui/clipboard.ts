import { spawn } from "child_process";
import { writeTrustedTuiControl } from "./terminal-output.js";

function spawnWithStdin(cmd: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
    proc.stdin.end(text);
  });
}

function writeOsc52(text: string): boolean {
  const b64 = Buffer.from(text).toString("base64");
  writeTrustedTuiControl(`]52;c;${b64}`);
  return true;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  if (process.platform === "darwin") {
    return spawnWithStdin("pbcopy", [], text);
  }

  if (process.platform === "linux") {
    const xclipOk = await spawnWithStdin("xclip", ["-selection", "clipboard"], text);
    if (xclipOk) return true;
    return spawnWithStdin("xsel", ["--clipboard", "--input"], text);
  }

  return writeOsc52(text);
}

function readClipboard(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    proc.stdout.on("data", (data: Buffer) => { output += data.toString(); });
    proc.on("error", () => resolve(""));
    proc.on("close", (code) => resolve(code === 0 ? output : ""));
  });
}

export async function getClipboardContent(): Promise<string> {
  if (process.platform === "darwin") {
    return readClipboard("pbpaste", []);
  }
  if (process.platform === "linux") {
    const result = await readClipboard("xclip", ["-selection", "clipboard", "-o"]);
    if (result) return result;
    return readClipboard("xsel", ["--clipboard", "--output"]);
  }
  return "";
}
