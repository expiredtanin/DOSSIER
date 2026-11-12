// [204] App-Review im Browser (Bedienung wie Archicad): Befunde, die bisher kein Test fing.
// (1) Esc in einem modalen Dialog (DXF-Export) bei bestehender Auswahl: schloss den Dialog nicht, hob aber die
//     Auswahl dahinter auf. (2) Geschoss wechseln (Cmd/Ctrl+6) im Reiter eines Ausschnitts: Reiter hiess weiter
//     „EG 1:100“. (3) „Ausschnitt aktualisieren“ lief über den Umbenennen-Knopf. (4) Status-Leiste zählte nur Wände;
//     Werkzeugliste zeigte zweimal „Schnittlinie“.
import {
  blurFocus,
  discardIfAsked,
  drawingTab,
  drawingTabs,
  expect,
  fileMenu,
  openSample,
  showSnapshot,
  snapshotPanel,
  startNewProject,
  test,
} from "./app";
import type {} from "../src/state/testHooks"; // Typ von window.__dossierTest

const selectedWalls = async (page: import("@playwright/test").Page) =>
  JSON.parse((await page.evaluate(() => window.__dossierTest!.selected())).all).walls as string[];

test("Esc im DXF-Export-Dialog schliesst ihn und lässt die Auswahl dahinter stehen", async ({ page }) => {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await openSample(page);
  await page.evaluate(() => window.__dossierTest!.select({ walls: ["W2"] }));
  await expect(page.getByText("Auswahl: 1 Wand")).toBeVisible();

  await fileMenu(page, /Exportieren: DXF/);
  const dialog = page.getByRole("dialog", { name: "DXF/DWG exportieren" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.waitForTimeout(100);
  expect(await selectedWalls(page)).toEqual(["W2"]);

  // Ohne Dialog hebt Esc die Auswahl weiterhin auf.
  await blurFocus(page);
  await page.keyboard.press("Escape");
  await expect.poll(() => selectedWalls(page)).toEqual([]);
});

test("Status-Leiste und Werkzeugliste: Tür zählt als Element, Ansichtslinie eigene Beschriftung", async ({ page }) => {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await openSample(page);
  await page.evaluate(() => window.__dossierTest!.select({ openings: ["D1"] }));
  await expect(page.getByText("Auswahl: 1 Element", { exact: true })).toBeVisible();
  await page.evaluate(() => window.__dossierTest!.select({ walls: ["W1"], openings: ["D1", "O1"] }));
  await expect(page.getByText("Auswahl: 3 Elemente", { exact: true })).toBeVisible();

  await expect(page.locator(".tp-item").filter({ hasText: /^Schnittlinie$/ })).toHaveCount(1);
  await expect(page.locator(".tp-item").filter({ hasText: /^Ansichtslinie$/ })).toHaveCount(1);
});

test("Geschoss wechseln im Reiter eines Ausschnitts: Reiter heisst wie das Geschoss; Aktualisieren-Knopf überlappt nicht", async ({ page }) => {
  test.setTimeout(120_000);
  await startNewProject(page);
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });

  await showSnapshot(page, "EG 1:100");
  await expect(drawingTab(page, "EG 1:100")).toHaveAttribute("aria-selected", "true");

  // Fusszeile des Ausschnitts: „Ausschnitt aktualisieren“ liegt neben (nicht über) dem Umbenennen-Knopf.
  const update = snapshotPanel(page).getByTestId("viewsnap-update");
  await expect(update).toBeVisible();
  const rename = snapshotPanel(page).locator(".viewsnap-footer-name button").last();
  const r = await rename.boundingBox();
  // Rechter Rand des TEXTES (nicht des Knopfs: der war 20 px breit, der Text lief darüber hinaus).
  const textRight = await update.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getBoundingClientRect().right;
  });
  expect(textRight).toBeLessThanOrEqual(r!.x + 0.5);

  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+6");
  await expect(drawingTabs(page).getByRole("tab")).toHaveCount(1);
  await expect(drawingTab(page, "Obergeschoss")).toHaveAttribute("aria-selected", "true");
  await expect(drawingTab(page, "EG 1:100")).toHaveCount(0);
});
