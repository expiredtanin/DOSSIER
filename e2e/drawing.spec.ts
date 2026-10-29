import {
  blurFocus,
  commandInput,
  elementRows,
  finishCommand,
  expect,
  openTab,
  startNewProject,
  test,
  typeCommand,
} from "./app";
import type { Page } from "@playwright/test";

/** Wandwerkzeug aus der Werkzeugliste wählen; die Befehlszeile fragt dann nach dem Startpunkt. */
async function pickWallTool(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Wand", exact: true }).click();
  await expect(page.locator(".cmdline-prompt")).toHaveText("Startpunkt der Wand:");
}

test("Wand per Klicks im Grundriss zeichnen", async ({ page }) => {
  await startNewProject(page);
  await openTab(page, "Elemente");
  await pickWallTool(page);

  const box = (await page.locator("canvas").first().boundingBox())!;
  const at = (dx: number, dy: number) => ({ x: box.x + dx, y: box.y + dy });
  const a = at(150, 300);
  const b = at(450, 300);
  await page.mouse.move(a.x, a.y);
  await page.mouse.click(a.x, a.y);
  await expect(page.locator(".cmdline-prompt")).toHaveText("Nächster Punkt:");
  await page.mouse.move(b.x, b.y);
  await page.mouse.click(b.x, b.y);
  await finishCommand(page);

  await expect(elementRows(page)).toHaveCount(1);
  await expect(elementRows(page).first()).toContainText("Aussenwand 34.5 cm");
  await expect(page.locator(".cmdline-prompt")).toHaveText("Befehl:");
});

test("Wand über die Befehlszeile (Koordinaten tippen)", async ({ page }) => {
  await startNewProject(page);
  await openTab(page, "Elemente");
  await pickWallTool(page);
  await commandInput(page).focus();
  await typeCommand(page, "0,0");
  await expect(page.locator(".cmdline-prompt")).toHaveText("Nächster Punkt:");
  await typeCommand(page, "5,0");
  await typeCommand(page, "5,4");
  // Der Zug (Kette) wird erst mit leerem Enter übernommen: drei Punkte = zwei Wände.
  await finishCommand(page);
  await expect(elementRows(page)).toHaveCount(2);
});

test("Rückgängig/Wiederholen per Tastatur und Menü", async ({ page }) => {
  await startNewProject(page);
  await openTab(page, "Elemente");
  await pickWallTool(page);
  await commandInput(page).focus();
  await typeCommand(page, "0,0");
  await typeCommand(page, "5,0");
  await finishCommand(page);
  await expect(elementRows(page)).toHaveCount(1);

  // Fokus aus der Befehlszeile nehmen, damit die Kürzel nicht ins Textfeld gehen.
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(elementRows(page)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(elementRows(page)).toHaveCount(1);

  // Dasselbe über das Bearbeiten-Menü.
  await page.getByRole("button", { name: "Bearbeiten", exact: true }).click();
  await page.getByRole("option", { name: "Rückgängig" }).click();
  await expect(elementRows(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Bearbeiten", exact: true }).click();
  await page.getByRole("option", { name: "Wiederholen" }).click();
  await expect(elementRows(page)).toHaveCount(1);
});

// Maintainer-Fund 28.10.: mehrmals ganz zurück bis zum leeren Projekt und wieder vor — irgendwann war
// der Redo-Stapel weg (Neu/Öffnen lagen im Undo-Verlauf, das leere Startprojekt war erreichbar).
test("Mehrmals ganz zurück und wieder vor: Redo bleibt vollständig", async ({ page }) => {
  await startNewProject(page);
  await openTab(page, "Elemente");
  await pickWallTool(page);
  await commandInput(page).focus();
  await typeCommand(page, "0,0");
  await typeCommand(page, "5,0");
  await typeCommand(page, "5,4");
  await typeCommand(page, "0,4");
  await finishCommand(page);
  await expect(elementRows(page)).toHaveCount(3);
  await blurFocus(page);

  for (let round = 0; round < 3; round++) {
    // Mehr Rückgängig als Schritte: über den Anfang hinaus darf nichts passieren.
    for (let k = 0; k < 6; k++) await page.keyboard.press("ControlOrMeta+z");
    await expect(elementRows(page)).toHaveCount(0);
    for (let k = 0; k < 6; k++) await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(elementRows(page)).toHaveCount(3);
  }
  // „Neues Projekt" ist nicht rückgängig zu machen (Verlauf beginnt neu).
  await expect(page.locator(".project-name")).toHaveText("Leeres Projekt");
});

// [84] Verlaufsliste: Klick auf einen Eintrag springt zu diesem Stand (mehrere Schritte in einem Aufruf).
test("Verlauf-Panel: Klick springt zum Schritt", async ({ page }) => {
  await startNewProject(page);
  await openTab(page, "Elemente");
  for (const [a, b] of [["0,0", "5,0"], ["5,0", "5,4"], ["5,4", "0,4"]]) {
    await page.getByRole("button", { name: "Wand", exact: true }).click();
    // Das Werkzeug bleibt nach dem Befehl gewählt: ein zweiter Klick schaltet es ab, dann erneut wählen.
    if (!(await page.locator(".cmdline-prompt").textContent())?.includes("Startpunkt")) {
      await page.getByRole("button", { name: "Wand", exact: true }).click();
    }
    await expect(page.locator(".cmdline-prompt")).toHaveText("Startpunkt der Wand:");
    await commandInput(page).focus();
    await typeCommand(page, a!);
    await typeCommand(page, b!);
    await finishCommand(page);
  }
  await expect(elementRows(page)).toHaveCount(3);
  await blurFocus(page);

  await page.getByRole("button", { name: "Bearbeiten", exact: true }).click();
  await page.getByRole("option", { name: "Verlauf" }).click();
  const entries = page.getByTestId("history-entry");
  // Jüngster oben: drei Wand-Schritte + Ausgangsstand.
  await expect(entries).toHaveCount(4);
  await expect(entries.first()).toContainText("Wand zeichnen");
  await expect(entries.first()).toHaveAttribute("aria-selected", "true");
  await expect(entries.last()).toContainText("Ausgangsstand");

  // Erster Wand-Eintrag (vorletzte Zeile) → eine Wand; die späteren Schritte bleiben als Wiederholen stehen.
  await entries.nth(2).click();
  await expect(elementRows(page)).toHaveCount(1);
  await expect(entries).toHaveCount(4);
  await expect(entries.nth(2)).toHaveAttribute("aria-selected", "true");
  // Oberster Eintrag → wieder alle drei.
  await entries.first().click();
  await expect(elementRows(page)).toHaveCount(3);
});
