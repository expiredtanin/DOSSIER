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

// Ansichtsleiste: Überlauf-Menü „⋯“ statt verstecktem Scrollen. Jede Gruppe steht in der Leiste ODER im Menü.
const RIBBON_GROUPS = ["Ansicht", "Ebenenkombinationen", "Detailgrad", "Massstab und Zoom"];
async function openMoreIfAny(page: import("@playwright/test").Page) {
  const more = page.getByTestId("ribbon-more");
  if (await more.count()) {
    await more.click();
    await expect(page.getByTestId("ribbon-more-panel")).toBeVisible();
    return true;
  }
  return false;
}

for (const [w, h] of [
  [1280, 800],
  [1440, 900],
] as const) {
  test(`Ansichtsleiste bei ${w} px: alles erreichbar, kein horizontaler Überlauf`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await startNewProject(page);
    const ribbon = page.locator(".ribbon-views");
    const sizes = await ribbon.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
    expect(sizes.sw, "kein verstecktes Scrollen").toBeLessThanOrEqual(sizes.cw);
    // Massstab und Zoom bleiben in der Leiste.
    await expect(ribbon.locator(".tb-zoomcluster")).toBeVisible();
    const hasMore = await openMoreIfAny(page);
    for (const name of RIBBON_GROUPS) {
      const g = page.locator(`.ribbon-views [aria-label="${name}"], .rv-more-panel [aria-label="${name}"]`).first();
      await expect(g, `Gruppe „${name}“ erreichbar`).toBeVisible();
    }
    // Die Leiste zeigt „⋯“ mit Tooltip.
    if (hasMore) await expect(page.getByTestId("ribbon-more")).toHaveAttribute("title", "Weitere Einstellungen");
    // Nichts ragt rechts aus dem Fenster.
    const right = await ribbon.evaluate((el) => Math.max(...Array.from(el.children).map((c) => c.getBoundingClientRect().right)));
    expect(right).toBeLessThanOrEqual(w);
  });
}

test("Ansichtsleiste: bei 1920 px nur die Schrift im „⋯“, ab 2560 px keins", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await startNewProject(page);
  const ribbon = page.locator(".ribbon-views");
  expect(await ribbon.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.getByTestId("ribbon-more").click();
  // Die Schriftgruppe (ca. 710 px) ist die unwichtigste; alles andere passt noch in die Leiste.
  expect(await page.locator(".rv-more-panel [data-slot]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.slot))).toEqual(["text"]);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 2560, height: 1080 });
  await expect(page.getByTestId("ribbon-more")).toHaveCount(0);
});

test("Ansichtsleiste: Überlauf-Menü per Tastatur, Massstab-Wechsel über das Menü", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await startNewProject(page);
  const more = page.getByTestId("ribbon-more");
  await expect(more).toBeVisible();
  await more.focus();
  await page.keyboard.press("Enter");
  const panel = page.getByTestId("ribbon-more-panel");
  await expect(panel).toBeVisible();
  // Esc schliesst und gibt den Fokus zurück.
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(more).toBeFocused();
  await page.keyboard.press(" ");
  await expect(panel).toBeVisible();
  // Pfeil nach unten wandert durch die Bedienelemente des Menüs.
  const first = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80));
  await page.keyboard.press("ArrowDown");
  expect(await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80))).not.toBe(first);
  await page.keyboard.press("Escape");
  // Fenster breiter: Gruppen kehren in die Leiste zurück (ResizeObserver).
  await page.setViewportSize({ width: 2560, height: 800 });
  await expect(more).toHaveCount(0);
  // Sehr schmal: Massstab-Wechsel funktioniert, auch wenn der Massstab im Menü steht.
  await page.setViewportSize({ width: 520, height: 800 });
  await expect(more).toBeVisible();
  await more.click();
  const scaleDd = page.getByTitle("Papier-Massstab 1:N anwenden");
  const inMenu = await panel.getByTitle("Papier-Massstab 1:N anwenden").count();
  if (!inMenu) await page.keyboard.press("Escape"); // Massstab noch in der Leiste
  await scaleDd.click();
  await page.getByRole("option", { name: "1:200", exact: true }).click();
  await expect(scaleDd).toContainText("1:200");
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
