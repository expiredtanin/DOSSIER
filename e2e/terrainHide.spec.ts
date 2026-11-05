// [T6][114] Gelände ausblenden (Musterhaus komplex): Kategorie „Gelände" im Ebenen-Panel aus → das Terrain
// verschwindet im Grundriss, im Schnitt und in der Ansicht (3D: Unit-Test `sampleProjectComplex.terrainHide`).
import { discardIfAsked, drawingTab, expect, fileMenu, openSnapshotInNewTab, openTab, startNewProject, test } from "./app";


test("Musterhaus komplex: Gelände lässt sich ausblenden (Grundriss, Schnitt, Ansicht)", async ({ page }) => {
  test.setTimeout(120_000);
  await startNewProject(page);
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });

  // Zählt, bis zwei Messungen im Abstand von 700 ms gleich sind (die Pläne rechnen asynchron).
  const settled = async (fn: () => Promise<number>) => {
    let last = -1;
    for (let i = 0; i < 40; i++) {
      const n = await fn();
      if (n > 100 && n === last) return n;
      last = n;
      await page.waitForTimeout(700);
    }
    return last;
  };
  // [136] Die drei Ausschnitte als eigene Reiter öffnen; danach wechselt die Reiterleiste (das Ebenen-Panel bleibt offen).
  for (const name of ["Schnitt A-A", "Ansicht Süd", "Situation 1:500"]) await openSnapshotInNewTab(page, name);
  const tab = (name: string) => drawingTab(page, name);

  await openTab(page, "Ebenen");
  const gelaende = page.getByRole("button", { name: /^Gelände sichtbar$/ });

  // Ansichten übernehmen beim Öffnen ihre gespeicherte Sichtbarkeit: zuerst wählen, dann ausblenden.
  for (const name of ["Schnitt A-A", "Ansicht Süd"]) {
    await tab(name).click();
    await expect(page.locator("svg.plan-svg").first()).toBeVisible({ timeout: 30_000 });
    await expect(gelaende).toHaveAttribute("title", "Ausblenden");
    const count = () => page.locator("svg.plan-svg polyline, svg.plan-svg line, svg.plan-svg polygon").count();
    await expect.poll(count, { timeout: 30_000 }).toBeGreaterThan(100);
    const before = await settled(count);
    await gelaende.click();
    await expect(gelaende).toHaveAttribute("title", "Einblenden");
    await expect.poll(count, { message: name }).toBeLessThan(before);
    await gelaende.click();
    await expect(gelaende).toHaveAttribute("title", "Ausblenden");
  }

  // Situation 1:500: Höhenlinien und Geländeumriss weg.
  await tab("Situation 1:500").click();
  const count = () => page.locator("svg.plan-svg polyline, svg.plan-svg line, svg.plan-svg polygon").count();
  await expect.poll(count, { timeout: 30_000 }).toBeGreaterThan(100);
  await expect(gelaende).toHaveAttribute("title", "Ausblenden");
  const before = await settled(count);
  await gelaende.click();
  await expect(gelaende).toHaveAttribute("title", "Einblenden");
  await expect.poll(count).toBeLessThan(before);
});
