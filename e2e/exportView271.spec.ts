// [271][272] Exporte folgen der Ansicht: Der IFC-Export-Dialog zeigt Umbaufilter und Variantenkombination der aktiven Ebene,
// lässt „Hauptvarianten/kein Filter“ wählen, und die Datei enthält nur die Elemente der gewählten Kombination. Der Rendering-
// Dialog zeigt dieselbe Ansicht (Umbau-Farben erst bei einem Umbaufilter, nur mit Cycles — im Browser also nicht).
import { readFile } from "node:fs/promises";
import type { Locator, Page } from "@playwright/test";
import { blurFocus, discardIfAsked, expect, fileMenu, test, typeCommand } from "./app";

/** Download auslösen und den Inhalt als Text zurückgeben. */
async function downloadText(page: Page, trigger: () => Promise<void>): Promise<string> {
  const pending = page.waitForEvent("download");
  await trigger();
  const dl = await pending;
  return (await readFile(await dl.path())).toString("utf8");
}

async function openSampleProject(page: Page, name: RegExp, title: string) {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await fileMenu(page, name);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText(title);
}

async function openIfcDialog(page: Page): Promise<Locator> {
  await fileMenu(page, "Exportieren: IFC");
  const dialog = page.getByRole("dialog", { name: "Exportieren" });
  await expect(dialog).toBeVisible();
  return dialog;
}

const exportIfc = (page: Page, dialog: Locator) => downloadText(page, () => dialog.getByRole("button", { name: "Exportieren", exact: true }).click());

test("IFC-Export übernimmt Kombination und Umbaufilter der Ansicht ([271][272])", async ({ page }) => {
  await openSampleProject(page, /^Neu aus Vorlage: Beispiel Varianten$/, "Beispiel Varianten");

  // Hauptvarianten, kein Filter: der Dialog sagt es und bietet keine Wahl an; das Lochfenster (Fenster 140×130) steht in der Datei.
  let dialog = await openIfcDialog(page);
  await expect(dialog.getByTestId("export-view-summary")).toContainText("Alle Elemente, Hauptvarianten");
  await expect(dialog.getByTestId("export-view-use")).toHaveCount(0);
  const ifcMain = await exportIfc(page, dialog);
  expect(ifcMain).toContain("Fenster 140");
  expect(ifcMain).not.toContain("Fenster 360");

  // Kombination der Ansicht: Fassade B (Bandfenster) über das Panel „Varianten“.
  await page.getByTestId("design-option-toggle").click();
  const panel = page.getByTestId("design-options-panel");
  await expect(panel).toBeVisible();
  await panel.getByTestId("design-option-combo-fassade").selectOption("b");
  await expect.poll(async () => (await page.evaluate(() => window.__dossierTest!.designOptions())).level).toEqual({ fassade: "b" });
  await blurFocus(page);

  // Der Dialog zeigt jetzt die Kombination und übernimmt sie: Bandfenster (Fenster 360×100) in der Datei, Lochfenster nicht.
  dialog = await openIfcDialog(page);
  await expect(dialog.getByTestId("export-view-use")).toBeChecked();
  await expect(dialog.getByTestId("export-view-summary")).toContainText("Fassade B Bandfenster");
  await dialog.screenshot({ path: "test-results/exportView271-ifc.png" });
  const ifcB = await exportIfc(page, dialog);
  expect(ifcB).toContain("Fenster 360");
  expect(ifcB).not.toContain("Fenster 140");

  // „Hauptvarianten/kein Filter“ wählbar: dann wie ohne Kombination.
  dialog = await openIfcDialog(page);
  await dialog.getByTestId("export-view-use").uncheck();
  await expect(dialog.getByTestId("export-view-summary")).toContainText("Hauptvarianten");
  const ifcOff = await exportIfc(page, dialog);
  expect(ifcOff).toContain("Fenster 140");
  expect(ifcOff).not.toContain("Fenster 360");
});

test("Rendering-Dialog zeigt die Ansicht, Umbau-Farben nur im Cycles-Fall ([271])", async ({ page }) => {
  await openSampleProject(page, /^Neu aus Vorlage: Beispiel Umbau$/, "Beispiel Umbau");
  await page.getByTestId("renovation-toggle").click();
  const reno = page.getByTestId("renovation-panel");
  await reno.getByTestId("renovation-filter").selectOption("endzustand");
  await expect.poll(async () => (await page.evaluate(() => window.__dossierTest!.renovation())).filter).toBe("endzustand");
  await blurFocus(page);

  await typeCommand(page, "rendering");
  const dialog = page.getByRole("dialog", { name: "Rendering", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("render-view-use")).toBeChecked();
  await expect(dialog.getByTestId("render-view-summary")).toContainText("Endzustand");
  // Im Browser gibt es nur Blender (Paket): die Umbau-Farben gehören zum eingebauten Cycles.
  await expect(dialog.getByTestId("render-reno-colors")).toHaveCount(0);
  await dialog.getByTestId("render-view-use").uncheck();
  await expect(dialog.getByTestId("render-view-summary")).toContainText("Hauptvarianten");
  await page.screenshot({ path: "test-results/exportView271-render.png" });
});
