// [246] Kamerafahrt: Knopf in der Kamera-Gruppe fährt im 3D durch die Kameras, Esc bricht ab; der Dialog „Video …" bietet
// Dauer, Format und Aufnahme mit Abbruch. WebGPU ist headless oft leer: ist der 3D-Viewport nicht bereit, wird nur geprüft,
// dass nichts abstürzt (der Konsolen-Wächter aus `app.ts` meldet Fehler). Eigener Port: E2E_PORT=5196 npx playwright test e2e/cameraTour.spec.ts
import type { Page } from "@playwright/test";
import type {} from "../src/state/testHooks"; // Typ von window.__dossierTest
import { discardIfAsked, expect, fileMenu, openTab, showSnapshot, test } from "./app";

async function openKomplex(page: Page): Promise<void> {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });
  await showSnapshot(page, "Axonometrie Südost");
}

type CamApi = { getCamera: () => { position: number[] } | null };
const viewportLive = (page: Page) =>
  page.waitForFunction(() => (window as unknown as { __dossierCamera?: unknown }).__dossierCamera !== undefined, undefined, { timeout: 8_000 }).then(() => true, () => false);
const eyeX = (page: Page) => page.evaluate(() => (window as unknown as { __dossierCamera: CamApi }).__dossierCamera.getCamera()?.position[0] ?? null);

test("Kamerafahrt starten und mit Esc abbrechen", async ({ page }) => {
  test.setTimeout(120_000);
  await openKomplex(page);
  const live = await viewportLive(page);
  if (live) {
    // Zweite Kamera aus der Ansicht, damit die Fahrt einen Abschnitt hat.
    await page.getByTestId("camera-create-3d").click();
  }
  await openTab(page, "Ausschnitte");
  const tour = page.getByTestId("camera-tour");
  await expect(tour).toBeEnabled();
  await tour.click();
  if (live && (await page.locator("[data-testid^=camera-row-]").count()) >= 2) {
    // Die Sicht bewegt sich …
    const start = await eyeX(page);
    await page.waitForTimeout(800);
    const during = await eyeX(page);
    expect(during).not.toBeNull();
    // … Esc hält sie an.
    await page.keyboard.press("Escape");
    const stopped = await eyeX(page);
    await page.waitForTimeout(600);
    expect(await eyeX(page)).toBe(stopped);
    expect(start === during && stopped === during).toBe(false);
  } else {
    // Ohne 3D-Viewport: der Knopf wechselt in 3D oder meldet es; Esc ist harmlos.
    await page.waitForTimeout(500);
    await page.keyboard.press("Escape");
  }
});

test("Dialog Kamerafahrt: Vorgaben, Eingabeprüfung, Aufnahme abbrechen", async ({ page }) => {
  test.setTimeout(120_000);
  await openKomplex(page);
  const live = await viewportLive(page);
  if (live) await page.getByTestId("camera-create-3d").click();
  await openTab(page, "Ausschnitte");
  await page.getByTestId("camera-tour-video").click();
  const dlg = page.getByTestId("tour-dialog");
  await expect(dlg).toBeVisible();
  await expect(dlg.getByTestId("tour-seconds")).toHaveValue("4");
  await expect(dlg.getByTestId("tour-resolution")).toContainText("30");
  await dlg.getByTestId("tour-seconds").fill("99");
  await expect(dlg.getByTestId("tour-record")).toBeDisabled();
  await expect(dlg.getByTestId("tour-play")).toBeDisabled();
  await dlg.getByTestId("tour-seconds").fill("2,5");
  await expect(dlg.getByTestId("tour-total")).toContainText("s");
  const canRecord = await dlg.getByTestId("tour-record").isEnabled();
  if (live && canRecord) {
    await dlg.getByTestId("tour-record").click();
    await expect(page.getByTestId("tour-bar")).toBeVisible();
    await page.getByTestId("tour-cancel").click();
    await expect(page.getByTestId("tour-bar")).toHaveCount(0, { timeout: 5_000 });
    await expect(dlg).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
});
