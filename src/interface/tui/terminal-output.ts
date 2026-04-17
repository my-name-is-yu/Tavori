type WriteTarget = Pick<NodeJS.WriteStream, "write">;

let trustedControlStream: WriteTarget | null = null;

export function setTrustedTuiControlStream(stream: WriteTarget | null): void {
  trustedControlStream = stream;
}

export function getTrustedTuiControlStream(): WriteTarget {
  return trustedControlStream ?? process.stdout;
}

export function writeTrustedTuiControl(chunk: string): boolean {
  return getTrustedTuiControlStream().write(chunk);
}
