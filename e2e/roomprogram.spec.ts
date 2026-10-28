// Raumprogramm ([61]): Import aus einer Tabelle, Soll/Ist-Vergleich, „Räume generieren" auf neuem Blatt.
// Geprüft über sichtbare UI (Dialog, Tabelle, Ebenenliste). Mit DOSSIER_SHOTS=<ordner> entstehen
// zusätzlich Screenshots für die Abnahme.
import { expect, openSample, openTab, startNewProject, test } from "./app";

const CSV = [
  "Raumprogramm Testhaus;;;;",
  "Raum;Fläche [m²];Anzahl;Flächenart;Gruppe",
  "Wohnen;17,0;1;HNF;Wohnen",
  "Schlafzimmer;14,5;3;HNF;Wohnen",
  "Bad/WC;6,0;2;NNF;Nebenräume",
  "Keller;1'250,5;1;NNF;Nebenräume",
  "Total;1'320,0;;;",
].join("\n");

test("Raumprogramm importieren, vergleichen, Räume generieren", async ({ page }) => {
  await startNewProject(page);
  await openSample(page);
  await openTab(page, "Flächenbilanz");
  const shots = process.env.DOSSIER_SHOTS;

  await page.getByTestId("program-import-file").setInputFiles({ name: "programm.csv", mimeType: "text/csv", buffer: Buffer.from(CSV, "utf8") });
  const dialog = page.getByRole("dialog", { name: "Raumprogramm importieren" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("4 Zeilen werden übernommen, 1 übersprungen.")).toBeVisible();
  if (shots) await dialog.screenshot({ path: `${shots}/import-dialog.png` });
  await dialog.getByRole("button", { name: "Importieren" }).click();
  await expect(dialog).toBeHidden();

  // Soll/Ist: Wohnen ist gezeichnet (≈ 17.0 m²), der Rest fehlt.
  const table = page.locator(".pc-table");
  await expect(table).toBeVisible();
  await expect(table.getByRole("row", { name: /Schlafzimmer/ })).toContainText("0/3");
  await expect(table.locator("tr", { hasText: "Wohnen" }).first().locator(".pc-dot.green")).toBeVisible();
  await expect(table.locator("tr", { hasText: "Schlafzimmer" }).locator(".pc-dot.red")).toBeVisible();
  await expect(table.getByRole("row", { name: /Total/ })).toContainText(/1.?323/);
  if (shots) await page.locator(".pc-section").screenshot({ path: `${shots}/soll-ist.png` });

  // Räume generieren: neues Blatt, ein Undo-Schritt.
  await page.getByRole("button", { name: "Räume generieren" }).click();
  await openTab(page, "Zeichnungsebenen");
  await expect(page.getByText("Raumprogramm", { exact: true }).first()).toBeVisible();
  // Blatt aktivieren: die Statusleiste zeigt es. Undo muss danach auf eine vorhandene Ebene zurückfallen.
  const statusFloor = page.locator("footer.statusbar");
  await page.getByText("Raumprogramm", { exact: true }).first().click();
  await expect(statusFloor).toContainText("Raumprogramm");
  // Ein Undo-Schritt macht das Blatt wieder rückgängig.
  const withSheet = await page.getByText("Raumprogramm", { exact: true }).count();
  await page.keyboard.press("Control+z");
  await expect.poll(() => page.getByText("Raumprogramm", { exact: true }).count()).toBeLessThan(withSheet);
  // Die aktive Ebene fiel mit dem Blatt weg: Rückfall aufs Geschoss, keine rohe Id in der Statusleiste.
  await expect(statusFloor).toContainText("Erdgeschoss");
  await expect(statusFloor).not.toContainText(/raumprogramm|drawing-/i);
  if (shots) await page.screenshot({ path: `${shots}/generiert.png` });
});
