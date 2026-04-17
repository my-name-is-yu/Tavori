import stringWidth from "string-width";

export function measureTextWidth(text: string): number {
  return stringWidth(text);
}

export function measureCharWidth(ch: string): number {
  return stringWidth(ch);
}
