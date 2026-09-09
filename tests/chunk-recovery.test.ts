import { describe, expect, it } from "vitest";
import { shouldReloadChunk } from "../frontend/src/lib/chunk-recovery.js";
import {
  isReloadGuarded,
  registerReloadGuard,
} from "../frontend/src/lib/reload-guard.js";

describe("frontend deployment recovery", () => {
  it("reloads an obsolete lazy chunk once per recovery window", () => {
    expect(shouldReloadChunk(0, 100_000)).toBe(true);
    expect(shouldReloadChunk(90_000, 100_000)).toBe(false);
    expect(shouldReloadChunk(60_000, 100_001)).toBe(true);
  });

  it("blocks automatic reload only while a critical plugin surface is active", () => {
    expect(isReloadGuarded()).toBe(false);
    const unregister = registerReloadGuard("meeting-recorder-test", () => true);
    expect(isReloadGuarded()).toBe(true);
    unregister();
    expect(isReloadGuarded()).toBe(false);
  });
});
