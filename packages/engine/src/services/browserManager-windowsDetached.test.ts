import { afterEach, describe, expect, it, vi } from "vitest";
import { ownedLaunchOptions } from "./browserManager.js";

describe("ownedLaunchOptions", () => {
  afterEach(() => vi.unstubAllGlobals());

  const launchOn = (platform: NodeJS.Platform) => {
    vi.stubGlobal("process", Object.create(process, { platform: { value: platform } }));
    return ownedLaunchOptions();
  };

  it("keeps Chrome attached to the CLI's console on Windows", () => {
    expect(launchOn("win32")).toMatchObject({ detached: false });
  });

  it("leaves the process-group default alone elsewhere", () => {
    expect(launchOn("linux")).not.toHaveProperty("detached");
  });
});
