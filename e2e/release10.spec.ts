// [206] Referenz-Ablauf „Wettbewerb/Vorprojekt" für Release 1.0 (TODO.md, Abschnitt „Release 1.0"):
// derselbe Ablauf wie die Mac-Abnahme-Checkliste `doc/RELEASE-1.0.md`, so weit er im Browser geht.
// Ein durchgehender Test (leeres Projekt → Kataster → Baurecht → Volumen → Raumprogramm → Pläne →
// Flächen/Kennzahlen → Kostenschätzung → Abgabe-PDF → DXF/IFC), jeder Schritt ein `test.step` mit Prüfung des Ergebnisses.
// Schritte, die noch fehlen, stehen als eigene `test.fixme` mit TODO-ID unten (derzeit keine; [212] Pathtracer-Zähler läuft seit 13.11. wieder) — nicht
// weglassen, damit sichtbar bleibt, was für 1.0 fehlt. [207] [208] [211] sind seit 13.11. echte Tests (eigene `test`-Blöcke unten).
// Netzabrufe (swisstopo/geo.admin) gibt es offline nicht: Grundstück und Nachbarbauten kommen aus der
// Kataster-Fixture (`fixtures/kataster.dxf`, LV95).
// Mit DOSSIER_SHOTS=<ordner> entsteht je Schritt ein Bildschirmfoto.
import { readFile, writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { blurFocus, discardIfAsked, elementRows, expect, fileMenu, finishCommand, openTab, startNewProject, test, typeCommand } from "./app";
import { pdfStreams } from "./pdf";
import type {} from "../src/state/testHooks"; // Typ von window.__dossierTest
import { KATASTER_DXF } from "./paths";

const E0 = 2_600_000;
const N0 = 1_200_000;
/** Gebäude 12 × 10 m in der Parzelle oben rechts (38..68 × 38..68 m). */
const B = { x0: 48, y0: 46, x1: 60, y1: 56 };
const lv = (dx: number, dy: number) => `${E0 + dx},${N0 + dy}`;

const shotPath = (name: string) => `${process.env.DOSSIER_SHOTS ?? "test-results"}/${name}.png`;

async function shot(page: Page, name: string): Promise<void> {
  if (process.env.DOSSIER_SHOTS) await page.screenshot({ path: shotPath(name) });
}

/** Download auslösen und Name + Inhalt zurückgeben. */
async function download(page: Page, trigger: () => Promise<void>) {
  const pending = page.waitForEvent("download");
  await trigger();
  const dl = await pending;
  return { name: dl.suggestedFilename(), bytes: await readFile(await dl.path()) };
}

/** Seitenzahl eines PDF (Seitenobjekte `/Type /Page`, nicht `/Pages`). */
function pdfPages(bytes: Buffer): number {
  return (bytes.toString("latin1").match(/\/Type\s*\/Page(?![a-z])/g) ?? []).length;
}

/** Modellpunkt (Versatz zu E0/N0 in m) → Client-Pixel (wie `kataster.spec.ts`, f64 statt getScreenCTM). [221] Der
 *  Kataster-Import setzt den Projekt-Nullpunkt auf E0/N0 (Kilometerpunkt unter der Mitte): Modell = Versatz. */
async function screenOf(page: Page, dx: number, dy: number): Promise<{ x: number; y: number }> {
  return page.locator("svg.plan-svg").evaluate(
    (el, [x, y]) => {
      const [vx, vy, vw, vh] = el.getAttribute("viewBox")!.split(/\s+/).map(Number);
      const ox = Number(el.getAttribute("data-origin-x") ?? 0);
      const oy = Number(el.getAttribute("data-origin-y") ?? 0);
      const r = el.getBoundingClientRect();
      const s = Math.min(r.width / vw, r.height / vh);
      return {
        x: r.left + (r.width - vw * s) / 2 + (x * 90 - ox - vx) * s,
        y: r.top + (r.height - vh * s) / 2 + (-y * 90 - oy - vy) * s,
      };
    },
    [dx, dy],
  );
}

const PROGRAM_CSV = ["Raum;Fläche [m²];Anzahl;Flächenart;Gruppe", "Atelier;90,0;1;HNF;Arbeit", "Lager;12,0;1;NNF;Neben"].join("\n");

async function importKataster(page: Page): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await fileMenu(page, /DXF\/DWG importieren/);
  await (await chooser).setFiles({ name: "kataster.dxf", mimeType: "application/dxf", buffer: await readFile(KATASTER_DXF) });
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator(".imp-btn.primary").click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
}

test("Referenz-Ablauf WBW/Vorprojekt: leeres Projekt bis Abgabe", async ({ page }) => {
  test.setTimeout(300_000);
  await startNewProject(page);

  await test.step("1 Grundstück/Kontext: Kataster-DXF (LV95) importieren", async () => {
    await importKataster(page);
    await openTab(page, "Zeichnungsebenen");
    await expect(page.getByText("kataster", { exact: false }).first()).toBeVisible();
    await shot(page, "01-kataster");
  });

  await test.step("2 Baurecht: Parzelle aus Auswahl, Grenzabstand, Prüfung", async () => {
    const p = await screenOf(page, 38, 53);
    await page.mouse.click(p.x, p.y);
    await openTab(page, "Gelände");
    await page.getByRole("button", { name: "Parzelle aus Auswahl" }).click();
    await expect(page.locator(".site-rules-result")).toContainText("Parzelle 900.0 m²");
    await shot(page, "02-baurecht");
  });

  await test.step("3 Volumenstudie: Wände, Decke, Dach im EG (getippte LV95-Koordinaten)", async () => {
    await openTab(page, "Zeichnungsebenen");
    await page.getByText("Erdgeschoss", { exact: true }).first().click();
    await expect(page.locator("footer.statusbar")).toContainText("Erdgeschoss");
    await openTab(page, "Elemente");
    const before = await elementRows(page).count();
    await typeCommand(page, "wand");
    await expect(page.locator(".cmdline-prompt")).toHaveText("Startpunkt der Wand:");
    for (const [x, y] of [[B.x0, B.y0], [B.x1, B.y0], [B.x1, B.y1], [B.x0, B.y1], [B.x0, B.y0]]) await typeCommand(page, lv(x, y));
    await finishCommand(page);
    await expect.poll(() => elementRows(page).count()).toBe(before + 4);
    await typeCommand(page, "decke");
    for (const [x, y] of [[B.x0, B.y0], [B.x1, B.y0], [B.x1, B.y1], [B.x0, B.y1]]) await typeCommand(page, lv(x, y));
    await finishCommand(page);
    await expect.poll(() => elementRows(page).count()).toBe(before + 5);
    // Neue Decke mit Deckentyp des Projekts, nicht mit dem Aussenwand-Aufbau (vor [206]: „Aussenwand 34.5 cm“).
    await expect(elementRows(page).filter({ hasText: /^Geschossdecke mehrschichtig/ })).toHaveCount(1);
    await typeCommand(page, "dach");
    await expect(page.locator(".cmdline-prompt")).toHaveText(/Erste Dachecke/);
    await typeCommand(page, lv(B.x0, B.y0));
    await typeCommand(page, lv(B.x1, B.y1));
    await expect.poll(() => elementRows(page).count()).toBe(before + 6);
    await shot(page, "03-volumen");
  });

  await test.step("3b [221] LV95: Einpassen zeigt Gebäude und Kataster (nicht Nullpunkt … Landeskoordinaten)", async () => {
    await blurFocus(page);
    await page.getByTitle("Auf Plan einpassen").click();
    await page.waitForTimeout(500);
    // Sichtbarer Ausschnitt in Modell-Metern aus der viewBox des Overlays (x·90, −y·90, lokaler Ursprung).
    const view = await page.locator("svg.plan-svg").evaluate((el) => {
      const [vx, vy, vw, vh] = el.getAttribute("viewBox")!.split(/\s+/).map(Number);
      const ox = Number(el.getAttribute("data-origin-x") ?? 0);
      const oy = Number(el.getAttribute("data-origin-y") ?? 0);
      return { w: vw / 90, h: vh / 90, cx: (vx + ox + vw / 2) / 90, cy: -(vy + oy + vh / 2) / 90 };
    });
    // Kataster ≈ 80 × 80 m (vor [221]: Ausmass vom Nullpunkt bis zu den Landeskoordinaten, ≈ 2.9 Mio. m ≙ 1:10 Mio.).
    expect(Math.max(view.w, view.h)).toBeLessThan(400);
    expect(Math.abs(view.cx - 34)).toBeLessThan(60);
    expect(Math.abs(view.cy - 30)).toBeLessThan(60);
    await shot(page, "03b-einpassen");
  });

  await test.step("4 Raumprogramm gegen Modell: Raum setzen, Programm importieren, Soll/Ist", async () => {
    await typeCommand(page, "raum");
    await expect(page.locator(".cmdline-prompt")).toHaveText("Klick in Raum setzen:");
    await typeCommand(page, lv((B.x0 + B.x1) / 2, (B.y0 + B.y1) / 2));
    await blurFocus(page);
    await page.keyboard.press("Escape");
    await openTab(page, "Flächenbilanz");
    await expect(page.locator(".balance-row .balance-area").first()).toContainText("m²");
    await page.getByTestId("program-import-file").setInputFiles({ name: "programm.csv", mimeType: "text/csv", buffer: Buffer.from(PROGRAM_CSV, "utf8") });
    const dialog = page.getByRole("dialog", { name: "Raumprogramm importieren" });
    await dialog.getByRole("button", { name: "Importieren" }).click();
    await expect(dialog).toBeHidden();
    // Soll/Ist: der gezeichnete „Raum 1“ ist noch keiner Programmzeile zugeordnet — „Atelier“ fehlt.
    await expect(page.locator(".pc-table").getByRole("row", { name: /Atelier/ })).toContainText("0/1");
    await shot(page, "04-raumprogramm");
  });

  await test.step("5 Flächen/Volumen SIA 416 und Kennzahlen (GF, GV, AZ, ÜZ), Tabelle als CSV/PDF", async () => {
    const tile = (label: string) => page.locator(".kz-tile").filter({ has: page.locator(".kz-tile-label", { hasText: new RegExp(`^${label}$`) }) }).locator(".kz-tile-value");
    await expect(tile("GF")).toHaveText(/^1\d\d\.\d m²$/);
    // GV aus Wänden/Decken ≈ GF × Geschosshöhe (vor [206] stand hier 0 m³).
    await expect(tile("GV")).toHaveText(/^\d{3} m³$/);
    await expect(tile("AZ")).toHaveText(/^0\.\d\d$/);
    await expect(tile("ÜZ")).toHaveText(/^0\.\d\d$/);
    const areas = page.locator(".area-section").filter({ hasText: "Flächen- und Kennzahlen-Nachweis" });
    const table = areas.locator(".area-table").first();
    await expect(table).toContainText("Erdgeschoss");
    // [225] Leiste und Tabelle zeigen dieselbe GF (SIA 416: NGF + KF), nicht die Leiste nur die Räume.
    const gfCol = (await table.locator("thead th").allTextContents()).indexOf("GF");
    expect(gfCol).toBeGreaterThan(0);
    const gfTable = Number((await table.locator("tbody tr.total td").nth(gfCol).textContent())!.trim());
    const gfTile = Number((await tile("GF").textContent())!.replace(/[^\d.]/g, ""));
    expect(gfTable).toBeGreaterThan(120);
    expect(Math.abs(gfTile - gfTable)).toBeLessThan(0.06);
    const csv = await download(page, () => areas.locator(".balance-export", { hasText: "CSV" }).click());
    expect(csv.name).toMatch(/\.csv$/);
    expect(csv.bytes.toString("utf8")).toMatch(/GF/);
    const pdf = await download(page, () => areas.locator(".balance-export", { hasText: "PDF" }).click());
    expect(pdf.bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    await areas.screenshot({ path: shotPath("05-flaechen") }).catch(() => undefined);
  });

  await test.step("5b Kostenschätzung grob: Kennwerte je m³ GV (eBKP-H), Total inkl. MwSt, CSV/PDF", async () => {
    const cost = page.getByTestId("cost-section");
    await cost.scrollIntoViewIfNeeded();
    // Ohne eigene Werte: Beispielwerte, deutlich als solche markiert.
    await expect(cost).toContainText("Beispielwerte, bitte anpassen");
    await expect(cost.getByTestId("cost-rate-C")).toHaveValue("192");
    const gross = cost.getByTestId("cost-gross");
    await expect(gross).toContainText(/\d'\d{3}/);
    await expect(cost.getByTestId("cost-range")).toContainText("±15 %");
    const before = await gross.textContent();
    // Kennwert C ändern: das Total folgt.
    await cost.getByTestId("cost-rate-C").fill("250");
    await cost.getByTestId("cost-rate-C").press("Enter");
    await expect(gross).not.toHaveText(before ?? "");
    const csv = await download(page, () => cost.getByTestId("cost-export-csv").click());
    expect(csv.name).toMatch(/kosten\.csv$/);
    const text = csv.bytes.toString("utf8");
    expect(text).toContain("Konstruktion Gebäude");
    expect(text).toMatch(/Total inkl\. MwSt\./);
    expect(text).toMatch(/;250;/);
    const pdf = await download(page, () => cost.getByTestId("cost-export-pdf").click());
    expect(pdf.bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    // Methode m² GF: Beispielwerte der Methode, eigene Werte umgerechnet.
    await cost.getByTestId("cost-method").selectOption("gf");
    await expect(cost.getByTestId("cost-rate-B")).toHaveValue("50");
    if (process.env.DOSSIER_SHOTS) {
      // Panel hoch genug, damit die ganze Kostenschätzung aufs Bild passt.
      await page.setViewportSize({ width: 1600, height: 2600 });
      await cost.scrollIntoViewIfNeeded();
      await cost.screenshot({ path: shotPath("05b-kosten") }).catch(() => undefined);
      await page.setViewportSize({ width: 1600, height: 1200 });
    }
  });

  await test.step("6 Baurecht gegen Modell: Gebäude in der zulässigen Fläche, Höhe geprüft", async () => {
    await openTab(page, "Gelände");
    await expect(page.locator(".site-rules-result")).toContainText("Gebäude innerhalb der zulässigen Fläche");
    const maxH = page.locator(".site-rules label, .site-rules div").filter({ hasText: /^Gesamthöhe max\./ }).locator("input").first();
    await maxH.fill("12");
    await maxH.press("Enter");
    await expect(page.locator(".site-rules-result")).toContainText(/Höhe [\d.]+ m ≤ 12/);
    await shot(page, "06-baurecht-pruefung");
  });

  await test.step("7 Grundriss 1:200 (Wettbewerb) bzw. 1:100 (Vorprojekt)", async () => {
    await page.getByTitle("Papier-Massstab 1:N anwenden").click();
    await page.getByRole("option", { name: "1:200", exact: true }).click();
    await expect(page.getByTitle("Papier-Massstab 1:N anwenden")).toContainText("1:200");
    await shot(page, "07-grundriss-200");
  });

  await test.step("8 Schnitt durch das Volumen: Schnittlinie (getippt) legt „Schnitt B“ an", async () => {
    const my = (B.y0 + B.y1) / 2;
    await typeCommand(page, "sectionline");
    await expect(page.locator(".cmdline-prompt")).toHaveText("Schnitt-Startpunkt:");
    await typeCommand(page, lv(B.x0 - 4, my));
    await typeCommand(page, lv(B.x1 + 4, my));
    await finishCommand(page);
    await openTab(page, "Zeichnungsebenen");
    await page.getByText("Schnitt B", { exact: true }).first().click();
    await expect(page.locator("footer.statusbar")).toContainText("Schnitt B");
    await expect(page.locator("svg.plan-svg").first()).toBeVisible({ timeout: 30_000 });
    await shot(page, "08-schnitt");
  });

  await test.step("9 3D: Axonometrie, Schatten im 3D", async () => {
    await page.getByRole("button", { name: "Axonometrie", exact: true }).click();
    await expect(page.getByText(/^Perspektive · /)).toBeVisible({ timeout: 30_000 });
    await openTab(page, "Gelände");
    await page.getByLabel("Schatten im 3D zeigen").check();
    await expect(page.getByLabel("Schatten im 3D zeigen")).toBeChecked();
    await shot(page, "09-3d");
    await page.getByRole("button", { name: "Grundriss", exact: true }).click();
  });

  let sheetName = "";
  await test.step("10 Abgabe-Layout: Präsentationsplan (Grundrisse, Ansichten, Schnitt B) auf A1", async () => {
    await openTab(page, "Mappe");
    await page.locator("[data-testid=presentation-open]").click();
    const dialog = page.getByRole("dialog", { name: "Präsentationsplan" });
    await expect(dialog).toBeVisible();
    await dialog.locator("[data-testid=presentation-section]").selectOption({ label: "Schnitt B" });
    await dialog.locator("[data-testid=presentation-paper]").selectOption("a1");
    await dialog.locator("[data-testid=presentation-create]").click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => page.locator("[data-viewport-id]").count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
    sheetName = "Präsentationsplan";
    await page.waitForTimeout(1500);
    await shot(page, "10-praesentationsplan");
  });

  await test.step("10b Kostenschätzung als Layout-Element (Blatt-Tabelle eBKP-H)", async () => {
    await page.locator("[data-table-add]").selectOption({ label: "Kostenschätzung grob (eBKP-H)" });
    await expect(page.locator("[data-table-id] text", { hasText: /^Total inkl\. MwSt\./ })).toHaveCount(1);
    await expect(page.locator("[data-table-id] text", { hasText: "Konstruktion Gebäude" })).toHaveCount(1);
    await page.waitForTimeout(500);
    if (process.env.DOSSIER_SHOTS) {
      await page.locator(".layout-sheet-stage").screenshot({ path: shotPath("10b-kosten-blatt") }).catch(() => undefined);
      // Tabelle allein als SVG (auf dem Übersichtsbild ist der Text zu klein zum Prüfen).
      const svg = await page.locator("[data-table-id]").first().evaluate((g) => {
        const b = (g as SVGGraphicsElement).getBBox();
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.x - 2} ${b.y - 2} ${b.width + 4} ${b.height + 4}" width="${(b.width + 4) * 8}" height="${(b.height + 4) * 8}" style="background:#fff">${g.outerHTML}</svg>`;
      });
      await writeFile(`${process.env.DOSSIER_SHOTS}/10b-kosten-tabelle.svg`, svg);
    }
  });

  await test.step("11 Abgabe als PDF: Publikationssatz mit dem Blatt → PDF-Datei", async () => {
    await openTab(page, "Mappe");
    await page.locator("[data-publish-add]").click();
    const editor = page.locator("[data-publish-editor]");
    await expect(editor).toBeVisible();
    await editor.getByTestId("publish-sheet-row").filter({ hasText: sheetName }).first().locator("input[type=checkbox]").check();
    const pdf = await download(page, () => page.locator("[data-publish-run]").first().click());
    expect(pdf.name).toMatch(/\.pdf$/);
    expect(pdf.bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdfPages(pdf.bytes)).toBeGreaterThanOrEqual(1);
    if (process.env.DOSSIER_SHOTS) await writeFile(`${process.env.DOSSIER_SHOTS}/11-abgabe.pdf`, pdf.bytes);
    await shot(page, "11-publikation");
  });

  await test.step("12 Fachplaner-Austausch: DXF (Grundriss EG) und IFC", async () => {
    await page.getByRole("button", { name: /Zurück zum Modell/ }).click();
    await openTab(page, "Zeichnungsebenen");
    await page.getByText("Erdgeschoss", { exact: true }).first().click();
    await expect(page.locator("footer.statusbar")).toContainText("Erdgeschoss");
    await fileMenu(page, "Exportieren: DXF");
    const dxfDialog = page.getByRole("dialog");
    const dxf = await download(page, () => dxfDialog.locator(".imp-btn.primary").click());
    expect(dxf.name).toBe("Leeres Projekt-Erdgeschoss.dxf");
    expect(dxf.bytes.toString("utf8")).toMatch(/ENTITIES/);
    await fileMenu(page, "Exportieren: IFC");
    const ifcDialog = page.getByRole("dialog", { name: "Exportieren" });
    const ifc = await download(page, () => ifcDialog.getByRole("button", { name: "Exportieren", exact: true }).click());
    const text = ifc.bytes.toString("utf8");
    expect(text.startsWith("ISO-10303-21;")).toBe(true);
    expect(text).toMatch(/IFCWALL/);
    expect(text).toMatch(/IFCSLAB/);
    expect(text).toMatch(/IFCSPACE/);
  });

  await test.step("13 Speichern: .obp mit Volumen, Raum, Baurecht und Raumprogramm", async () => {
    const saved = await download(page, () => fileMenu(page, "Projekt speichern"));
    const j = JSON.parse(saved.bytes.toString("utf8"));
    expect(j.walls).toHaveLength(4);
    expect(j.ceilings).toHaveLength(1);
    expect(j.ceilings[0].ceilingTypeId).toBeTruthy();
    expect(j.roofs).toHaveLength(1);
    expect(j.rooms).toHaveLength(1);
    expect(j.siteRules.parcel).toHaveLength(4);
    expect(j.siteRules.maxHeight).toBe(12);
    expect(j.roomProgram).toHaveLength(2);
    // [221] Projekt-Nullpunkt aus dem Kataster: Modell lokal, Landeskoordinaten im Standort-Bezug.
    expect(j.geoAnchor.lv95).toEqual({ e: E0, n: N0 });
    expect(j.walls[0].start).toEqual({ x: B.x0, y: B.y0 });
    // Schnitt A folgt dem Gebäude (quer durch die Mitte), die Ansicht Süd liegt davor.
    const line = (name: string) => j.drawingLevels.find((l: { name: string }) => l.name === name).linePoints as { x: number; y: number }[];
    const sa = line("Schnitt A");
    expect(sa[0].y).toBeGreaterThan(B.y0);
    expect(sa[0].y).toBeLessThan(B.y1);
    expect(Math.min(sa[0].x, sa[1].x)).toBeLessThan(B.x0);
    expect(Math.max(sa[0].x, sa[1].x)).toBeGreaterThan(B.x1);
    expect(line("Ansicht Süd")[0].y).toBeLessThan(B.y0);
    expect(j.layouts.length).toBeGreaterThanOrEqual(1);
    expect(j.costEstimate.method).toBe("gf");
    expect(j.costEstimate.groups).toHaveLength(9);
    if (process.env.DOSSIER_SHOTS) await writeFile(`${process.env.DOSSIER_SHOTS}/release10.obp`, saved.bytes);
  });
});

// ── Was für 1.0 noch fehlt (je ein Test, bis der Schritt geht; Reproduktion in TODO.md) ──────────────────────

// [222] Quader-Körper (Befehl „Körper“) 12 × 10 × 8 m im EG, dann „Körper in Bauteile umwandeln“ per Klick (getippter
// Punkt): Aussenwände je Geschoss, Decken, Flachdach, fehlende Geschosse obenauf; Strg+Z nimmt alles in einem Schritt zurück.
test("[222] Volumenstudie: Wände/Decken/Dach aus einem Volumen (Körper) erzeugen", async ({ page }) => {
  await startNewProject(page);
  await openTab(page, "Zeichnungsebenen");
  await page.getByText("Erdgeschoss", { exact: true }).first().click();
  const floors = page.getByText(/^Geschoss \d+$/);
  const floorsBefore = await floors.count();
  await typeCommand(page, "koerper");
  await typeCommand(page, "cuboid");
  await expect(page.locator(".cmdline-prompt")).toHaveText("Mittelpunkt bzw. erste Ecke:");
  await typeCommand(page, "0,0");
  await typeCommand(page, "12,10");
  await typeCommand(page, "8");
  await expect(page.locator(".cmdline-prompt")).toHaveText("Befehl:");
  await typeCommand(page, "koerperinbauteile");
  await expect(page.locator(".cmdline-prompt")).toHaveText("Körper wählen (Massenmodell):");
  await typeCommand(page, "6,5");
  const done = page.locator(".toast-message").filter({ hasText: /Geschosse \(\d+ neu\): \d+ Aussenwände, \d+ Decken und Flachdach erzeugt/ });
  await expect(done).toBeVisible();
  const [, stories, fresh, walls, ceilings] = (await done.first().innerText()).match(/(\d+) Geschosse \((\d+) neu\): (\d+) Aussenwände, (\d+) Decken/)!.map(Number);
  expect(stories).toBeGreaterThanOrEqual(2);
  expect(walls).toBe(4 * stories);
  expect(ceilings).toBe(stories - 1);
  await expect(floors).toHaveCount(floorsBefore + fresh);
  await shot(page, "222-bauteile");
  // Ein Undo-Schritt: neue Geschosse wieder weg.
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(floors).toHaveCount(floorsBefore);
});

/** Ressourcen → Ansichtsvorlagen: Vorlage `name` wählen und einmal auf die aktive Ansicht anwenden. */
async function applyViewTemplate(page: Page, name: RegExp): Promise<void> {
  await page.getByRole("button", { name: "Fenster", exact: true }).first().click();
  await page.getByRole("option", { name: /Ressourcen/ }).click();
  await page.getByRole("tab", { name: "Ansichtsvorlagen" }).click();
  await page.getByTestId("view-template-row").filter({ hasText: name }).first().click();
  await page.getByTestId("view-template-apply-once").click();
  await page.locator(".res-window").getByRole("button", { name: "Schließen" }).first().click();
}

const templateFills = (page: Page, id: string) => page.evaluate((i) => window.__dossierTest!.templateFills(i), id);

// [207] Ansichtsvorlage „Situation WBW": eigenes Gebäude schwarz gefüllt, Kontext grau; Kataster-Gebäude aus dem DXF-Import gefüllt.
// Geprüft über die Plan-Primitive des Kerns (Füllfarbe), nicht über Pixel.
test("[207] Situation 1:500 / Schwarzplan als Ansichtsvorlage „Situation WBW“", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/?dossierTest"); // Test-Naht `__dossierTest.templateFills`
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();

  await test.step("Kataster-DXF: Gebäude des Imports sind mit der Vorlage gefüllt", async () => {
    await importKataster(page);
    await expect(page.locator("footer.statusbar")).toBeVisible();
    await applyViewTemplate(page, /Situation WBW/);
    const fills = await templateFills(page, "std-vt-situation-wbw");
    // Die HATCH-Gebäude des Katasters (Zeichnungen `dxf2d-…`) bleiben gefüllt.
    expect(fills.filter((f) => f.ids.some((i) => i.startsWith("drawingId=dxf2d-"))).length, JSON.stringify(fills.slice(0, 6))).toBeGreaterThanOrEqual(1);
  });

  await test.step("Musterhaus komplex: eigenes Gebäude schwarz, Nachbarn grau, keine Bauteile", async () => {
    await fileMenu(page, /Musterhaus \(komplex\)/);
    await discardIfAsked(page);
    await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });
    await applyViewTemplate(page, /Situation WBW/);
    const fills = await templateFills(page, "std-vt-situation-wbw");
    expect(fills.filter((f) => f.fill === "#000000").length).toBeGreaterThanOrEqual(1);
    expect(fills.filter((f) => f.fill === "#b8b8b8").length).toBe(5);
    expect(fills.some((f) => f.ids.some((i) => i.startsWith("wallId")))).toBe(false);
    // Schwarzplan: alles schwarz.
    const sw = await templateFills(page, "std-vt-schwarzplan");
    expect(sw.filter((f) => f.fill === "#b8b8b8").length).toBe(0);
    expect(sw.filter((f) => f.fill === "#000000").length).toBeGreaterThan(5);
  });
});

// [223] Headless liefert WebGPU kein Bild: `__dossierImageMock` (cameraBridge.captureImage) ersetzt das Offscreen-Zeichnen;
// geprüft werden Dialog, Zielgrösse, Optionen, Ergebnis und Einsetzen ins Layout — nicht die Pixel.
test("[223] 3D-Bild für die Abgabe: Auflösung wählen, exportieren, ins Layout einsetzen", async ({ page }) => {
  test.setTimeout(120_000);
  await startNewProject(page);
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });
  await page.evaluate(() => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    (globalThis as { __dossierImageMock?: unknown }).__dossierImageMock = async (o: { width: number; height: number; transparent: boolean }) => ({ png, width: o.width, height: o.height, transparent: o.transparent });
  });
  await typeCommand(page, "bild3d");
  const dialog = page.getByTestId("image3d-dialog");
  await expect(dialog).toBeVisible();
  // A3 bei 300 dpi.
  await dialog.getByTestId("image3d-size").selectOption("a3");
  await expect(dialog.getByTestId("image3d-width")).toHaveValue("4961");
  await expect(dialog.getByTestId("image3d-height")).toHaveValue("3508");
  await dialog.getByTestId("image3d-size").selectOption("uhd");
  await expect(dialog.getByTestId("image3d-width")).toHaveValue("3840");
  await dialog.getByTestId("image3d-transparent").check();
  await dialog.getByTestId("image3d-start").click();
  await expect(dialog.getByTestId("image3d-result")).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByTestId("image3d-save")).toBeVisible();
  const toLayout = dialog.getByTestId("image3d-to-layout");
  if (await toLayout.isEnabled()) {
    await toLayout.click();
    await expect(page.getByText(/eingesetzt|Layout/).first()).toBeVisible();
  }
});

// [211] Rendering mit Blender/Cycles: im Browser gibt es kein Blender (Host `null`), der Dialog bietet nur das Export-Paket
// (ZIP mit `model.glb`, `scene.json`, `textures/`, Anleitung). Geprüft: Dialog, Kamera/Sonne, ZIP-Inhalt. Der Lauf mit
// Blender/Cycles selbst (Fortschritt, Bild, „Als .blend") ist nur auf dem Mac prüfbar (Checkliste `doc/RELEASE-1.0.md`).
test("[211] Rendering-Dialog im Browser erzeugt das Export-Paket (model.glb + scene.json)", async ({ page }) => {
  test.setTimeout(180_000);
  await startNewProject(page);
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });
  await typeCommand(page, "rendering");
  const dialog = page.getByRole("dialog", { name: "Rendering mit Blender" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("render-camera")).toBeVisible();
  await expect(dialog.getByTestId("render-sun")).toBeVisible();
  // Ohne Blender: kein Start-Knopf, nur das Paket.
  await expect(dialog.getByTestId("render-start")).toHaveCount(0);
  const zip = await download(page, () => dialog.getByTestId("render-zip").click());
  expect(zip.name).toMatch(/-render\.zip$/);
  expect(zip.bytes.subarray(0, 2).toString("latin1")).toBe("PK");
  // Dateinamen stehen unkomprimiert im lokalen ZIP-Kopf bzw. Zentralverzeichnis.
  const names = zip.bytes.toString("latin1");
  expect(names).toContain("model.glb");
  expect(names).toContain("scene.json");
});

// [212] Pathtracing-Stil der 3D-Ansicht: Zähler „Pathtracing: N Samples" zählt hoch. Das Canvas-Bild ist headless nicht lesbar —
// geprüft werden nur Zähler und Konsole (Fixture meldet unerwartete Fehler).
// Bis 13.11. brach der Stil im Playwright-Chromium (WebGPU über SwiftShader) beim ersten Bild mit einem Panic in wgpu
// `create_buffer` ab (Puffer mit `mappedAtCreation`, webgpu.rs:2331). Seit [212] Etappe 5 legt der Pathtracer seine Puffer ohne
// `mappedAtCreation` an und prüft sie gegen die Gerätegrenzen (zu gross: Hinweis statt Absturz) — der Test läuft wieder immer.
// Auf dem Mac (Metal) wird der Stil von Hand geprüft (`doc/RELEASE-1.0.md`, 13.1).
const pathtraceTest = test;
pathtraceTest("[212] Pathtracer-Stil: Sample-Zähler zählt hoch", async ({ page }) => {
  test.setTimeout(180_000);
  await startNewProject(page);
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });
  await page.getByRole("button", { name: "Axonometrie", exact: true }).click();
  await page.getByRole("button", { name: "Darstellungsart der aktiven Ansicht" }).click();
  await page.getByRole("option", { name: /Pathtracing/ }).click();
  const status = page.getByTestId("pathtrace-status");
  await expect(status).toBeVisible({ timeout: 30_000 });
  const samples = async () => Number((await status.innerText()).match(/(\d+) Samples/)?.[1] ?? 0);
  await expect.poll(samples, { timeout: 60_000 }).toBeGreaterThan(0);
  const first = await samples();
  await expect.poll(samples, { timeout: 60_000 }).toBeGreaterThan(first);
});


test("[224] Präsentationsplan: leere Geschosse nicht vorgewählt, Massstab 1:200, Plakat als Ziel", async ({ page }) => {
  test.setTimeout(120_000);
  await startNewProject(page);
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });
  await typeCommand(page, "praesentation");
  const dialog = page.getByRole("dialog", { name: "Präsentationsplan" });
  await expect(dialog).toBeVisible();
  // Vorgabe 1:200, Plakat-Vorlage wählbar, nur vorhandene Ansichten.
  await expect(dialog.getByTestId("presentation-scale")).toHaveValue("200");
  expect(await dialog.getByTestId("presentation-target").locator("option").count()).toBeGreaterThan(1);
  // Leere Geschosse (Markierung „leer“) sind nicht vorgewählt.
  const floors = dialog.locator("input[data-floor]");
  for (let i = 0; i < (await floors.count()); i++) {
    const label = floors.nth(i).locator("xpath=..");
    const isEmpty = /leer/i.test((await label.textContent()) ?? "");
    if (isEmpty) await expect(floors.nth(i)).not.toBeChecked();
  }
  await dialog.getByTestId("presentation-create").click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("[data-viewport-id]").first()).toBeVisible({ timeout: 20_000 });
});

// [208] Wettbewerbs-Plakat im Referenz-Ablauf, schlank (Bild, Zuschnitt, Raster: `competition.spec.ts`): Plakat A1 aus der
// Vorlage, Kennwort setzen, PDF des WBW-Satzes — ohne Projektname in Titel, Inhalt und Dateiname.
test("[208] Wettbewerbs-Plakat A1 mit Kennwort, anonymes PDF ohne Projektnamen", async ({ page }) => {
  test.setTimeout(120_000);
  await startNewProject(page);
  const projectName = (await page.locator(".project-name").innerText()).trim();
  expect(projectName.length).toBeGreaterThan(2);
  await openTab(page, "Mappe");
  await page.getByRole("button", { name: "Layout erstellen" }).first().click();
  await page.locator("[data-testid=newlayout-poster]").check();
  await expect(page.locator("[data-testid=newlayout-poster-select]")).toHaveValue("poster-a1-landscape");
  await page.getByRole("button", { name: "Erstellen", exact: true }).click();
  await page.keyboard.press("Enter");
  await page.locator(".nav-row", { hasText: "Layout" }).first().dblclick();
  await expect(page.locator("[data-poster-header]")).toBeAttached();

  await page.locator("[data-testid=publish-add-wbw]").click();
  const run = () => download(page, () => page.locator("[data-publish-set] [data-publish-run]").first().click());
  // Gegenprobe: nicht anonym trägt das PDF den Projektnamen im Titel.
  const open = await run();
  expect(pdfStreams(open.bytes) + open.bytes.toString("latin1")).toContain(projectName);

  await page.locator("[data-testid=competition-anonymous]").check();
  await page.locator("[data-testid=competition-keyword]").fill("FALKE 7");
  const anon = await run();
  expect(anon.name).toBe("FALKE 7_WBW-Abgabe.pdf");
  const raw = anon.bytes.toString("latin1");
  const all = raw + pdfStreams(anon.bytes);
  expect(raw.slice(0, 5)).toBe("%PDF-");
  expect(raw).toMatch(/\/MediaBox \[0 0 2383\.93\d* 1683\.7\d*/); // A1 quer
  expect(raw).toContain("/Title (FALKE 7)");
  expect(all).toContain("(FALKE 7)");
  expect(all).not.toContain(projectName);
  expect(anon.name).not.toContain(projectName);
});
