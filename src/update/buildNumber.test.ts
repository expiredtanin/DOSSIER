import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { formatBuildInfo, formatBuildShort } from "./buildInfo";

const { computeBuildNumber, dateStamp, BUILD_RE } = createRequire(import.meta.url)("../../scripts/build-number.cjs") as {
  computeBuildNumber: (o?: { env?: Record<string, string | undefined>; now?: Date; commitCount?: number }) => string;
  dateStamp: (d: Date) => string;
  BUILD_RE: RegExp;
};

describe("[261] Buildnummer JJMMTT.N", () => {
  const now = new Date(2026, 10, 15, 14, 30); // 15.11.2026 lokal
  it("Datum als JJMMTT", () => {
    expect(dateStamp(now)).toBe("261115");
    expect(dateStamp(new Date(2027, 0, 5))).toBe("270105");
  });
  it("Zähler = Commits des Tages", () => {
    expect(computeBuildNumber({ env: {}, now, commitCount: 1 })).toBe("261115.1");
    expect(computeBuildNumber({ env: {}, now, commitCount: 2 })).toBe("261115.2");
    expect(computeBuildNumber({ env: {}, now, commitCount: 12 })).toBe("261115.12");
  });
  it("ohne Git: JJMMTT.0", () => {
    expect(computeBuildNumber({ env: {}, now, commitCount: 0 })).toBe("261115.0");
  });
  it("DOSSIER_BUILD überschreibt (nur gültiges Format)", () => {
    expect(computeBuildNumber({ env: { DOSSIER_BUILD: "261201.7" }, now, commitCount: 3 })).toBe("261201.7");
    expect(computeBuildNumber({ env: { DOSSIER_BUILD: "unsinn" }, now, commitCount: 3 })).toBe("261115.3");
    expect(computeBuildNumber({ env: { DOSSIER_BUILD: "" }, now, commitCount: 3 })).toBe("261115.3");
  });
  it("echter Aufruf liefert gültiges Format", () => {
    expect(computeBuildNumber({ env: {} })).toMatch(BUILD_RE);
  });
});

describe("[261] Anzeige", () => {
  it("Version + Build", () => {
    expect(formatBuildInfo({ version: "1.0.0-beta.1", build: "261115.1" }, "Build")).toBe("1.0.0-beta.1 (Build 261115.1)");
    expect(formatBuildShort({ version: "1.0.0-beta.1", build: "261115.1" }, "Build")).toBe("Build 261115.1");
  });
});
