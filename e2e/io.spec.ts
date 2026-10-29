import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import {
  blurFocus,
  discardIfAsked,
  elementRows,
  expect,
  fileMenu,
  openSample,
  openTab,
  startNewProject,
  test,
} from "./app";
import { BEISPIEL_OBP, KLEIN_DXF } from "./paths";

/** Download auslösen (Klick auf `trigger`) und Name + Inhalt zurückgeben. */
async function download(page: Page, trigger: () => Promise<void>) {
  const pending = page.waitForEvent("download");
  await trigger();
  const dl = await pending;
  const path = await dl.path();
  return { name: dl.suggestedFilename(), bytes: await readFile(path) };
}

/** Datei über die versteckte Dateiauswahl hinter einem Menüpunkt laden. */
async function chooseFile(page: Page, menuItem: string | RegExp, file: string | { name: string; mimeType: string; buffer: Buffer }) {
  const chooser = page.waitForEvent("filechooser");
  await fileMenu(page, menuItem);
  await (await chooser).setFiles(file);
}

test("Beispielprojekt aus Datei öffnen (.obp-Fixture der CLI)", async ({ page }) => {
  await startNewProject(page);
  await chooseFile(page, "Projekt öffnen", BEISPIEL_OBP);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Demo-Haus", { timeout: 4000 });
  await openTab(page, "Elemente");
  await expect(elementRows(page).filter({ hasText: "W1" })).toBeVisible();
});

test("Speichern: .obp-Download mit gültigem Projekt-JSON", async ({ page }) => {
  await startNewProject(page);
  await openSample(page);
  const saved = await download(page, () => fileMenu(page, "Projekt speichern"));
  expect(saved.name).toMatch(/\.obp$/);
  const json = JSON.parse(saved.bytes.toString("utf8"));
  expect(json.name).toBe("Demo-Haus");
  expect(json.walls).toHaveLength(9);
});

test("Speichern und Laden: .obp-Rundreise", async ({ page }) => {
  await startNewProject(page);
  await openSample(page);

  const saved = await download(page, () => fileMenu(page, "Projekt speichern"));
  expect(saved.name).toMatch(/\.obp$/);
  expect(saved.bytes.length).toBeGreaterThan(1000);
  const json = JSON.parse(saved.bytes.toString("utf8"));
  expect(json.name).toBe("Demo-Haus");

  // Anderes Projekt öffnen, dann die gespeicherte Datei laden: der Baum ist wieder der alte.
  await fileMenu(page, "Neues Projekt");
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Leeres Projekt");
  await chooseFile(page, "Projekt öffnen", { name: saved.name, mimeType: "application/json", buffer: saved.bytes });
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Demo-Haus", { timeout: 4000 });
  await openTab(page, "Elemente");
  await expect(elementRows(page).filter({ hasText: "W9" })).toBeVisible();

  // Öffnen leert den Verlauf ([K4] S4): Rückgängig führt nicht ins vorherige (leere) Projekt.
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".project-name")).toHaveText("Demo-Haus");
  await expect(elementRows(page).filter({ hasText: "W9" })).toBeVisible();
});

test("Export IFC: Datei nicht leer, STEP-Kopf stimmt", async ({ page }) => {
  await startNewProject(page);
  await openSample(page);
  await fileMenu(page, "Exportieren: IFC");
  const dialog = page.getByRole("dialog", { name: "Exportieren" });
  await expect(dialog).toBeVisible();
  const ifc = await download(page, () => dialog.getByRole("button", { name: "Exportieren", exact: true }).click());
  expect(ifc.name).toBe("Demo-Haus.ifc");
  const text = ifc.bytes.toString("utf8");
  expect(text.length).toBeGreaterThan(10_000);
  expect(text.startsWith("ISO-10303-21;")).toBe(true);
  expect(text).toMatch(/FILE_SCHEMA\(\('IFC4/);
  expect(text).toMatch(/IFCWALL/);
  await expect(dialog).toBeHidden();
});

test("Export DXF: Dialog, Datei nicht leer, Kopf stimmt", async ({ page }) => {
  await startNewProject(page);
  await openSample(page);
  await fileMenu(page, "Exportieren: DXF");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const dxf = await download(page, () => dialog.locator(".imp-btn.primary").click());
  expect(dxf.name).toMatch(/\.dxf$/);
  const text = dxf.bytes.toString("utf8");
  expect(text.length).toBeGreaterThan(2000);
  // Gültiges ASCII-DXF beginnt mit Gruppe 0/SECTION und endet mit EOF.
  expect(text.slice(0, 80)).toMatch(/^\s*(999|0)\s/);
  expect(text).toMatch(/ENTITIES/);
  expect(text.trimEnd().endsWith("EOF")).toBe(true);
});

test("Import einer kleinen DXF legt eine Zeichnung an", async ({ page }) => {
  await startNewProject(page);
  await chooseFile(page, /DXF\/DWG importieren/, KLEIN_DXF);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator(".imp-btn.primary").click();
  await expect(dialog).toBeHidden();
  await openTab(page, "Zeichnungsebenen");
  await expect(page.getByText("klein", { exact: false }).first()).toBeVisible();

  // Ein Import = ein Undo-Schritt ([K4] S3): einmal Rückgängig entfernt Ebene und Zeichnungen, Wiederholen bringt alles zurück.
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByText("klein", { exact: false })).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(page.getByText("klein", { exact: false }).first()).toBeVisible();
});
