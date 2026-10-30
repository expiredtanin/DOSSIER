// Tabellen auf dem Layout-Blatt ([111]): eine lebendige Fenster-/Türliste auf dem Blatt folgt dem Modell
// (Fenster löschen → Zeile weg, Rückgängig → Zeile wieder da) und steht als Vektortext im Ordner-PDF.
// Mit DOSSIER_SHOTS=<ordner> entsteht zusätzlich ein Screenshot des Blatts für die Abnahme.
import { readFile, writeFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import type { Page } from "@playwright/test";
import { blurFocus, elementRows, expect, openSample, openTab, startNewProject, test } from "./app";

/** Layout in einem neuen Ordner anlegen und öffnen. */
async function openNewLayoutInFolder(page: Page) {
  await openTab(page, "Mappe");
  await page.getByRole("button", { name: "Ordner erstellen" }).first().click();
  await page.keyboard.press("Enter");
  // Ordner wählen: das neue Layout landet darin.
  await page.locator(".nav-label", { hasText: "Neuer Ordner" }).click();
  await page.getByRole("button", { name: "Layout erstellen" }).first().click();
  await page.getByRole("button", { name: "Erstellen", exact: true }).click();
  await page.keyboard.press("Enter");
  await page.locator(".nav-row", { hasText: "Layout" }).first().dblclick();
  await expect(page.locator(".layout-sheet-pane")).toBeVisible();
}

/** Fenster-Marken („F1.01") der Tabelle auf dem Blatt. */
async function tableMarks(page: Page): Promise<string[]> {
  const texts = await page.locator("[data-table-id] text").allTextContents();
  return texts.filter((s) => /^F\d\.\d\d$/.test(s));
}

/** Text aller Inhaltsströme eines PDFs (Flate entpackt). */
function pdfStreams(buf: Buffer): string {
  const src = buf.toString("latin1");
  let out = src;
  for (const m of src.matchAll(/stream\r?\n/g)) {
    const start = m.index! + m[0].length;
    const end = src.indexOf("endstream", start);
    if (end < 0) continue;
    try {
      out += inflateSync(buf.subarray(start, end)).toString("latin1");
    } catch {
      /* kein Flate-Strom */
    }
  }
  return out;
}

test("Tabelle auf dem Blatt: lebendig, mit Spaltenwahl, im PDF als Vektortext", async ({ page }) => {
  await startNewProject(page);
  await openSample(page);
  await openNewLayoutInFolder(page);

  // Tabelle „Fenster- und Türliste" platzieren.
  await page.locator("[data-table-add]").selectOption({ label: "Fenster- und Türliste" });
  await expect(page.locator("[data-table-id]")).toHaveCount(1);
  await expect(page.locator("[data-table-hud]")).toBeVisible();
  const before = await tableMarks(page);
  expect(before.length).toBeGreaterThan(1);
  expect(before[0]).toBe("F1.01");

  // Spaltenwahl: „Räume" dazu, „Brüstung" weg.
  await page.locator("[data-table-col=rooms]").check();
  await page.locator("[data-table-col=sill]").uncheck();
  const headers = await page.locator("[data-table-id] text").allTextContents();
  expect(headers).toContain("Räume");
  expect(headers).not.toContain("Brüstung [m]");

  // Weitere Tabellen (Bauteile mit U-Wert, Flächen SIA 416) untereinander.
  for (const [label, y] of [["Bauteile mit U-Wert", 60], ["Flächentabelle (SIA 416)", 130]] as const) {
    await page.locator("[data-table-add]").selectOption({ label });
    await page.getByLabel("Y [mm]").fill(String(y));
    await page.getByLabel("Y [mm]").blur();
  }
  await expect(page.locator("[data-table-id]")).toHaveCount(3);
  await expect(page.locator("[data-table-id] text", { hasText: "U [W/m²K]" })).toHaveCount(2);

  const shots = process.env.DOSSIER_SHOTS;
  if (shots) await page.locator(".layout-sheet-stage").screenshot({ path: `${shots}/blatt-tabelle.png` });

  // Zurück ins Modell, ein Fenster löschen → Tabelle hat eine Zeile weniger.
  await page.getByRole("button", { name: "Zurück zum Modell" }).click();
  await openTab(page, "Elemente");
  await elementRows(page).filter({ hasText: /Fenster/ }).first().click();
  await blurFocus(page);
  await page.keyboard.press("Delete");
  await openTab(page, "Mappe");
  await page.locator(".nav-row", { hasText: "Layout" }).first().dblclick();
  await expect(page.locator("[data-table-id]")).toHaveCount(3);
  await expect.poll(async () => (await tableMarks(page)).length).toBe(before.length - 1);

  // PDF des Ordners: der Tabellentext steht im Inhaltsstrom.
  await page.getByRole("button", { name: "Zurück zum Modell" }).click();
  await openTab(page, "Mappe");
  const pending = page.waitForEvent("download");
  await page.getByTitle("Ordner als PDF exportieren").first().click();
  const dl = await pending;
  const bytes = await readFile((await dl.path())!);
  if (shots) await writeFile(`${shots}/blatt-tabelle.pdf`, bytes);
  const text = pdfStreams(bytes);
  expect(text).toContain("(F1.01)");
  expect(text).toContain("(Räume)");
});
