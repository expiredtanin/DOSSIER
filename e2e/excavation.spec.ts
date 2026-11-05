// [143] Baugrube erstellen wie ein Nutzer (Mac-Befund 5.11.: „Die Baugrube lässt sich gar nicht erstellen"):
// Befehl/Panel-Knopf, Umriss tippen, Enter. Geprüft: Hinweis (Toast), Eintrag im Panel „Gelände", Linien der
// Baugrube im Grundriss (Farbe EXCAVATION_INK, `plan/context.rs`), Schnitt mit Gelände, Rückgängig entfernt sie.
// Ursachen vorher: Kategorie „02 Gelände" (in Grundrissen oft ausgeblendet → Baugrube unsichtbar), Sohle immer
// −0.30 (las eine Liste `floors`, die es nicht gibt), ohne Gelände stilles Nichts.
import type { Page } from "@playwright/test";
import { blurFocus, commandInput, discardIfAsked, expect, fileMenu, openTab, showSnapshot, startNewProject, test, typeCommand } from "./app";

const ink = (page: Page) => page.locator('svg.plan-svg [stroke="#1f242c"]').count();
const toast = (page: Page) => page.locator(".toast-message");
const sitePanel = (page: Page) => page.locator(".site-panel");

async function drawExcavation(page: Page, pts: string[]): Promise<void> {
  await commandInput(page).focus();
  for (const p of pts) await typeCommand(page, p);
  await commandInput(page).press("Enter");
  await expect(page.locator(".cmdline-prompt")).toHaveText("Befehl:");
}

test("Musterhaus komplex: Baugrube per Panel-Knopf im Ausschnitt EG 1:100, sichtbar im Grundriss, Rückgängig", async ({ page }) => {
  test.setTimeout(120_000);
  await startNewProject(page);
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });
  await expect(page.locator("svg.plan-svg").first()).toBeVisible({ timeout: 30_000 });
  // Ausschnitt „EG 1:100" (Grundriss-Vorlage: Gelände „02" ausgeblendet — dort war eine neue Baugrube unsichtbar).
  await showSnapshot(page, "EG 1:100");
  await openTab(page, "Ebenen");
  await expect(page.getByRole("button", { name: /^Gelände sichtbar$/ })).toHaveAttribute("title", "Einblenden");
  // Ganzen Plan zeigen (das SVG enthält nur, was im Bild liegt).
  await page.locator('[title="Auf Plan einpassen"]').first().click();
  await expect.poll(() => ink(page), { timeout: 30_000 }).toBeGreaterThan(0);
  const before = await ink(page);

  await openTab(page, "Gelände");
  await page.getByRole("button", { name: "Baugrube zeichnen" }).click();
  await expect(page.locator(".cmdline-prompt")).toHaveText("Erster Punkt der Baugrubensohle:");
  await drawExcavation(page, ["-25,-10", "-12,-10", "-12,0", "-25,0"]);

  await expect(toast(page).filter({ hasText: /Baugrube angelegt: Sohle −3\.00 m/ })).toBeVisible();
  await expect(sitePanel(page)).toContainText("Baugrube 2");
  // Im Erdgeschoss-Grundriss sichtbar (Gelände „02" ist dort ausgeblendet, die Baugrube „07" nicht).
  await expect.poll(() => ink(page)).toBeGreaterThan(before);

  // Rückgängig: weg aus Panel und Plan.
  await blurFocus(page);
  await page.keyboard.press("Control+z");
  await expect(sitePanel(page)).not.toContainText("Baugrube 2");
  await expect.poll(() => ink(page)).toBe(before);
});

test("Leeres Projekt ohne Gelände: klarer Hinweis statt stillem Nichts", async ({ page }) => {
  await startNewProject(page);
  await commandInput(page).focus();
  await typeCommand(page, "baugrube");
  await expect(toast(page).filter({ hasText: "Baugrube braucht ein Gelände" })).toBeVisible();
  await expect(page.locator(".cmdline-prompt")).toHaveText("Befehl:");
  await typeCommand(page, "terrain");
  await expect(toast(page).filter({ hasText: "Kein Gelände erzeugt" })).toBeVisible();
  await expect(page.locator(".cmdline-prompt")).toHaveText("Befehl:");
});

test("Leeres Projekt mit Gelände in m ü. M.: Gelände erzeugen, Baugrube, ±0.00 angenommen, Rückgängig", async ({ page }) => {
  test.setTimeout(90_000);
  await startNewProject(page);
  // Projekt mit Höhenlinien (Hang 500–512 m ü. M., kein Höhenbezug) speichern und wieder öffnen.
  const pending = page.waitForEvent("download");
  await fileMenu(page, "Projekt speichern");
  const dl = await pending;
  const { readFile } = await import("node:fs/promises");
  const json = JSON.parse((await readFile((await dl.path())!)).toString("utf8"));
  const contours = [];
  for (let i = 0; i <= 12; i++) {
    const y = -30 + i * 5;
    contours.push({ z: 500 + i, pts: [-40, -20, 0, 20, 40].map((x) => ({ x, y: y + x * 0.02 })), closed: false, layer: "HL" });
  }
  json.context = [{ type: "contourSet", id: "hl", name: "Höhenlinien", layer: "Terrain", categoryCode: "14", contours }];
  json.name = "Hang";
  const chooser = page.waitForEvent("filechooser");
  await fileMenu(page, "Projekt öffnen");
  await (await chooser).setFiles({ name: "hang.obp", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(json)) });
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Hang", { timeout: 10_000 });

  await openTab(page, "Gelände");
  await page.getByRole("button", { name: "Gelände erzeugen" }).click();
  await expect(page.getByRole("button", { name: "Baugrube zeichnen" })).toBeVisible();
  const before = await ink(page);
  await page.getByRole("button", { name: "Baugrube zeichnen" }).click();
  await drawExcavation(page, ["-6,-5", "6,5"]); // 2 Punkte = Rechteck
  await expect(toast(page).filter({ hasText: /±0\.00 = 50\d\.\d\d m ü\. M\. angenommen/ })).toBeVisible();
  await expect(sitePanel(page)).toContainText("Baugrube 1");
  await expect(sitePanel(page)).toContainText(/Abtrag [1-9]/);
  await expect.poll(() => ink(page)).toBeGreaterThan(before);

  await blurFocus(page);
  await page.keyboard.press("Control+z");
  await expect(sitePanel(page)).not.toContainText("Baugrube 1");
});
