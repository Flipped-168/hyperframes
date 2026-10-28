import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const agent = vi.hoisted(() => ({ runtime: null as string | null }));
vi.mock("../telemetry/agent_runtime.js", () => ({ detectAgentRuntime: () => agent.runtime }));

const ttys = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };

function setTty(stdin: boolean, stdout: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { value: stdin, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: stdout, configurable: true });
}

async function load() {
  vi.resetModules();
  return import("./attendedTerminal.js");
}

describe("isCI", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["true", true],
    ["1", true],
    ["github-actions", true],
    ["false", false],
    ["0", false],
    ["", false],
  ])("CI=%j is CI: %s", async (value, expected) => {
    vi.stubEnv("CI", value);
    expect((await load()).isCI()).toBe(expected);
  });
});

describe("isUnattended", () => {
  beforeEach(() => {
    vi.stubEnv("CI", "");
    vi.stubEnv("HYPERFRAMES_AGENT", "");
    agent.runtime = null;
    setTty(true, true);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    setTty(ttys.stdin === true, ttys.stdout === true);
  });

  it("is attended at a terminal with no CI and no agent", async () => {
    expect((await load()).isUnattended()).toBe(false);
  });

  it.each([
    [false, true],
    [true, false],
  ])("is unattended when stdin is a TTY: %s, stdout is a TTY: %s", async (stdin, stdout) => {
    setTty(stdin, stdout);
    expect((await load()).isUnattended()).toBe(true);
  });

  it("is unattended in CI", async () => {
    vi.stubEnv("CI", "buildkite");
    expect((await load()).isUnattended()).toBe(true);
  });

  it("is unattended when a coding agent is detected", async () => {
    agent.runtime = "claude_code";
    expect((await load()).isUnattended()).toBe(true);
  });

  it("is unattended with HYPERFRAMES_AGENT=1", async () => {
    vi.stubEnv("HYPERFRAMES_AGENT", "1");
    expect((await load()).isUnattended()).toBe(true);
  });
});
