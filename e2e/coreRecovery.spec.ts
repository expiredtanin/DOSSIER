// [118] Wiederanlauf nach Kern-Panic in echtem Chromium: dort ist synchrones Instanziieren des Kerns
// (> 8 MB) im Haupt-Thread verboten, der Neustart muss asynchron laufen. Ausgelöst über die Test-Naht
// `?dossierTest` (`src/state/testHooks.ts` → `__debug_panic` im Kern).
import { blurFocus, elementRows, expect, openSample, openTab, test } from "./app";
import type {} from "../src/state/testHooks"; // Typ von window.__dossierTest

/** Erwartete Konsolenfehler des absichtlichen Panics (Panic-Hook, Neustart-Protokoll). */
const EXPECTED = /__debug_panic|Rust-Kern abgestürzt|RuntimeError|unreachable/;

test("Kern-Panic: Kern startet neu, Projekt bleibt, weitere Änderung geht", async ({ page, errors }) => {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await openSample(page);

  const before = await page.evaluate(() => window.__dossierTest!.counts());
  expect(before.walls).toBeGreaterThan(0);
  const epoch = await page.evaluate(() => window.__dossierTest!.coreEpoch());

  // Panic auslösen: der Aufruf wirft CoreTrapError (nicht wiederholt), der Kern startet im Hintergrund neu.
  expect(await page.evaluate(() => window.__dossierTest!.corePanic())).toBe("CoreTrapError");
  await page.evaluate(() => window.__dossierTest!.coreReady());
  expect(await page.evaluate(() => window.__dossierTest!.coreEpoch())).toBe(epoch + 1);

  // Meldung an den Benutzer, Projekt (Store und Kern-Dokument) unverändert.
  await expect(page.getByText(/Interner Fehler im Kern/)).toBeVisible();
  expect(await page.evaluate(() => window.__dossierTest!.counts())).toEqual(before);
  await expect(page.locator(".project-name")).toHaveText("Demo-Haus");

  // Weitere Änderung über die Oberfläche (wie editing.spec.ts): Wand W1 höher machen.
  await openTab(page, "Elemente");
  await elementRows(page).filter({ hasText: "W1" }).click();
  await expect(page.getByText("Auswahl: 1 Wand")).toBeVisible();
  const volume = page.getByText("Volumen").locator("..");
  await expect(volume).toContainText("3.42 m³");
  const top = page.locator(".objinfo-wall-anchor").first();
  await top.getByRole("button", { name: "Eigene" }).click();
  const topField = top.getByLabel("Eigene Höhe");
  await topField.fill("3.2");
  await topField.press("Enter");
  await expect(volume).not.toContainText("3.42 m³");
  // Neuer Verlauf: die Änderung lässt sich rückgängig machen.
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(volume).toContainText("3.42 m³");

  // Nur die erwarteten Fehler des absichtlichen Panics; alles andere prüft der Konsolen-Wächter.
  const unexpected = errors.filter((e) => !EXPECTED.test(e));
  errors.splice(0, errors.length, ...unexpected);
});
