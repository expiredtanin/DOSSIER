// [271] Umbau: Beispiel Umbau öffnen, Umbaufilter in der Statusleiste umschalten (Plan-Farben nach SIA), Undo des
// Filters, Status einer Wand in der Objekt-Info setzen (ein Undo-Schritt), Befehl `umbau` auf der Auswahl, Zeichen-Status.
// Geprüft über die sichtbare UI und den Plan (Test-Naht `planFillColors`, `renovation`), nicht über Pixel.
import { blurFocus, discardIfAsked, expect, fileMenu, openTab, test, typeCommand } from "./app";

const GREY = "#a6a6a6";
const YELLOW = "#ffd800";
const RED = "#e3001b";

test("Umbaufilter, Status setzen und Undo ([271])", async ({ page }) => {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await fileMenu(page, /^Neu aus Vorlage: Beispiel Umbau$/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Beispiel Umbau");
  const fills = () => page.evaluate(() => window.__dossierTest!.planFillColors());
  const ren = () => page.evaluate(() => window.__dossierTest!.renovation());
  // Ohne Filter: keine Umbau-Farben.
  expect(Object.keys(await fills())).not.toContain(RED);

  // Statusleiste: Umbau → Umbaufilter „Umbauplan“.
  const toggle = page.getByTestId("renovation-toggle");
  await expect(toggle).toContainText("Bestand");
  await toggle.click();
  const panel = page.getByTestId("renovation-panel");
  await expect(panel).toBeVisible();
  await panel.getByTestId("renovation-filter").selectOption("umbauplan");
  await expect.poll(async () => (await ren()).filter).toBe("umbauplan");
  await expect.poll(async () => Object.keys(await fills()).filter((c) => [GREY, YELLOW, RED].includes(c)).sort()).toEqual([GREY, RED, YELLOW].sort());
  await page.screenshot({ path: "test-results/renovation271-umbauplan.png" });

  // Neubau: Abbruch weg (kein Gelb), Neu rot.
  await panel.getByTestId("renovation-filter").selectOption("neubau");
  await expect.poll(async () => (await ren()).filter).toBe("neubau");
  await expect.poll(async () => Object.keys(await fills())).not.toContain(YELLOW);
  expect(Object.keys(await fills())).toContain(RED);
  await page.keyboard.press("Escape");
  await blurFocus(page);
  // Undo nimmt den Filterwechsel zurück (Feld der Ebene).
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await ren()).filter).toBe("umbauplan");

  // Wand W1 wählen, Objekt-Info: Umbau → Neu; Undo in einem Schritt.
  await page.evaluate(() => window.__dossierTest!.select({ walls: ["W1"] }));
  await openTab(page, "Objekt-Info");
  const field = page.getByTestId("objinfo-renovation");
  await expect(field).toBeVisible();
  await field.getByRole("button", { name: "Umbau" }).click();
  await page.getByRole("option", { name: "Neu", exact: true }).click();
  await expect.poll(async () => (await ren()).walls.W1).toBe("new");
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await ren()).walls.W1).toBe("existing");

  // Befehl `umbau` auf der Auswahl: Option A (Abbruch).
  await page.evaluate(() => window.__dossierTest!.select({ walls: ["W1", "W2"] }));
  await typeCommand(page, "umbau");
  await typeCommand(page, "A");
  await expect.poll(async () => {
    const w = (await ren()).walls;
    return [w.W1, w.W2];
  }).toEqual(["demolish", "demolish"]);

  // Zeichen-Status in der Statusleiste: Neu.
  await page.getByTestId("renovation-toggle").click();
  await page.getByTestId("renovation-draw-status").selectOption("new");
  await expect.poll(async () => (await ren()).draw).toBe("new");
  await expect(page.getByTestId("renovation-toggle")).toContainText("Neu");
});
