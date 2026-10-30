// Musterhaus komplex: aus dem Datei-Menü öffnen, durch alle Geschosse, Schnitte/Ansichten und Layout-Blätter
// schalten — ohne Konsolenfehler (Wächter in app.ts). Den Publikationssatz „Baueingabe" als PDF ausgeben.
// Mit DOSSIER_SHOTS=<ordner> entstehen Screenshots je Blatt und das PDF für die Abnahme.
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { discardIfAsked, expect, fileMenu, openTab, startNewProject, test } from "./app";

// Gespeicherte Ausschnitte erscheinen als Zeichnungs-Reiter (Geschosse, Schnitte, Ansichten, Detail, 3D).
const VIEWS = ["UG 1:100", "EG 1:100", "OG 1:100", "DG 1:100", "EG 1:50 Ausschnitt Wohnen", "Situation 1:500", "EG Brandschutz", "Schnitt A-A", "Schnitt B-B", "Ansicht Süd", "Ansicht Ost", "Ansicht Nord", "Ansicht West", "Detail Deckenauflager 1:10", "Axonometrie Südost"];
const SHEETS = ["Grundrisse UG / EG", "Grundrisse OG / DG", "Grundriss EG Wohnen 1:50", "Listen: Fenster, Türen, Flächen, U-Werte", "Detail und Situation"];

test("Musterhaus komplex: Geschosse, Ansichten und Blätter ohne Konsolenfehler", async ({ page }) => {
  test.setTimeout(240_000);
  const shots = process.env.DOSSIER_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  await startNewProject(page);
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });

  const tabs = page.getByRole("tablist", { name: "Zeichnungen" });
  for (const name of VIEWS) {
    const tab = tabs.getByRole("tab", { name: `${name} Ausschnitt-Tab löschen`, exact: true });
    await tab.click();
    if (!name.startsWith("Axonometrie")) await expect(page.locator("svg.plan-svg").first()).toBeVisible({ timeout: 30_000 });
  }
  // Zurück in einen Grundriss (der 3D-Viewport schliesst).
  await tabs.getByRole("tab", { name: "EG 1:100 Ausschnitt-Tab löschen", exact: true }).click();

  await openTab(page, "Mappe");
  for (const name of SHEETS) {
    await page.locator(".nav-row", { hasText: name }).first().dblclick();
    await expect(page.locator(".layout-sheet-pane")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".layout-sheet-stage")).toContainText("Musterhaus komplex", { timeout: 30_000 });
    if (shots) await page.locator(".layout-sheet-stage").screenshot({ path: `${shots}/blatt-${SHEETS.indexOf(name) + 1}.png`, timeout: 60_000 });
  }

  // Publikationssatz → ein PDF mit allen Blättern des Satzes.
  await expect(page.locator("[data-publish-set=pub-baueingabe]")).toBeVisible();
  const pending = page.waitForEvent("download", { timeout: 120_000 });
  await page.locator("[data-publish-set=pub-baueingabe] [data-publish-run]").click();
  const dl = await pending;
  const bytes = await readFile((await dl.path())!);
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  expect(bytes.length).toBeGreaterThan(100_000);
  if (shots) await writeFile(`${shots}/baueingabe.pdf`, bytes);
});
