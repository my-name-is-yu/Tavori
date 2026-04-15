import React, { useInsertionEffect } from "react";
import { DISABLE_MOUSE_TRACKING, ENABLE_MOUSE_TRACKING } from "./dec.js";

type MouseTrackingStream = Pick<NodeJS.WriteStream, "write">;

export function attachMouseTracking(stream: MouseTrackingStream): () => void {
  stream.write(ENABLE_MOUSE_TRACKING);

  const disable = () => {
    stream.write(DISABLE_MOUSE_TRACKING);
  };

  process.once("exit", disable);

  return () => {
    process.off("exit", disable);
    disable();
  };
}

interface MouseTrackingProps {
  children?: React.ReactNode;
  enabled?: boolean;
}

export function MouseTracking({
  children,
  enabled = true,
}: MouseTrackingProps): React.ReactNode {
  useInsertionEffect(() => {
    if (!enabled) return;
    return attachMouseTracking(process.stdout);
  }, [enabled]);

  return React.createElement(React.Fragment, null, children);
}
