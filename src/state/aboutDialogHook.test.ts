import { describe, expect, it, vi } from "vitest";
import { openAboutDialog, setAboutDialogOpener } from "./aboutDialogHook";

describe("aboutDialogHook [263]", () => {
  it("ruft den registrierten Öffner auf, danach nicht mehr", () => {
    const fn = vi.fn();
    setAboutDialogOpener(fn);
    openAboutDialog();
    expect(fn).toHaveBeenCalledTimes(1);
    setAboutDialogOpener(null);
    openAboutDialog();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
