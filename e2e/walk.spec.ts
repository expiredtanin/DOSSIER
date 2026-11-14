// [245] Begehen: Knopf „Begehen", darin der Geist-Knopf (G schaltet Kollision und Bodenfolge aus/an), Esc beendet.
// Die Bewegung selbst (Wand blockiert, Treppe, Stufe, Kante) prüft `src/viewport/walkCollision.test.ts`; ohne WebGPU
// (headless) gibt es hier keine Kamera zum Lesen.
// Eigener Port: E2E_PORT=5195 npx playwright test e2e/walk.spec.ts
import type { Page } from "@playwright/test";
import { discardIfAsked, expect, fileMenu, showSnapshot, test } from "./app";

async function openKomplex(page: Page): Promise<void> {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });
}

test("Begehen: Geist-Knopf und Taste G, Esc beendet", async ({ page }) => {
  test.setTimeout(120_000);
  await openKomplex(page);
  await showSnapshot(page, "Axonometrie Südost");
  const walk = page.getByTestId("walk-toggle");
  await expect(walk).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("walk-ghost")).toHaveCount(0);
  await walk.click();
  await expect(walk).toHaveAttribute("aria-pressed", "true");
  const ghost = page.getByTestId("walk-ghost");
  await expect(ghost).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("walk-help")).toContainText("G");
  // Unter Last hängt der Tasten-Hörer des Begehen-Modus erst nach dem nächsten Effekt: G wiederholen, bis es wirkt
  // (nur solange noch aus, damit kein Doppel-Umschalten entsteht).
  await expect(async () => {
    if ((await ghost.getAttribute("aria-pressed")) !== "true") await page.keyboard.press("g");
    await expect(ghost).toHaveAttribute("aria-pressed", "true", { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await page.keyboard.press("g");
  await expect(ghost).toHaveAttribute("aria-pressed", "false");
  // W läuft ohne Absturz (Kollisionswelt wird aus dem Modell gebaut).
  await page.keyboard.down("w");
  await page.waitForTimeout(400);
  await page.keyboard.up("w");
  await page.keyboard.press("Escape");
  await expect(walk).toHaveAttribute("aria-pressed", "false");
});
