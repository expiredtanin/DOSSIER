// [281] Geneigte Decken und Rampen: Beispiel Wettbewerb (Eingangsrampe 6 % an der Ostfassade) öffnen, Gefällepfeil im
// Grundriss, Objekt-Info „Neigung“ (Gefälle ändern, Undo, ausschalten), Befehl „Rampe“ (Umriss, Gefällelinie, −12 %).
// Geprüft über das Modell (Test-Naht) und den Plan, nicht über Pixel; Screenshot für die Sichtprüfung in `test-results/`.
import type { Page } from "@playwright/test";
import { blurFocus, commandInput, discardIfAsked, expect, fileMenu, test, typeCommand } from "./app";

test("Rampe: Grundriss-Symbol, Objekt-Info Neigung mit Undo, Befehl Rampe ([281])", async ({ page }) => {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await fileMenu(page, /^Neu aus Vorlage: Wettbewerb$/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toContainText("Wettbewerb");
  const slopes = () => page.evaluate(() => window.__dossierTest!.ceilingSlopes());
  await expect.poll(async () => (await slopes())["c-rampe"]).toEqual({ rise: -0.36, ramp: true });
  // Lauflinie der Rampe (Schaft + Pfeilspitze) im Grundriss EG.
  await expect.poll(() => page.evaluate(() => window.__dossierTest!.planLines("ceiling-slope"))).toBeGreaterThanOrEqual(3);

  // Objekt-Info: Abschnitt Neigung, Modus Rampe, Gefälle 6 % → 8 % (Undo zurück).
  await page.evaluate(() => window.__dossierTest!.select({ ceilings: ["c-rampe"] }));
  await expect(page.getByTestId("objinfo-ceiling-slope-ramp")).toHaveClass(/active/);
  const pct = page.getByTestId("objinfo-ceiling-slope-percent").locator("input");
  await expect(pct).toHaveValue("6.0");
  await pct.fill("8");
  await pct.press("Enter");
  await expect.poll(async () => (await slopes())["c-rampe"]?.rise).toBeCloseTo(-0.48, 6);
  await page.screenshot({ path: "test-results/ramp281-objinfo.png" });
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await slopes())["c-rampe"]?.rise).toBeCloseTo(-0.36, 6);
  // Ausschalten: waagrecht; Undo bringt die Rampe zurück.
  await page.getByTestId("objinfo-ceiling-slope-off").click();
  await expect.poll(async () => (await slopes())["c-rampe"]).toBeUndefined();
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await slopes())["c-rampe"]?.ramp).toBe(true);

  // Befehl „Rampe“: Umriss 6 × 2 m, Gefällelinie längs, −12 % ⇒ Höhenunterschied −0.72 m.
  await page.evaluate(() => window.__dossierTest!.select({ ceilings: [] }));
  await typeCommand(page, "rampe");
  for (const p of ["30,0", "36,0", "36,2", "30,2"]) await typeCommand(page, p);
  await commandInput(page).press("Enter");
  await typeCommand(page, "30,1");
  await typeCommand(page, "36,1");
  await typeCommand(page, "-12");
  await expect.poll(async () => Object.values(await slopes()).filter((s) => Math.abs(s.rise + 0.72) < 1e-6 && s.ramp).length).toBe(1);
});

/** Mittelpunkte der Eck-Griffe (Kreise, ohne Einfüge-Rauten) in Client-Pixeln. */
async function gripCentres(page: Page): Promise<{ x: number; y: number }[]> {
  return page.locator(".plan-grip:not(.plan-grip-insert)").evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }),
  );
}

test("Rampe: Griffe der Gefällelinie ziehen, Gefälle in % bleibt, ein Undo-Schritt ([281])", async ({ page }) => {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await fileMenu(page, /^Neu aus Vorlage: Wettbewerb$/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toContainText("Wettbewerb");
  const line = () => page.evaluate(() => window.__dossierTest!.ceilingSlopeLine("c-rampe"));
  const slopes = () => page.evaluate(() => window.__dossierTest!.ceilingSlopes());
  const before = (await line())!;
  const len0 = Math.hypot(before.to.x - before.from.x, before.to.y - before.from.y);
  expect((await slopes())["c-rampe"].rise / len0).toBeCloseTo(-0.06, 6);

  // Rampe wählen: 4 Ecken + 2 Griffe der Gefällelinie (liegen zwischen den Ecken in y).
  await page.evaluate(() => window.__dossierTest!.select({ ceilings: ["c-rampe"] }));
  await expect.poll(async () => (await gripCentres(page)).length).toBe(6);
  const g = await gripCentres(page);
  const ys = g.map((p) => p.y);
  const mid = g.filter((p) => p.y > Math.min(...ys) + 2 && p.y < Math.max(...ys) - 2).sort((a, b) => a.x - b.x);
  expect(mid).toHaveLength(2);
  const gTo = mid[1];

  // Ende ziehen (Griff folgt bis zum Klick): Linie wird länger, Gefälle bleibt −6 %.
  const target = { x: gTo.x + 60, y: gTo.y };
  await page.mouse.move(gTo.x, gTo.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 6 });
  await page.mouse.up();
  await page.mouse.click(target.x, target.y);
  await expect.poll(async () => (await line())!.to.x).toBeGreaterThan(before.to.x + 0.1);
  const after = (await line())!;
  expect(after.from).toEqual(before.from);
  const len1 = Math.hypot(after.to.x - after.from.x, after.to.y - after.from.y);
  expect(len1).toBeGreaterThan(len0);
  expect((await slopes())["c-rampe"].rise / len1).toBeCloseTo(-0.06, 6);

  // Ein Undo-Schritt je Zug.
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await line())!.to.x).toBeCloseTo(before.to.x, 6);
  expect((await slopes())["c-rampe"].rise).toBeCloseTo(-0.36, 6);
});
