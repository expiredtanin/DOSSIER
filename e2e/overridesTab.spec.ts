// [33] Overrides-Tab: eine Regel „Darstellung = Ansicht → Ausblenden“ anlegen — die Ansicht Süd des
// Musterhaus komplex verliert ihre Bauteile (gezählt über die SVG-Elemente der Zeichnung, nicht über Pixel).
import { discardIfAsked, expect, fileMenu, showSnapshot, startNewProject, test } from "./app";

test("Overrides-Tab: Regel Darstellung = Ansicht mit Ausblenden ändert die Ansicht ([33])", async ({ page }) => {
  test.setTimeout(120_000);
  await startNewProject(page);
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });
  await showSnapshot(page, "Ansicht Süd");
  await expect(page.locator("svg.plan-svg").first()).toBeVisible({ timeout: 30_000 });
  const count = () => page.locator("svg.plan-svg polyline, svg.plan-svg line, svg.plan-svg polygon, svg.plan-svg path").count();
  await expect.poll(count, { timeout: 30_000 }).toBeGreaterThan(100);
  // Die Ansicht rechnet asynchron: warten, bis zwei Zählungen im Abstand von 700 ms gleich sind.
  let before = -1;
  for (let i = 0; i < 40; i++) {
    const n = await count();
    if (n === before) break;
    before = n;
    await page.waitForTimeout(700);
  }

  await page.getByRole("button", { name: "Fenster", exact: true }).first().click();
  await page.getByRole("option", { name: /Ressourcen/ }).click();
  await page.getByRole("tab", { name: /Überschreibungen|Overrides/ }).click();
  await page.locator(".res-window").getByRole("button", { name: /Neu$/ }).click();
  const detail = page.getByTestId("override-rule-detail");
  const pick = async (field: string, option: string) => {
    await detail.locator(".res-field", { has: page.locator(".res-field-label", { hasText: new RegExp(`^${field}$`) }) }).first().locator(".tb-dd-trigger").click();
    await page.getByRole("option", { name: option, exact: true }).click();
  };
  await pick("Kriterium", "Darstellung");
  await pick("Wert", "Ansicht");
  await detail.getByRole("checkbox", { name: "Ausblenden" }).first().check();
  await expect(detail.getByRole("checkbox", { name: "Ausblenden" })).toHaveCount(2);
  await page.locator(".res-window").getByRole("button", { name: "Schließen" }).first().click();

  // Wände, Decken, Dach und Öffnungen sind weg (Gelände und Schatten bleiben: nur mit Bauteilart).
  await expect.poll(count, { timeout: 30_000 }).toBeLessThan(before / 2);
});
