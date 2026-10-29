// Fenster- und Türliste ([97]) im Flächenbilanz-Panel: Zeilen je Öffnung, Nummer und Kennwerte editieren.
// Mit DOSSIER_SHOTS=<ordner> entsteht zusätzlich ein Screenshot für die Abnahme.
import { expect, openSample, openTab, startNewProject, test } from "./app";

test("Fenster- und Türliste: Zeilen, Nummer und Brandschutz eintragen", async ({ page }) => {
  await startNewProject(page);
  await openSample(page);
  await openTab(page, "Flächenbilanz");
  const table = page.locator(".opening-table");
  await expect(table).toBeVisible();
  const rows = table.locator("tbody tr");
  expect(await rows.count()).toBeGreaterThan(1);
  // Automatische Nummern stehen als Platzhalter, das Feld selbst ist leer.
  const first = rows.first().locator(".opening-mark");
  await expect(first).toHaveAttribute("placeholder", /^F1\.01$/);
  await first.fill("F-Süd");
  await expect(rows.first().locator(".opening-mark")).toHaveValue("F-Süd");
  const door = table.locator("tbody tr", { hasText: "Tür" }).first();
  await door.locator("td").nth(9).locator("input").fill("EI30");
  await expect(door.locator("td").nth(9).locator("input")).toHaveValue("EI30");
  const shots = process.env.DOSSIER_SHOTS;
  if (shots) await page.locator(".opening-section").screenshot({ path: `${shots}/fenster-tuerliste.png` });
});
