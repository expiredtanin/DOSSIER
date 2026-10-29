import { blurFocus, commandInput, elementRows, expect, finishCommand, openSample, openTab, startNewProject, test, typeCommand } from "./app";
import type { Page } from "@playwright/test";

/** Dach RF1 (Obergeschoss, Satteldach) über den Elemente-Baum wählen. */
async function selectRoof(page: Page): Promise<void> {
  await openTab(page, "Elemente");
  await elementRows(page).filter({ hasText: "RF1" }).first().click();
  await expect(page.getByText("Dachform")).toBeVisible();
}

test("Dach: Kantenneigung ändern, Giebel schalten, Rückgängig ([26])", async ({ page }) => {
  await startNewProject(page);
  await openSample(page);
  await selectRoof(page);

  // Kantenliste im Objekt-Info: vier Kanten des Rechtecks, noch ohne eigene Neigung.
  const edge0 = page.getByLabel("Kante 1: Neigung der Kante (Grad); leer = Standard");
  const edge2 = page.getByLabel("Kante 3: Neigung der Kante (Grad); leer = Standard");
  await expect(page.locator(".objinfo-roof-edge")).toHaveCount(4);
  await expect(edge0).toHaveValue("");
  // Satteldach: Kanten quer zur Firstrichtung sind von Haus aus Giebel (Platzhalter).
  await expect(page.locator(".objinfo-roof-edge").nth(1).locator("input[type=number]")).toHaveAttribute("placeholder", "Giebel");

  // Neigung der ersten Kante auf 20° setzen.
  await edge0.fill("20");
  await expect(edge0).toHaveValue("20");
  await expect(page.getByRole("button", { name: "Alle Kanten auf Standard" })).toBeVisible();

  // Dritte Kante auf Giebel: das Feld wird gesperrt.
  await page.getByLabel("Kante 3: Giebel").check();
  await expect(edge2).toBeDisabled();

  // Rückgängig: erst der Giebel, dann die Neigung sind wieder weg.
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(edge2).toBeEnabled();
  await expect(edge0).toHaveValue("20");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(edge0).toHaveValue("");
  await expect(page.getByRole("button", { name: "Alle Kanten auf Standard" })).toHaveCount(0);
});

test("Dach: Innenhof zeichnen, entfernen, Rückgängig ([26])", async ({ page }) => {
  await startNewProject(page);
  await openSample(page);
  // Das Dach liegt im Obergeschoss: Geschoss aktivieren, Dach wählen.
  await openTab(page, "Zeichnungsebenen");
  await page.getByText("Obergeschoss", { exact: true }).click();
  await selectRoof(page);
  await expect(page.getByText(/^Hof 1:/)).toHaveCount(0);

  // Befehl „Dachhof“ aus dem Objekt-Info: zwei Ecken tippen, Enter = Rechteck.
  await page.getByRole("button", { name: "Hof zeichnen …" }).click();
  await expect(page.locator(".cmdline-prompt")).toContainText("Innenhofs");
  await commandInput(page).focus();
  await typeCommand(page, "1,1");
  await typeCommand(page, "3,2.5");
  await finishCommand(page);

  // Der Hof erscheint in der Liste (2 × 1.5 m = 3 m²) samt vier Hofkanten in der Kantenliste.
  await expect(page.getByText("Hof 1: 3.00 m²")).toBeVisible();
  await expect(page.locator(".objinfo-roof-edge")).toHaveCount(8);

  // Entfernen, dann Rückgängig stellt den Hof wieder her.
  await page.getByRole("button", { name: "Hof entfernen" }).click();
  await expect(page.getByText(/^Hof 1:/)).toHaveCount(0);
  await expect(page.locator(".objinfo-roof-edge")).toHaveCount(4);
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByText("Hof 1: 3.00 m²")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByText(/^Hof 1:/)).toHaveCount(0);
});
