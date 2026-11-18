// [281] Geneigte Decken und Rampen: Beispiel Wettbewerb (Eingangsrampe 6 % an der Ostfassade) öffnen, Gefällepfeil im
// Grundriss, Objekt-Info „Neigung“ (Gefälle ändern, Undo, ausschalten), Befehl „Rampe“ (Umriss, Gefällelinie, −12 %).
// Geprüft über das Modell (Test-Naht) und den Plan, nicht über Pixel; Screenshot für die Sichtprüfung in `test-results/`.
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
