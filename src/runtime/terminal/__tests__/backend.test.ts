import { describe, expect, it } from "vitest";
import { resolveTerminalBackendConfig, wrapTerminalCommand } from "../backend.js";

describe("terminal backend", () => {
  it("keeps local commands unchanged", () => {
    const command = wrapTerminalCommand(
      { command: "codex", args: ["exec"], cwd: "/tmp/work", stdinData: "prompt" },
      undefined
    );

    expect(command).toMatchObject({
      backend: "local",
      command: "codex",
      args: ["exec"],
      cwd: "/tmp/work",
      stdinData: "prompt",
    });
  });

  it("wraps commands in docker with cwd mounted read/write", () => {
    const command = wrapTerminalCommand(
      { command: "claude", args: ["--print"], cwd: "/tmp/work" },
      { type: "docker", docker: { image: "node:22", network: "none" } }
    );

    expect(command.command).toBe("docker");
    expect(command.backend).toBe("docker");
    expect(command.args).toEqual([
      "run",
      "--rm",
      "-i",
      "--network",
      "none",
      "-v",
      "/tmp/work:/workspace",
      "-w",
      "/workspace",
      "node:22",
      "claude",
      "--print",
    ]);
    expect(command.cwd).toBeUndefined();
  });

  it("passes adapter env into the docker container and lets backend env override it", () => {
    const command = wrapTerminalCommand(
      {
        command: "codex",
        args: ["exec"],
        cwd: "/tmp/work",
        env: {
          OPENAI_API_KEY: "sk-host",
          NO_COLOR: "1",
          TERM: "dumb",
          PWD: "/tmp/work",
        },
      },
      {
        type: "docker",
        docker: {
          image: "node:22",
          env: { OPENAI_API_KEY: "sk-container" },
        },
      }
    );

    expect(command.args).toContain("-e");
    expect(command.args).toContain("OPENAI_API_KEY=sk-container");
    expect(command.args).toContain("NO_COLOR=1");
    expect(command.args).toContain("TERM=dumb");
    expect(command.args).not.toContain("PWD=/tmp/work");
  });

  it("requires docker image for docker backend", () => {
    expect(() => resolveTerminalBackendConfig({ type: "docker", docker: { image: "" } }))
      .toThrow("docker.image");
  });
});
