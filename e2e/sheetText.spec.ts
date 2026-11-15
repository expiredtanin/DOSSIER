// [208] Freier Text auf dem Plakat: Knopf „Text" (Textspalte auf der Blatt-Ebene), Rahmen aufziehen, tippen, Blocksatz,
// Undo — und der Text steht im PDF der WBW-Abgabe (pdftotext, eingebettete Schrift), umbrochen in der Rahmenbreite.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { pdfText, skipWithoutPoppler } from "./pdf";
import { expect, openSample, openTab, startNewProject, test } from "./app";

async function paperBox(page: Page) {
  return (await page.locator("[data-sheet-backdrop] > rect").nth(1).boundingBox())!;
}

async function openHistory(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Bearbeiten", exact: true }).click();
  await page.getByRole("option", { name: "Verlauf" }).click();
  await expect(page.locator("[data-testid=history-panel]")).toBeVisible();
  // Schwebendes Fenster aus dem Weg (über das rechte Dock) ziehen.
  const tb = await page.locator("section[aria-label=Verlauf] .floating-title").boundingBox();
  if (tb && tb.x < 1250) {
    await page.mouse.move(tb.x + 10, tb.y + tb.height / 2);
    await page.mouse.down();
    await page.mouse.move(1300, 760, { steps: 5 });
    await page.mouse.up();
  }
}

const SATZ =
  "Der Hof öffnet sich nach Süden und verbindet die beiden Häuser mit dem Dorfplatz. Erläuterung zum Konzept: ruhige Fassaden, klare Wege, " +
  "ein gemeinsamer Hof für alle Bewohnerinnen und Bewohner und ein Bach, der den Platz im Osten begrenzt und die Wohnungen im Erdgeschoss schützt.";

test("Plakat: Textspalte aufziehen, tippen, Blocksatz, Undo, Text im PDF", async ({ page }) => {
  skipWithoutPoppler();
  await startNewProject(page);
  await openSample(page);

  // Plakat A1 quer aus der Vorlage (Hilfslinien am Master).
  await openTab(page, "Mappe");
  await page.getByRole("button", { name: "Layout erstellen" }).first().click();
  await page.locator("[data-testid=newlayout-poster]").check();
  await page.getByRole("button", { name: "Erstellen", exact: true }).click();
  await page.keyboard.press("Enter");
  await page.locator(".nav-row", { hasText: "Layout" }).first().dblclick();
  await expect(page.locator(".layout-sheet-pane")).toBeVisible();
  await openHistory(page);
  const paper = await paperBox(page);

  // Knopf „Text": Befehl Textspalte, zwei Ecken ziehen den Rahmen auf (30 % der Blattbreite).
  await page.locator("[data-add-text]").click();
  await expect(page.locator(".cmdline-prompt")).toHaveText("Erste Ecke:");
  const a = { x: paper.x + paper.width * 0.08, y: paper.y + paper.height * 0.3 };
  const b = { x: paper.x + paper.width * 0.38, y: paper.y + paper.height * 0.45 };
  await page.mouse.move(a.x - 5, a.y - 5);
  await page.mouse.move(a.x, a.y, { steps: 3 });
  await page.mouse.click(a.x, a.y);
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.click(b.x, b.y);

  // Inline-Editor: tippen, alles markieren, Blocksatz.
  const surface = page.locator(".planview-inline-text .rt-surface");
  await expect(surface).toBeVisible();
  await surface.click();
  await page.keyboard.type(SATZ);
  await page.keyboard.press("ControlOrMeta+a");
  await page.locator(".planview-inline-text [data-rt-align=justify]").click();
  await expect(page.locator(".planview-inline-text [data-rt-align=justify]")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(page.locator(".planview-inline-text")).toHaveCount(0);

  // Ein Undo-Schritt macht die Textspalte weg, Wiederholen bringt sie samt Text zurück.
  const history = page.locator("[data-testid=history-panel] .history-row:not(.future)").filter({ hasNotText: "Ausgangsstand" });
  const steps = await history.count();
  await page.locator("body").click({ position: { x: 2, y: 2 } });
  await page.keyboard.press("ControlOrMeta+z");
  await expect(history).toHaveCount(steps - 1);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(history).toHaveCount(steps);

  await page.locator("section[aria-label=Verlauf]").getByRole("button", { name: "Schließen" }).click();
  // Anonym + WBW-Satz: ein PDF, der Text steht darin (zeilenweise umbrochen, nicht in einer Zeile).
  await page.locator("[data-testid=competition-anonymous]").check();
  await page.locator("[data-testid=competition-keyword]").fill("FALKE 7");
  await page.locator("[data-testid=publish-add-wbw]").click();
  const pending = page.waitForEvent("download");
  await page.locator("[data-publish-set] [data-publish-run]").click();
  const dl = await pending;
  const bytes = await readFile((await dl.path())!);
  const text = pdfText(bytes);
  expect(text).toContain("Dorfplatz");
  expect(text).toContain("Erläuterung");
  expect(text).toContain("ruhige Fassaden");
  const line = text.split("\n").find((l) => l.includes("Der Hof"))!;
  expect(line).toBeTruthy();
  expect(line.includes("schützt")).toBe(false); // umbrochen in der Rahmenbreite: das Ende steht in einer späteren Zeile
  if (process.env.DOSSIER_SHOTS) {
    await mkdir(process.env.DOSSIER_SHOTS, { recursive: true });
    await writeFile(`${process.env.DOSSIER_SHOTS}/plakat-text.pdf`, bytes);
    await page.screenshot({ path: `${process.env.DOSSIER_SHOTS}/plakat-text-blatt.png` });
  }
});
