import { describe, expect, it } from "vitest";
import { BUG_REPORT_URL, bugReportUrl } from "./bugReport";

describe("bugReportUrl [263]", () => {
  it("zeigt auf die Issue-Seite und trägt nur Version und Build", () => {
    const url = bugReportUrl("Version: {version}\n\nWas passiert?", "Build", { version: "1.0.0-beta.1", build: "261116.1" });
    expect(url.startsWith(`${BUG_REPORT_URL}?body=`)).toBe(true);
    const body = decodeURIComponent(url.split("?body=")[1]!);
    expect(body).toBe("Version: 1.0.0-beta.1 (Build 261116.1)\n\nWas passiert?");
    expect(new URL(url).hostname).toBe("git.openbureau.ch");
  });
});
