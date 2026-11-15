// [263] UX-Prüfung 15.11.: Befunde, die bei 1280 × 800 sichtbar waren — unbekannter Befehl ohne Rückmeldung,
// Ansichtsleiste ohne Hinweis auf Verdecktes, Layout-Werkzeugleiste (Tabellen-Auswahl auf den Pfeil geschrumpft,
// „Einpassen“ ausserhalb), Quellen-Auswahl im Attribute-Panel auf „e ▾“ gepresst.
// Eigener Port: E2E_PORT=5193 npx playwright test e2e/uxReview263.spec.ts
import { expect, fileMenu, discardIfAsked, openTab, startNewProject, test, typeCommand } from "./app";

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

test("Raumprogramm: Name und Gruppe im 320-px-Panel lesbar, mit Tooltip", async ({ page }) => {
  await startNewProject(page);
  await fileMenu(page, /^Neu aus Vorlage: Wettbewerb$/);
  await discardIfAsked(page);
  await openTab(page, "Flächenbilanz");
  const row = page.locator(".kz-program-row:not(.kz-program-head)").first();
  await expect(row).toBeVisible();
  const name = row.locator("input").first();
  expect((await name.boundingBox())!.width, "Name über die ganze Panelbreite (vorher ≈ 40 px)").toBeGreaterThan(200);
  await expect(name).toHaveAttribute("title", /\S/);
  const group = row.locator("input[type=text]").nth(1);
  expect((await group.boundingBox())!.width, "Gruppe lesbar (vorher 64 px)").toBeGreaterThan(80);
  await expect(group).toHaveAttribute("title", /\S/);
});

test("Statusleiste bei 1280 px: Hinweistext behält Platz neben den Koordinaten", async ({ page }) => {
  await startNewProject(page);
  await fileMenu(page, /^Neu aus Vorlage: Wettbewerb$/);
  await discardIfAsked(page);
  await page.mouse.move(600, 400);
  await page.mouse.move(610, 410);
  await expect(page.locator(".sb-field", { hasText: "LV95" })).toBeVisible(); // Kataster-Koordinaten verbreitern die Leiste
  const hint = page.getByTestId("status-hint");
  expect((await hint.boundingBox())!.width, "Hinweis nicht auf „…“ geschrumpft").toBeGreaterThanOrEqual(150);
  const bar = (await page.locator(".statusbar").boundingBox())!;
  const cluster = (await page.locator(".sb-cluster").boundingBox())!;
  expect(cluster.x + cluster.width, "Wertcluster liegt in der Leiste").toBeLessThanOrEqual(bar.x + bar.width);
  expect(await page.locator(".sb-cluster").evaluate((el) => el.scrollWidth <= el.clientWidth + 1), "nichts im Cluster abgeschnitten").toBe(true);
  await expect(hint).toHaveAttribute("title", /\S/);
});

test("Ressourcen-Fenster: Reiter umbrechen statt abzuschneiden, Zeilennamen mit Tooltip", async ({ page }) => {
  await startNewProject(page);
  await page.getByRole("button", { name: "Fenster", exact: true }).first().click();
  await page.getByRole("option", { name: /Ressourcen/ }).click();
  const tabs = page.locator(".res-tabs");
  await expect(tabs).toBeVisible();
  expect(await tabs.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), "keine Reiter rechts abgeschnitten").toBe(true);
  const tabRights = await tabs.getByRole("tab").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right));
  const box = (await tabs.boundingBox())!;
  for (const r of tabRights) expect(r).toBeLessThanOrEqual(box.x + box.width);
  await expect(page.locator(".res-md-row-name").first()).toHaveAttribute("title", /\S/);
});

test("Menüs: „Perspektive“ nur einmal, Ellipsen einheitlich, Hilfe → Über dossier", async ({ page }) => {
  await startNewProject(page);
  await page.getByRole("button", { name: "Ansicht", exact: true }).click();
  await expect(page.getByRole("option", { name: "Perspektive" })).toHaveCount(1); // Blickwinkel-Preset
  await expect(page.getByRole("option", { name: "3D-Ansicht", exact: true })).toHaveCount(1); // Ansichtsart
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Datei", exact: true }).click();
  await expect(page.getByRole("option", { name: "Projekt öffnen …", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "DXF/DWG importieren …", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Hilfe", exact: true }).click();
  await page.getByRole("option", { name: "Über dossier …", exact: true }).click();
  const about = page.getByRole("dialog", { name: "Über dossier" });
  await expect(about).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(about).toBeHidden();
});

test("Verlauf und BCF (schwebende Fenster) schliessen mit Esc", async ({ page }) => {
  await startNewProject(page);
  await page.getByRole("button", { name: "Bearbeiten", exact: true }).click();
  await page.getByRole("option", { name: "Verlauf", exact: true }).click();
  const history = page.getByRole("dialog", { name: "Verlauf" });
  await expect(history).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(history).toBeHidden();
  await page.getByRole("button", { name: "Fenster", exact: true }).first().click();
  await page.getByRole("option", { name: "BCF-Themen", exact: true }).click();
  const bcf = page.getByRole("dialog", { name: "BCF-Themen" });
  await expect(bcf).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(bcf).toBeHidden();
});
