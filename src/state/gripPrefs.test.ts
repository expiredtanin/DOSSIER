import { describe, expect, it } from "vitest";
import { getGripCommitOnRelease, gripCommitsOnRelease } from "./gripPrefs";

describe("gripPrefs", () => {
  it("Vorgabe aus: Griff bleibt bewaffnet", () => {
    expect(getGripCommitOnRelease()).toBe(false);
    expect(gripCommitsOnRelease(0, 0, 50, 0)).toBe(false);
  });

  it("an: Ziehen übernimmt beim Loslassen, Klick ohne Ziehen nicht", () => {
    expect(gripCommitsOnRelease(10, 10, 30, 10, true)).toBe(true);
    expect(gripCommitsOnRelease(10, 10, 11, 11, true)).toBe(false);
  });
});
