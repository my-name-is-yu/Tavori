import React, { useInsertionEffect } from "react";
import { DISABLE_MOUSE_TRACKING, ENABLE_MOUSE_TRACKING } from "./dec.js";
import { getTrustedTuiControlStream } from "../terminal-output.js";

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
  stream?: MouseTrackingStream;
}

export function MouseTracking({
  children,
  enabled = true,
  stream = getTrustedTuiControlStream(),
}: MouseTrackingProps): React.ReactNode {
  useInsertionEffect(() => {
    if (!enabled) return;
    return attachMouseTracking(stream);
  }, [enabled, stream]);

  return React.createElement(React.Fragment, null, children);
}
