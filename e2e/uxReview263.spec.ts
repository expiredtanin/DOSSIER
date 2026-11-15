// [263] UX-Prüfung 15.11.: Befunde, die bei 1280 × 800 sichtbar waren — unbekannter Befehl ohne Rückmeldung,
// Ansichtsleiste ohne Hinweis auf Verdecktes, Layout-Werkzeugleiste (Tabellen-Auswahl auf den Pfeil geschrumpft,
// „Einpassen“ ausserhalb), Quellen-Auswahl im Attribute-Panel auf „e ▾“ gepresst.
// Eigener Port: E2E_PORT=5193 npx playwright test e2e/uxReview263.spec.ts
import { expect, fileMenu, discardIfAsked, startNewProject, test, typeCommand } from "./app";

test.use({ viewport: { width: 1280, height: 800 } });

test("unbekannter Befehl meldet sich statt still zu verpuffen", async ({ page }) => {
  await startNewProject(page);
  await typeCommand(page, "xyzabc");
  await expect(page.getByText(/Unbekannter Befehl „xyzabc“/)).toBeVisible();
  // Bekannte Befehle melden nichts Derartiges.
  await typeCommand(page, "w");
  await expect(page.locator(".cmdline-prompt")).toHaveText("Startpunkt der Wand:");
});

test("Ansichtsleiste zeigt bei 1280 px, dass rechts noch Bedienelemente liegen", async ({ page }) => {
  await startNewProject(page);
  const ribbon = page.locator(".ribbon-views");
  const overflows = await ribbon.evaluate((el) => el.scrollWidth > el.clientWidth + 2);
  expect(overflows, "bei 1280 px passt die Leiste nicht ganz hinein").toBe(true);
  await expect(ribbon).toHaveClass(/has-more/);
  // Ganz nach rechts gescrollt: kein Hinweis mehr.
  await ribbon.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  await expect(ribbon).not.toHaveClass(/has-more/);
});

test("Layout-Werkzeugleiste: Tabellen-Auswahl lesbar, „Einpassen“ im Fenster", async ({ page }) => {
  await startNewProject(page);
  await fileMenu(page, /^Neu aus Vorlage: Wettbewerb$/);
  await discardIfAsked(page);
  await page.getByRole("tab", { name: "Mappe", exact: true }).click();
  await page.getByText("Präsentationsplan", { exact: true }).first().click();
  const bar = page.locator(".layout-sheet-toolbar");
  await expect(bar).toBeVisible();
  const select = bar.locator("select[data-table-add]");
  expect((await select.boundingBox())!.width, "Tabellen-Auswahl nicht auf den Pfeil geschrumpft").toBeGreaterThan(80);
  const fit = bar.getByRole("button", { name: "Einpassen" });
  const box = (await fit.boundingBox())!;
  expect(box.x + box.width, "Einpassen liegt im Fenster").toBeLessThanOrEqual(1280);
});

test("Attribute-Panel: Quellen-Auswahl neben der Strichstärke ist lesbar", async ({ page }) => {
  await startNewProject(page);
  await fileMenu(page, /^Neu aus Vorlage: Wettbewerb$/);
  await discardIfAsked(page);
  // Parzellengrenze (2D-Objekt) anklicken: Attribute-Panel zeigt Stift mit Zahlenfeld + Quellen-Auswahl.
  await page.mouse.click(400, 430);
  const trigger = page.locator(".attr-val > .attr-num ~ .tb-dd-trigger").first();
  await expect(trigger).toBeVisible();
  expect((await trigger.boundingBox())!.width).toBeGreaterThanOrEqual(80);
});
