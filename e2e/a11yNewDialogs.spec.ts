// [249] Tastatur und Fokus in den neuen Dialogen und Leisten (13.11.): Kürzel-Übersicht, Kamerafahrt-Dialog, 3D-Bild,
// Rendering, Hilfslinien-Panel, Bild-HUD (Zuschnitt), 3D-Werkzeugleiste, Dropdown mit Gruppen, einklappbare
// Objekt-Info-Gruppen. Je Dialog: Fokus beim Öffnen im Dialog, Tab bleibt darin, Hintergrund-Kürzel (Entf, T, W) gehen
// nicht durch, Esc schliesst, der Fokus kehrt zum Auslöser zurück. Mit A11Y_SHOT_DIR=<ordner> entstehen Screenshots der
// Fokusringe (hell/dunkel). Eigener Port: E2E_PORT=5197 npx playwright test e2e/a11yNewDialogs.spec.ts
import { mkdir } from "node:fs/promises";
import type { Locator, Page } from "@playwright/test";
import type {} from "../src/state/testHooks"; // Typ von window.__dossierTest
import { testPng } from "./pdf";
import { blurFocus, discardIfAsked, expect, fileMenu, openSample, openTab, showSnapshot, startNewProject, test, typeCommand } from "./app";

const SHOTS = process.env.A11Y_SHOT_DIR;

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** Liegt der Fokus im Element? */
const focusInside = (el: Locator) => el.evaluate((n) => n.contains(document.activeElement));

/** Tab/Umschalt+Tab mehrfach: der Fokus verlässt den Dialog nie (Fokus-Falle). */
async function expectTrapped(page: Page, dlg: Locator, rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await page.keyboard.press("Tab");
    expect(await focusInside(dlg), `Tab ${i + 1}`).toBe(true);
  }
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Shift+Tab");
    expect(await focusInside(dlg), `Umschalt+Tab ${i + 1}`).toBe(true);
  }
}

/** Entf, T, W, S, Strg+Z bei Fokus auf einem Knopf im Dialog: die Auswahl/das Modell dahinter bleibt, kein Begehen. */
async function expectNoBackgroundShortcuts(page: Page, dlg: Locator): Promise<void> {
  const before = await page.evaluate(() => window.__dossierTest!.counts());
  await dlg.locator("button").last().focus();
  for (const k of ["Delete", "Backspace", "t", "w", "a", "s", "d", "Control+z"]) await page.keyboard.press(k);
  expect(await page.evaluate(() => window.__dossierTest!.counts())).toEqual(before);
  await expect(page.locator(".objset-panel")).toHaveCount(0);
  expect(await focusInside(dlg)).toBe(true);
}

/** Alles wählen, damit „Entf" im Hintergrund etwas löschen könnte (sonst wäre die Prüfung leer). */
async function selectAllWalls(page: Page): Promise<void> {
  await blurFocus(page);
  await page.keyboard.press("Control+a");
  await page.waitForTimeout(200);
}

/** Neues Projekt mit Test-Hooks (`?dossierTest`). */
async function startWithHooks(page: Page): Promise<void> {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
}

async function openKomplex(page: Page): Promise<void> {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });
}

const setTheme = (page: Page, theme: "light" | "dark") =>
  page.evaluate((th) => document.documentElement.setAttribute("data-theme", th), theme);

test("Kürzel-Übersicht: Fokus im Suchfeld, Tab-Falle, kein Kürzel dahinter, Esc, Fokus zurück zum Hilfe-Menü", async ({ page }) => {
  test.setTimeout(120_000);
  await startWithHooks(page);
  await openSample(page);
  await selectAllWalls(page);
  const help = page.getByRole("button", { name: "Hilfe", exact: true });
  await help.click();
  await page.getByRole("option", { name: /Tastaturkürzel/ }).click();
  const dlg = page.getByTestId("shortcut-overview");
  await expect(dlg).toBeVisible();
  await expect(dlg).toHaveAttribute("aria-modal", "true");
  await expect(dlg).toHaveAccessibleName("Tastaturkürzel");
  await expect(dlg.getByRole("searchbox")).toBeFocused();
  // Enter im Suchfeld bleibt folgenlos (keine Hauptaktion), das Feld filtert.
  await dlg.getByRole("searchbox").fill("rückgängig");
  await page.keyboard.press("Enter");
  await expect(dlg).toBeVisible();
  await dlg.getByRole("searchbox").fill("");
  await expectTrapped(page, dlg);
  await expectNoBackgroundShortcuts(page, dlg);
  // Fokus auf dem Dokument (Klick auf Text im Dialog): Tab holt ihn in den Dialog zurück.
  await dlg.getByText("Tastaturkürzel").first().click();
  await page.keyboard.press("Tab");
  expect(await focusInside(dlg)).toBe(true);
  await shot(page, "kuerzel-hell");
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  await expect(help).toBeFocused();
  // Danach gelten die Kürzel wieder: Entf löscht die Auswahl.
  const walls = await page.evaluate(() => window.__dossierTest!.counts().walls);
  await blurFocus(page);
  await page.keyboard.press("Delete");
  await expect.poll(() => page.evaluate(() => window.__dossierTest!.counts().walls)).toBeLessThan(walls);
});

test("Kamerafahrt-Dialog: erstes Feld, Tab-Falle, Enter-Hauptaktion, Esc, Fokus zurück zum Knopf", async ({ page }) => {
  test.setTimeout(150_000);
  await openKomplex(page);
  await openTab(page, "Ausschnitte");
  await selectAllWalls(page);
  const opener = page.getByTestId("camera-tour-video");
  await opener.focus();
  await page.keyboard.press("Enter");
  const dlg = page.getByTestId("tour-dialog");
  await expect(dlg).toBeVisible();
  await expect(dlg).toHaveAttribute("aria-modal", "true");
  await expect(dlg).toHaveAccessibleName("Kamerafahrt");
  await expect(dlg.getByTestId("tour-seconds")).toBeFocused();
  // Ungültige Dauer: Enter tut nichts, der Dialog bleibt.
  await dlg.getByTestId("tour-seconds").fill("99");
  await page.keyboard.press("Enter");
  await expect(dlg).toBeVisible();
  await dlg.getByTestId("tour-seconds").fill("4");
  await expectTrapped(page, dlg);
  await expectNoBackgroundShortcuts(page, dlg);
  await shot(page, "kamerafahrt-hell");
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("3D-Bild: Fokus, Tab-Falle, Enter startet, Esc schliesst, Fokus zurück in die Befehlszeile", async ({ page }) => {
  test.setTimeout(150_000);
  await openKomplex(page);
  await page.evaluate(() => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    (globalThis as { __dossierImageMock?: unknown }).__dossierImageMock = async (o: { width: number; height: number; transparent: boolean }) => ({ png, width: o.width, height: o.height, transparent: o.transparent });
  });
  await selectAllWalls(page);
  await typeCommand(page, "bild3d");
  const dlg = page.getByTestId("image3d-dialog");
  await expect(dlg).toBeVisible();
  await expect(dlg).toHaveAttribute("aria-modal", "true");
  await expect(dlg.getByTestId("image3d-camera")).toHaveAccessibleName("Kamera");
  await expect(dlg.getByTestId("image3d-size")).toHaveAccessibleName("Bildgrösse");
  expect(await focusInside(dlg)).toBe(true);
  await expect(page.locator(".cmdline-input")).not.toBeFocused();
  await expectTrapped(page, dlg);
  await expectNoBackgroundShortcuts(page, dlg);
  await shot(page, "bild3d-hell");
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  await expect(page.locator(".cmdline-input")).toBeFocused();
  // Enter in einem Zahlenfeld löst „Starten" aus; im Ergebnis liegt der Fokus auf „Speichern".
  await typeCommand(page, "bild3d");
  await expect(dlg).toBeVisible();
  await dlg.getByTestId("image3d-width").focus();
  await page.keyboard.press("Enter");
  await expect(dlg.getByTestId("image3d-result")).toBeVisible({ timeout: 20_000 });
  await dlg.getByTestId("image3d-save").focus();
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
});

test("Rendering-Dialog: Fokus, Tab-Falle, beschriftete Felder, Esc, Fokus zurück", async ({ page }) => {
  test.setTimeout(150_000);
  await openKomplex(page);
  await selectAllWalls(page);
  await typeCommand(page, "rendering");
  const dlg = page.getByRole("dialog", { name: "Rendering mit Blender" });
  await expect(dlg).toBeVisible();
  await expect(dlg).toHaveAttribute("aria-modal", "true");
  await expect(dlg.getByTestId("render-size")).toHaveAccessibleName("Bildgrösse");
  await expect(dlg.getByTestId("render-quality")).toHaveAccessibleName("Qualität");
  await expect(dlg.getByTestId("render-time")).toHaveAccessibleName("Datum und Uhrzeit der Sonne");
  expect(await focusInside(dlg)).toBe(true);
  await expectTrapped(page, dlg);
  await expectNoBackgroundShortcuts(page, dlg);
  await shot(page, "render-hell");
  await setTheme(page, "dark");
  await dlg.getByTestId("render-size").focus();
  await page.keyboard.press("Tab");
  await shot(page, "render-dunkel");
  await setTheme(page, "light");
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  await expect(page.locator(".cmdline-input")).toBeFocused();
});

test("Hilfslinien-Panel und Bild-HUD: Fokus ins Positionsfeld, Beschriftungen, Esc, Fokus zurück, Zuschnitt-Esc", async ({ page }) => {
  test.setTimeout(150_000);
  await startNewProject(page);
  await openSample(page);
  await openTab(page, "Mappe");
  await page.getByRole("button", { name: "Layout erstellen" }).first().click();
  await page.locator("[data-testid=newlayout-poster]").check();
  await page.getByRole("button", { name: "Erstellen", exact: true }).click();
  await page.keyboard.press("Enter");
  await page.locator(".nav-row", { hasText: "Layout" }).first().dblclick();
  await expect(page.locator(".layout-sheet-pane")).toBeVisible();

  const toggle = page.locator("[data-guides-toggle]");
  await toggle.click();
  const hud = page.getByTestId("guides-hud");
  await expect(hud).toBeVisible();
  await expect(hud).toHaveAttribute("role", "group");
  await expect(hud).toHaveAccessibleName("Hilfslinien");
  await expect(page.getByTestId("guide-pos")).toBeFocused();
  await expect(page.getByTestId("guide-axis")).toHaveAccessibleName("Richtung der Hilfslinie");
  await expect(page.getByTestId("guide-pos")).toHaveAccessibleName("Position in mm");
  await expect(page.getByTestId("guide-add")).toHaveAccessibleName("Hilfslinie anlegen");
  await expect(page.getByTestId("guides-close")).toHaveAccessibleName("Schliessen");
  // Enter legt die Linie an, der Fokus bleibt im Feld; Zeilenfelder tragen Namen mit der Richtung.
  await page.getByTestId("guide-pos").fill("123");
  await page.keyboard.press("Enter");
  const row = page.locator("[data-guide-row]").last();
  await expect(row.locator("input")).toHaveValue("123");
  await expect(row.locator("input")).toHaveAccessibleName(/Hilfslinie .*, Position in mm/);
  await shot(page, "hilfslinien-hell");
  await page.keyboard.press("Escape");
  await expect(hud).toHaveCount(0);
  await expect(toggle).toBeFocused();
  // Zweimal öffnen/schliessen per Tastatur.
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("guide-pos")).toBeFocused();
  await page.getByTestId("guides-close").focus();
  await page.keyboard.press("Enter");
  await expect(hud).toHaveCount(0);
  await expect(toggle).toBeFocused();

  // Bild-HUD
  await page.locator("[data-testid=sheet-image-input]").setInputFiles({ name: "rendering.png", mimeType: "image/png", buffer: testPng() });
  const img = page.getByTestId("image-hud");
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute("role", "group");
  await expect(page.getByTestId("image-x")).toHaveAccessibleName("Bild X in mm");
  await expect(page.getByTestId("image-width")).toHaveAccessibleName("Breite mm");
  await expect(page.getByTestId("image-crop-left")).toHaveAccessibleName("Zuschnitt Links in Prozent");
  await shot(page, "bildhud-hell");
  // Zuschnitt starten, im Feld Esc: Zuschnitt endet, das Bild bleibt gewählt.
  await page.getByTestId("image-crop-toggle").click();
  await expect(page.getByTestId("image-crop-toggle")).toHaveText("Fertig");
  await page.getByTestId("image-crop-left").focus();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("image-crop-toggle")).toHaveText("Zuschneiden");
  await expect(img).toBeVisible();
  // Esc im Feld ohne Zuschnitt: nur der Fokus verlässt das Feld, das Bild bleibt gewählt.
  await page.getByTestId("image-width").focus();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("image-width")).not.toBeFocused();
  await expect(img).toBeVisible();
  // Dialog über dem Blatt: Entf gehört dem Dialog, das Bild bleibt.
  await typeCommand(page, "bild3d");
  const dlg = page.getByTestId("image3d-dialog");
  await expect(dlg).toBeVisible();
  await dlg.locator("button").last().focus();
  await page.keyboard.press("Delete");
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  await expect(page.locator("[data-image-id]")).toHaveCount(1);
});

test("3D-Werkzeugleiste: stabile Namen, aria-pressed, Tab-Reihenfolge, Fokusring, Begehen per Tastatur", async ({ page }) => {
  test.setTimeout(150_000);
  await openKomplex(page);
  await showSnapshot(page, "Axonometrie Südost");
  const bar = page.getByTestId("viewport3d-tools");
  await expect(bar).toBeVisible({ timeout: 30_000 });
  await expect(bar).toHaveAttribute("role", "toolbar");
  const walk = page.getByTestId("walk-toggle");
  await expect(walk).toHaveAccessibleName("Begehen");
  await expect(walk).toHaveAttribute("aria-pressed", "false");
  // Mit Tab erreichbar; Fokusring (outline) sichtbar.
  // (Die Leiste steht im Tab-Lauf hinter der Befehlszeile/den Dock-Reitern; hier zählt ihre Reihenfolge untereinander.)
  await walk.focus();
  await page.keyboard.press("Shift+Tab"); // Tastaturmodus für :focus-visible
  await walk.focus();
  await expect(walk).toBeFocused();
  expect(await walk.evaluate((n) => getComputedStyle(n).outlineStyle)).toBe("solid");
  await shot(page, "toolbar3d-hell");
  // Leertaste schaltet; der Name bleibt, aria-pressed folgt; Geist-Knopf erscheint direkt nach dem Umschalter.
  await page.keyboard.press("Space");
  await expect(walk).toHaveAttribute("aria-pressed", "true");
  await expect(walk).toHaveAccessibleName("Begehen");
  const ghost = page.getByTestId("walk-ghost");
  await expect(ghost).toHaveAccessibleName("Geist (Wände durchlaufen)");
  await page.keyboard.press("Tab");
  await expect(ghost).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("camera-create-3d")).toBeFocused();
  await setTheme(page, "dark");
  await shot(page, "toolbar3d-dunkel");
  await setTheme(page, "light");
  // G schaltet den Geist, Esc beendet das Begehen (Fokus auf einem Leistenknopf).
  await page.keyboard.press("g");
  await expect(ghost).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(walk).toHaveAttribute("aria-pressed", "false");
});

test("Begehen läuft nicht im Hintergrund, solange ein Dialog Fokus hat", async ({ page }) => {
  test.setTimeout(150_000);
  await openKomplex(page);
  await showSnapshot(page, "Axonometrie Südost");
  const walk = page.getByTestId("walk-toggle");
  await expect(walk).toBeVisible({ timeout: 30_000 });
  await walk.click();
  await expect(walk).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Hilfe", exact: true }).click();
  await page.getByRole("option", { name: /Tastaturkürzel/ }).click();
  const dlg = page.getByTestId("shortcut-overview");
  await expect(dlg).toBeVisible();
  // Esc schliesst nur den Dialog, das Begehen bleibt; W/G im Dialog schalten nichts.
  await dlg.locator(".imp-close").focus();
  await page.keyboard.press("w");
  await page.keyboard.press("g");
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  await expect(walk).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("walk-ghost")).toHaveAttribute("aria-pressed", "false");
});

test("Dropdown mit Gruppen: Tastatur, activedescendant, Esc, Fokus zurück; Objekt-Info-Gruppen per Tastatur", async ({ page }) => {
  test.setTimeout(150_000);
  await openKomplex(page);
  await showSnapshot(page, "Axonometrie Südost");
  const dd = page.getByRole("button", { name: "Darstellungsart der aktiven Ansicht" });
  await expect(dd).toBeVisible({ timeout: 30_000 });
  await dd.focus();
  await page.keyboard.press("ArrowDown");
  const list = page.getByRole("listbox", { name: "Darstellungsart der aktiven Ansicht" });
  await expect(list).toBeVisible();
  await expect(dd).toHaveAttribute("aria-expanded", "true");
  await expect(dd).toHaveAttribute("aria-controls", /.+/);
  const groups = list.getByRole("group");
  expect(await groups.count()).toBe(3);
  await expect(groups.first()).toHaveAccessibleName(/Linien/);
  const active0 = await dd.getAttribute("aria-activedescendant");
  expect(active0).toBeTruthy();
  await page.keyboard.press("ArrowDown");
  expect(await dd.getAttribute("aria-activedescendant")).not.toBe(active0);
  await page.keyboard.press("End");
  const last = await dd.getAttribute("aria-activedescendant");
  await page.keyboard.press("Home");
  expect(await dd.getAttribute("aria-activedescendant")).not.toBe(last);
  await shot(page, "dropdown-hell");
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  await expect(dd).toBeFocused();
  // Mausauswahl: der Fokus liegt danach wieder auf dem Trigger.
  await dd.click();
  await list.getByRole("option").first().click();
  await expect(list).toHaveCount(0);
  await expect(dd).toBeFocused();
  // Tab verlässt ein offenes Menü und schliesst es.
  await dd.focus();
  await page.keyboard.press("Enter");
  await expect(list).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(list).toHaveCount(0);
});

test("Objekt-Info: Gruppenköpfe per Tastatur auf- und zuklappen, aria-controls, Fokusring", async ({ page }) => {
  test.setTimeout(150_000);
  await startNewProject(page);
  await openSample(page);
  await openTab(page, "Elemente");
  await page.locator(".nav-row").filter({ hasText: "W1" }).click();
  await expect(page.getByText("Auswahl: 1 Wand")).toBeVisible();
  await openTab(page, "Objekt-Info");
  const head = page.locator('.objinfo-panel [data-group="wall"] .objinfo-group-head');
  await expect(head).toBeVisible();
  await head.focus();
  const open0 = await head.getAttribute("aria-expanded");
  await page.keyboard.press("Enter");
  expect(await head.getAttribute("aria-expanded")).not.toBe(open0);
  await page.keyboard.press("Space");
  expect(await head.getAttribute("aria-expanded")).toBe(open0);
  if (open0 === "true") {
    const id = await head.getAttribute("aria-controls");
    expect(id).toMatch(/^objinfo-group-/);
    await expect(page.locator(`#${id}`)).toBeVisible();
  }
  // (Tab ausserhalb von Feldern, Dialogen und der 3D-Leiste springt app-weit in die Befehlszeile; der Ring zählt für Tastaturfokus.)
  await page.keyboard.press("Shift");
  await head.focus();
  await expect(head).toBeFocused();
  expect(await head.evaluate((n) => getComputedStyle(n).outlineStyle)).toBe("solid");
  await shot(page, "objinfo-gruppe-hell");
  await setTheme(page, "dark");
  await shot(page, "objinfo-gruppe-dunkel");
  await setTheme(page, "light");
});

// [250] Ältere Overlay-Dialoge auf dieselbe Hülle (`useModalFocus`): Fokus beim Öffnen im Dialog, Tab-Falle, Esc
// (wie bisher über den Dialog selbst), Fokus zurück zum Auslöser, Hintergrund-Kürzel gesperrt.

test("Export-Dialoge (IFC, DXF): Fokus im Dialog, Dateiname fokussiert, Tab-Falle, Esc, Fokus zurück zum Datei-Menü", async ({ page }) => {
  test.setTimeout(150_000);
  await startWithHooks(page);
  await openSample(page);
  await selectAllWalls(page);
  const fileBtn = page.getByRole("button", { name: "Datei", exact: true });
  await fileMenu(page, "Exportieren: IFC");
  const ifc = page.getByRole("dialog", { name: "Exportieren" });
  await expect(ifc).toBeVisible();
  await expect(ifc.getByRole("textbox", { name: "Dateiname" })).toBeFocused();
  await expectTrapped(page, ifc);
  await expectNoBackgroundShortcuts(page, ifc);
  await page.keyboard.press("Escape");
  await expect(ifc).toHaveCount(0);
  await expect(fileBtn).toBeFocused();
  await fileMenu(page, "Exportieren: DXF");
  const dxf = page.getByRole("dialog", { name: "DXF/DWG exportieren" });
  await expect(dxf).toBeVisible();
  expect(await focusInside(dxf)).toBe(true);
  await expectTrapped(page, dxf);
  await expectNoBackgroundShortcuts(page, dxf);
  await page.keyboard.press("Escape");
  await expect(dxf).toHaveCount(0);
  await expect(fileBtn).toBeFocused();
});

test("Ungespeicherte Änderungen: Fokus auf Abbrechen (nie auf Verwerfen), Enter bricht ab, Tab-Falle, Esc", async ({ page }) => {
  test.setTimeout(150_000);
  await startWithHooks(page);
  await openSample(page);
  // Eine Änderung (Wände löschen), damit die Rückfrage kommt.
  await selectAllWalls(page);
  await page.keyboard.press("Delete");
  const fileBtn = page.getByRole("button", { name: "Datei", exact: true });
  await fileMenu(page, /^Neu aus Vorlage: Musterhaus$/);
  const dlg = page.getByRole("dialog", { name: "Ungespeicherte Änderungen" });
  await expect(dlg).toBeVisible();
  await expect(dlg.getByRole("button", { name: "Abbrechen" })).toBeFocused();
  await expectTrapped(page, dlg);
  await dlg.getByRole("button", { name: "Abbrechen" }).focus();
  await page.keyboard.press("Enter");
  await expect(dlg).toHaveCount(0);
  await expect(page.locator(".project-name")).toHaveText("Demo-Haus");
  await fileMenu(page, /^Neu aus Vorlage: Musterhaus$/);
  await expect(dlg).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  await expect(fileBtn).toBeFocused();
});

test("Einstellungen: Fokus im Dialog, Tab-Falle, Esc, Fokus zurück", async ({ page }) => {
  test.setTimeout(120_000);
  await startWithHooks(page);
  const menu = page.getByRole("menubar").getByRole("button", { name: "Fenster", exact: true });
  await menu.click();
  await page.getByRole("option", { name: "Einstellungen" }).click();
  const dlg = page.getByRole("dialog", { name: "Einstellungen" });
  await expect(dlg).toBeVisible();
  expect(await focusInside(dlg)).toBe(true);
  await expectTrapped(page, dlg);
  await expectNoBackgroundShortcuts(page, dlg);
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  await expect(menu).toBeFocused();
});

test("Neues Layout und Präsentationsplan: Fokus im Dialog, beschriftete Auswahlfelder, Tab-Falle, Esc", async ({ page }) => {
  test.setTimeout(150_000);
  await startWithHooks(page);
  await openSample(page);
  await openTab(page, "Mappe");
  const opener = page.getByRole("button", { name: "Layout erstellen" }).first();
  await opener.click();
  const dlg = page.getByRole("dialog", { name: "Neues Layout" });
  await expect(dlg).toBeVisible();
  expect(await focusInside(dlg)).toBe(true);
  await dlg.getByTestId("newlayout-poster").check();
  await expect(dlg.getByTestId("newlayout-poster-select")).toHaveAccessibleName(/\S/);
  await expectTrapped(page, dlg);
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  await typeCommand(page, "praesentation");
  const pres = page.getByRole("dialog", { name: "Präsentationsplan" });
  await expect(pres).toBeVisible();
  expect(await focusInside(pres)).toBe(true);
  await expect(pres.getByTestId("presentation-paper")).toHaveAccessibleName("Papierformat");
  await expect(pres.getByTestId("presentation-scale")).toHaveAccessibleName("Massstab");
  await expectTrapped(page, pres);
  await page.keyboard.press("Escape");
  await expect(pres).toHaveCount(0);
});

// [251] Enter löst die Hauptaktion nur im Eingabefeld/Auswahlfeld oder auf dem Hauptknopf aus; auf „Abbrechen“ gilt dessen Aktion.
for (const kind of ["Layout", "Masterlayout"] as const) {
  test(`Neues ${kind}: Enter auf „Abbrechen“ erstellt nichts, Enter auf „Erstellen“ erstellt`, async ({ page }) => {
    test.setTimeout(150_000);
    await startWithHooks(page);
    await openSample(page);
    await openTab(page, "Mappe");
    const opener = page.getByRole("button", { name: kind === "Layout" ? "Layout erstellen" : "Masterlayout erstellen" }).first();
    const dlg = page.getByRole("dialog", { name: kind === "Layout" ? "Neues Layout" : "Neues Masterlayout" });
    const count = () => page.evaluate(() => window.__dossierTest!.counts().coreJson);
    const before = await count();
    // Enter auf „Abbrechen“: schliesst, erstellt nichts.
    await opener.click();
    await expect(dlg).toBeVisible();
    await dlg.getByRole("button", { name: "Abbrechen" }).focus();
    await page.keyboard.press("Enter");
    await expect(dlg).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(await count()).toBe(before);
    // Enter auf dem Schliessen-Kreuz: schliesst ebenfalls ohne Erstellen.
    await opener.click();
    await dlg.getByRole("button", { name: "Schliessen" }).focus();
    await page.keyboard.press("Enter");
    await expect(dlg).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(await count()).toBe(before);
    // Enter auf dem Hauptknopf erstellt.
    await opener.click();
    await dlg.getByRole("button", { name: "Erstellen", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(dlg).toHaveCount(0);
    await expect.poll(count).not.toBe(before);
  });
}

test("Präsentationsplan: Enter auf „Abbrechen“ erstellt nichts", async ({ page }) => {
  test.setTimeout(150_000);
  await startWithHooks(page);
  await openSample(page);
  await typeCommand(page, "praesentation");
  const pres = page.getByRole("dialog", { name: "Präsentationsplan" });
  await expect(pres).toBeVisible();
  const before = await page.evaluate(() => window.__dossierTest!.counts().coreJson);
  await pres.getByRole("button", { name: "Abbrechen" }).focus();
  await page.keyboard.press("Enter");
  await expect(pres).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__dossierTest!.counts().coreJson)).toBe(before);
});

// Dialoge ohne Datei erreichbar: Eingabe-Dialog (Kopien-Anzahl), Über, Standards-Update, Raumprogramm-Import (Datei aus dem Speicher), Kontext-Import.
test("Eingabe-Dialog, Über, Standards-Update: Fokus im Dialog, Tab-Falle, Esc, Fokus zurück", async ({ page }) => {
  test.setTimeout(150_000);
  await startWithHooks(page);
  await openSample(page);
  // Über dossier: Fokus zurück zur Wortmarke.
  const brand = page.locator(".brand-word");
  await brand.click();
  const about = page.getByRole("dialog", { name: "Über dossier" });
  await expect(about).toBeVisible();
  expect(await focusInside(about)).toBe(true);
  await expectTrapped(page, about);
  await page.keyboard.press("Escape");
  await expect(about).toHaveCount(0);
  await expect(brand).toBeFocused();
  // Eingabe-Dialog über „N Kopien".
  await selectAllWalls(page);
  await typeCommand(page, "move");
  await expect(page.locator(".cmdline-prompt")).toHaveText(/Basispunkt/);
  await page.locator(".cmdline-option", { hasText: "N Kopien" }).click();
  const prompt = page.getByRole("dialog", { name: "N Kopien" });
  await expect(prompt).toBeVisible();
  expect(await focusInside(prompt)).toBe(true);
  await expectTrapped(page, prompt);
  await expectNoBackgroundShortcuts(page, prompt);
  await page.keyboard.press("Escape");
  await expect(prompt).toHaveCount(0);
  // Standards-Update im Ressourcen-Fenster.
  await page.getByRole("button", { name: "Fenster", exact: true }).first().click();
  await page.getByRole("option", { name: /Ressourcen/ }).click();
  const upd = page.locator(".res-update-standards");
  await upd.click();
  const dlg = page.getByRole("dialog", { name: "Standards aktualisieren" });
  await expect(dlg).toBeVisible();
  expect(await focusInside(dlg)).toBe(true);
  await expectTrapped(page, dlg);
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  // Esc schliesst hier zugleich das Ressourcen-Fenster dahinter (bestehendes Verhalten): der Fokus kehrt nur zurück, wenn der Auslöser bleibt.
  if (await upd.count()) await expect(upd).toBeFocused();
});

test("Raumprogramm-Import und Kontext-Import: Fokus im Dialog, Tab-Falle, Esc, Fokus zurück", async ({ page }) => {
  test.setTimeout(150_000);
  await startWithHooks(page);
  await openSample(page);
  await openTab(page, "Flächenbilanz");
  const csv = "Raum;Fläche [m²];Anzahl;Flächenart;Gruppe\nWohnen;17,0;1;HNF;Wohnen\nBad;6,0;2;NNF;Nebenräume\n";
  await page.getByTestId("program-import-file").setInputFiles({ name: "programm.csv", mimeType: "text/csv", buffer: Buffer.from(csv, "utf8") });
  const rp = page.getByRole("dialog", { name: "Raumprogramm importieren" });
  await expect(rp).toBeVisible();
  expect(await focusInside(rp)).toBe(true);
  await expectTrapped(page, rp);
  await expectNoBackgroundShortcuts(page, rp);
  await page.keyboard.press("Escape");
  await expect(rp).toHaveCount(0);
  await openTab(page, "Gelände");
  const opener = page.getByRole("button", { name: "Standort importieren" });
  await opener.click();
  const ctx = page.getByRole("dialog").filter({ has: page.locator(".imp-head") }).last();
  await expect(ctx).toBeVisible();
  expect(await focusInside(ctx)).toBe(true);
  await expectTrapped(page, ctx);
  await page.keyboard.press("Escape");
  await expect(ctx).toHaveCount(0);
  await expect(opener).toBeFocused();
});
