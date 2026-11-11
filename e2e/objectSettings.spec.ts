// [189] Attribute-Panel = nur Gestaltung, Bauteil-/BIM-Felder in der Objekt-Info; Taste T öffnet die
// Einstellungen des gewählten Objekts (Fenster/Tür: Dialog, sonst Abschnitt der Objekt-Info).
// Mit DOSSIER_SHOTS=<ordner> entstehen Screenshots für die Abnahme.
import { blurFocus, elementRows, expect, openSample, openTab, startNewProject, test } from "./app";
import type { Page } from "@playwright/test";

test.use({ deviceScaleFactor: 2 });

async function selectW1(page: Page): Promise<void> {
  await openTab(page, "Elemente");
  await elementRows(page).filter({ hasText: "W1" }).click();
  await expect(page.getByText("Auswahl: 1 Wand")).toBeVisible();
  await openTab(page, "Objekt-Info");
}

test("Wand gewählt: Attribute ohne Aufbau/Typ-Felder, Objekt-Info mit Wand-Abschnitt ([189])", async ({ page }) => {
  await startNewProject(page);
  await openSample(page);
  await selectW1(page);

  const attr = page.locator(".attr-panel");
  const info = page.locator(".objinfo-panel");
  // Gestaltung bleibt im Attribute-Panel.
  await expect(attr.getByText("Strichstärke (mm)", { exact: true })).toBeVisible();
  await expect(attr.getByText("Hintergrund", { exact: true })).toBeVisible();
  // Bauteil-Felder sind dort weg …
  await expect(attr.locator(".objinfo-wall-anchor")).toHaveCount(0);
  await expect(attr.getByText("Volumen")).toHaveCount(0);
  await expect(attr.getByText("Aufbau", { exact: false })).toHaveCount(0);
  await expect(attr.getByText("Maße", { exact: true })).toHaveCount(0);
  // … und in der Objekt-Info als einklappbarer Abschnitt.
  const group = info.locator('[data-group="wall"]');
  await expect(group.locator(".objinfo-wall-anchor").first()).toBeVisible();
  await expect(group.getByText("Volumen")).toBeVisible();

  // Einklappen blendet den Inhalt aus, Aufklappen holt ihn zurück.
  const head = group.locator(".objinfo-group-head");
  await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "false");
  await expect(group.getByText("Volumen")).toHaveCount(0);
  await head.click();
  await expect(group.getByText("Volumen")).toBeVisible();

  const shots = process.env.DOSSIER_SHOTS;
  if (shots) {
    await head.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await info.screenshot({ path: `${shots}/objekt-info-wand.png` });
    await attr.screenshot({ path: `${shots}/attribute-wand.png` });
  }
});

test("Taste T: Fenster gewählt → Einstellungsdialog ([189])", async ({ page }) => {
  await startNewProject(page);
  await openSample(page);
  await openTab(page, "Elemente");
  await elementRows(page).filter({ hasText: /Fenster/ }).first().click();
  await blurFocus(page);
  await expect(page.locator(".oed-dialog")).toHaveCount(0);
  await page.keyboard.press("t");
  await expect(page.locator(".oed-dialog")).toBeVisible();
});

test("Taste T: Wand gewählt → Wand-Abschnitt der Objekt-Info fokussiert und aufgeklappt ([189])", async ({ page }) => {
  await startNewProject(page);
  await openSample(page);
  await selectW1(page);
  const head = page.locator('[data-group="wall"] .objinfo-group-head');
  await head.click(); // zuklappen
  await expect(head).toHaveAttribute("aria-expanded", "false");
  await blurFocus(page);
  await page.keyboard.press("t");
  await expect(head).toHaveAttribute("aria-expanded", "true");
  await expect(head).toBeFocused();
  await expect(page.locator(".oed-dialog")).toHaveCount(0);
});

test("Taste T ohne Auswahl bei Wand-Werkzeug: Typ des neuen Bauteils in der Objekt-Info ([189])", async ({ page }) => {
  await startNewProject(page);
  await openSample(page);
  await openTab(page, "Objekt-Info");
  await blurFocus(page);
  await page.keyboard.press("6");
  await blurFocus(page); // der Befehl holt den Fokus in die Befehlszeile
  await page.keyboard.press("t");
  await expect(page.locator('[data-group="newComponent"] .objinfo-group-head')).toBeFocused();
  await expect(page.locator(".attr-panel").getByText("Neues Bauteil")).toHaveCount(0);
});

test("Taste T: in Textfeldern wirkungslos, ohne Auswahl und Werkzeug nichts ([189])", async ({ page }) => {
  await startNewProject(page);
  await openSample(page);
  await openTab(page, "Elemente");
  await elementRows(page).filter({ hasText: /Fenster/ }).first().click();
  // Tippen im Befehlsfeld darf den Dialog nicht öffnen.
  await page.locator(".cmdline-input").fill("t");
  await page.locator(".cmdline-input").press("t");
  await expect(page.locator(".oed-dialog")).toHaveCount(0);
  // Auswahl leeren: T tut nichts.
  await page.locator(".cmdline-input").fill("");
  await blurFocus(page);
  await page.keyboard.press("Escape");
  await page.keyboard.press("t");
  await expect(page.locator(".oed-dialog")).toHaveCount(0);
});
