// ─── ShimmerText ───
//
// Renders text with a per-character wave color animation.
// The bright point travels left-to-right across the string on each tick.

import React from "react";
import { Text } from "ink";

// Three-shade green wave palette (dark → medium → light → medium → dark)
const WAVE_COLORS = [
  "#2E7D32",  // dark green
  "#388E3C",
  "#43A047",
  "#4CAF50",  // brand green (medium)
  "#66BB6A",
  "#81C784",
  "#A5D6A7",  // brandLight (peak)
  "#81C784",
  "#66BB6A",
  "#4CAF50",
  "#388E3C",
  "#2E7D32",
] as const;

const WAVE_LEN = WAVE_COLORS.length;
const TICK_MS = 180;

interface ShimmerTextProps {
  children: string;
}

export function ShimmerText({ children }: ShimmerTextProps) {
  const [tick, setTick] = React.useState(0);

  React.useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), TICK_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <Text>
      {[...children].map((ch, i) => (
        <Text key={i} color={WAVE_COLORS[(tick + i) % WAVE_LEN]}>
          {ch}
        </Text>
      ))}
    </Text>
  );
}
