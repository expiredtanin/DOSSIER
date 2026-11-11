// [182] Reiter-Arten wie Archicad: Geschoss im Navigator behält die Art des Reiters (3D bleibt 3D), Schnitt/Ansicht
// öffnen eigene Reiter, und 3D ist aus jedem Reiter erreichbar (kein „Lock" im Schnitt).
import { discardIfAsked, drawingTab, drawingTabs, expect, fileMenu, openTab, startNewProject, test } from "./app";

test("Reiter-Arten: 3D bleibt 3D beim Geschoss-Wechsel, Schnitt eigener Reiter, 3D aus dem Schnitt", async ({ page }) => {
  test.setTimeout(120_000);
  await startNewProject(page);
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });
  const tabs = drawingTabs(page).getByRole("tab");
  const nav = (name: string) => page.locator(".nav-row").filter({ hasText: name }).first();

  await openTab(page, "Zeichnungsebenen");
  await nav("Erdgeschoss").click();
  await expect(page.locator("svg.plan-svg").first()).toBeVisible({ timeout: 30_000 });

  // 3D: eigener Reiter, Grundriss-Reiter bleibt.
  await page.getByRole("button", { name: "Axonometrie", exact: true }).click();
  await expect(tabs).toHaveCount(2);
  await expect(drawingTab(page, "3D · Erdgeschoss")).toHaveAttribute("aria-selected", "true");

  // Geschoss OG im Navigator: bleibt 3D, nur das aktive Geschoss wechselt.
  await nav("Obergeschoss").click();
  await expect(drawingTab(page, "3D · Obergeschoss")).toHaveAttribute("aria-selected", "true");
  await expect(tabs).toHaveCount(2);
  await expect(page.locator("svg.plan-svg")).toHaveCount(0);

  // Schnitt: neuer Reiter, der 3D-Reiter existiert weiter.
  await nav("Schnitt A-A").click();
  await expect(tabs).toHaveCount(3);
  await expect(drawingTab(page, "Schnitt A-A")).toHaveAttribute("aria-selected", "true");
  await expect(drawingTab(page, "3D · Obergeschoss")).toHaveAttribute("aria-selected", "false");
  await expect(page.locator("svg.plan-svg").first()).toBeVisible({ timeout: 30_000 });

  // Nochmal Schnitt anwählen: kein weiterer Reiter.
  await nav("Erdgeschoss").click(); // Grundriss-Reiter
  await expect(tabs).toHaveCount(3);
  await nav("Schnitt A-A").click();
  await expect(tabs).toHaveCount(3);

  // Aus dem Schnitt ins 3D: wechselt in den 3D-Reiter.
  await page.getByRole("button", { name: "Axonometrie", exact: true }).click();
  await expect(tabs).toHaveCount(3);
  await expect(drawingTab(page, "3D · Obergeschoss")).toHaveAttribute("aria-selected", "true");
  await expect(drawingTab(page, "Schnitt A-A")).toHaveCount(1);
});
