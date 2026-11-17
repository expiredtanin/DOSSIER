// [274] Sanierung je Schicht: Beispiel Umbau öffnen; Objekt-Info der sanierten Südwand („Neuer Aufbau (Sanierung)“ mit
// Streifen Alt/Neu/Ergebnis), auf „keiner“ und Undo; Umbau-Panel „Sanierung“: Typ-Paar mit Zähler, Zuordnung je Schicht
// (manuell, Undo), Sanierungstyp anlegen, „Alle Wände vom Typ sanieren“ in einem Undo-Schritt. Geprüft über die UI und
// die Test-Naht `renovation`/`planFillColors`. Bilder: `test-results/renovation274-*.png`.
import { blurFocus, discardIfAsked, expect, fileMenu, openTab, test } from "./app";

test.use({ viewport: { width: 1280, height: 800 } });

const RED = "#e3001b";

test("Sanierung je Schicht: Feld, Typ-Paar, alle sanieren ([274])", async ({ page }) => {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await fileMenu(page, /^Neu aus Vorlage: Beispiel Umbau$/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Beispiel Umbau");
  const ren = () => page.evaluate(() => window.__dossierTest!.renovation());
  const fills = () => page.evaluate(() => window.__dossierTest!.planFillColors());
  expect((await ren()).buildUp.W1).toBe("type");

  // Objekt-Info: Südwand W1 saniert (wie Typ), Streifen Alt/Neu/Ergebnis.
  await page.evaluate(() => window.__dossierTest!.select({ walls: ["W1"] }));
  await openTab(page, "Objekt-Info");
  const field = page.getByTestId("objinfo-renovation-buildup");
  await expect(field).toBeVisible();
  await expect(field).toContainText("wie Typ: Aussenwand Beton 20 + Dämmung 20 (saniert)");
  const strip = page.getByTestId("objinfo-renovation-strip");
  await expect(strip).toBeVisible();
  await expect(strip.getByTestId("reno-strip-result").locator('[data-kind="newOverDemolish"]')).toHaveCount(2);
  await field.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/renovation274-objektinfo.png" });
  // Auf „keiner“ und zurück (ein Undo-Schritt).
  await field.getByRole("button", { name: "Neuer Aufbau (Sanierung)" }).click();
  await page.getByRole("option", { name: "keiner", exact: true }).click();
  await expect.poll(async () => (await ren()).buildUp.W1).toBe("");
  await expect(strip).toHaveCount(0);
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await ren()).buildUp.W1).toBe("type");

  // Umbau-Panel, Abschnitt Sanierung: Typ-Paar, Zähler, Editor.
  await openTab(page, "Umbau");
  const panel = page.getByTestId("renovation-dock");
  const san = panel.getByTestId("reno-sanierung");
  await expect(san.getByTestId("reno-sanierung-count")).toHaveText("Sanierte Bauteile: 1");
  await expect(san.getByTestId("reno-pair")).toHaveCount(1);
  await san.getByTestId("reno-pair-edit").click();
  const ed = san.getByTestId("reno-pair-editor");
  await expect(ed).toBeVisible();
  await expect(ed.getByTestId("reno-pair-old-layer")).toHaveCount(3);
  await expect(ed.getByTestId("reno-pair-old-layer").nth(0)).toHaveAttribute("data-fate", "demolish");
  await expect(ed.getByTestId("reno-pair-old-layer").nth(2)).toHaveAttribute("data-fate", "kept");
  await ed.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/renovation274-panel.png" });
  // Manuell: Beton abbrechen ⇒ neuer Beton neu; Undo.
  await ed.getByTestId("reno-pair-old-fate").nth(2).selectOption("demolish");
  await expect(ed.getByTestId("reno-pair-new-layer").nth(2)).toHaveAttribute("data-fate", "new");
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(ed.getByTestId("reno-pair-new-layer").nth(2)).toHaveAttribute("data-fate", "kept");

  // Umbauplan: Rot im Grundriss (neue Schichten der Südwand und Anbau).
  await panel.getByTestId("reno-filter-umbauplan").click();
  await expect.poll(async () => Object.keys(await fills())).toContain(RED);

  // Sanierungstyp für „Aussenwand 34.5 cm“ anlegen, alle Wände vom Typ sanieren (ein Undo-Schritt).
  await san.getByTestId("reno-create-type").selectOption("aw");
  await san.getByTestId("reno-create").click();
  await expect(san.getByTestId("reno-pair")).toHaveCount(2);
  const pair = san.getByTestId("reno-pair").filter({ hasText: "Aussenwand 34.5 cm" });
  await pair.getByTestId("reno-pair-renovate-all").click();
  await expect.poll(async () => Object.values((await ren()).buildUp).filter((v) => v === "type").length).toBe(8);
  await expect(san.getByTestId("reno-sanierung-count")).toHaveText("Sanierte Bauteile: 8");
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => Object.values((await ren()).buildUp).filter((v) => v === "type").length).toBe(1);
});
