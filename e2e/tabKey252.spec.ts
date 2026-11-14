// [252] Tab bleibt immer für die Befehlszeile (auch bei Fokus auf einem Panel-Knopf); Ctrl+Tab / Ctrl+Umschalt+Tab
// springt zyklisch durch die Ansichts-Reiter.
import { commandInput, discardIfAsked, drawingTabs, expect, fileMenu, openTab, test } from "./app";

test("Tab fokussiert die Befehlszeile, Ctrl+Tab wechselt die Reiter", async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });

  // Tab aus einem Panel-Knopf landet in der Befehlszeile.
  await page.getByRole("tab", { name: "Elemente", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(commandInput(page)).toBeFocused();

  // Zwei Reiter: Grundriss + 3D (Ctrl+3 öffnet den 3D-Reiter).
  await openTab(page, "Zeichnungsebenen");
  await page.locator(".nav-row").filter({ hasText: "Erdgeschoss" }).first().click();
  await page.keyboard.press("Control+3");
  const tabs = drawingTabs(page).getByRole("tab");
  await expect(tabs).toHaveCount(2);
  const selected = async () => tabs.evaluateAll((els) => els.findIndex((e) => e.getAttribute("aria-selected") === "true"));
  const start = await selected();
  await page.keyboard.press("Control+Tab");
  await expect.poll(selected).toBe((start + 1) % 2);
  await page.keyboard.press("Control+Shift+Tab");
  await expect.poll(selected).toBe(start);
  await page.keyboard.press("Control+Shift+Tab");
  await expect.poll(selected).toBe((start + 1) % 2);
});
