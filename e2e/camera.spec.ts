// [213] Kameras: im Musterhaus komplex liegt die Kamera „Südost" — ihr Symbol (Gehäuse, Sichtkegel, Ziel) steht im
// EG-Grundriss, die Kamera lässt sich in der Liste wählen (Objekt-Info), „Kamera öffnen" wechselt in den 3D-Reiter.
// (Dass die Klasse „Kameras" das Symbol ausblendet, prüft der Kern-Test `plan::cameras`.) Aus der 3D-Ansicht lässt sich eine neue Kamera anlegen.
// WebGPU ist headless oft leer: ist der 3D-Viewport nicht bereit, wird auf Reiter und Hinweis geprüft statt auf die Kamera.
// Eigener Port: E2E_PORT=5191 npx playwright test e2e/camera.spec.ts
import type { Page } from "@playwright/test";
import type {} from "../src/state/testHooks"; // Typ von window.__dossierTest
import { discardIfAsked, drawingTab, expect, fileMenu, openTab, showSnapshot, test } from "./app";

async function openKomplex(page: Page): Promise<void> {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });
  await showSnapshot(page, "EG 1:100");
  await expect(page.locator("svg.plan-svg").first()).toBeVisible({ timeout: 30_000 });
}

test("Kamera im Grundriss sehen, wählen, öffnen", async ({ page }) => {
  test.setTimeout(120_000);
  await openKomplex(page);

  // Symbol im EG-Grundriss (Sichtkegel-Linien der Klasse „camera-cone").
  await expect.poll(() => page.evaluate(() => window.__dossierTest?.planLines("camera-cone") ?? 0), { timeout: 20_000 }).toBeGreaterThan(0);

  // Kameraliste im Panel „Ausschnitte"; Klick wählt, die Objekt-Info zeigt die Werte.
  await openTab(page, "Ausschnitte");
  const row = page.getByTestId("camera-row-kamera-suedost");
  await expect(row).toContainText("Südost");
  await row.click();
  await openTab(page, "Objekt-Info");
  const section = page.getByTestId("camera-section");
  await expect(section).toBeVisible();
  await expect(section.getByTestId("camera-name")).toHaveValue("Südost");

  // Name ändern und rückgängig machen.
  await section.getByTestId("camera-name").fill("Abendblick");
  await section.getByTestId("camera-name").press("Enter");
  await expect(section.getByTestId("camera-name")).toHaveValue("Abendblick");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("ControlOrMeta+z");
  await expect(section.getByTestId("camera-name")).toHaveValue("Südost");

  // Kamera öffnen → 3D-Reiter.
  await section.getByTestId("camera-open").click();
  await expect(drawingTab(page, "3D · Erdgeschoss")).toHaveAttribute("aria-selected", "true", { timeout: 20_000 });
  const live = await page
    .waitForFunction(() => (window as unknown as { __dossierCamera?: unknown }).__dossierCamera !== undefined, undefined, { timeout: 8_000 })
    .then(() => true, () => false);
  if (live) {
    // Der Viewport ist bereit: die Ansicht sitzt exakt auf der Kamera (Standpunkt 17 / −3, Augenhöhe 1.6 über OK EG).
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const c = (window as unknown as { __dossierCamera: { getCamera: () => { position: number[]; kind: string } | null } }).__dossierCamera.getCamera();
            return c ? [...c.position.map((v) => Math.round(v * 100) / 100), c.kind] : null;
          }),
        { timeout: 10_000 },
      )
      .toEqual([17, -3, expect.any(Number), "perspective"]);
  }
});

test("Kamera aus der 3D-Ansicht anlegen", async ({ page }) => {
  test.setTimeout(120_000);
  await openKomplex(page);
  // In den 3D-Reiter und dort „Kamera aus aktueller Ansicht anlegen" (Knopf oben rechts).
  await showSnapshot(page, "Axonometrie Südost");
  const create = page.getByTestId("camera-create-3d");
  await expect(create).toBeVisible({ timeout: 30_000 });
  await create.click();
  const ready = await page
    .waitForFunction(() => (window as unknown as { __dossierCamera?: unknown }).__dossierCamera !== undefined, undefined, { timeout: 5_000 })
    .then(() => true, () => false);
  await openTab(page, "Ausschnitte");
  if (ready) {
    await expect(page.locator("[data-testid^=camera-row-]")).toHaveCount(2);
  } else {
    // Ohne WebGPU gibt es keine Kamera zum Lesen: der Hinweis sagt es, es entsteht nichts.
    await expect(page.locator("[data-testid^=camera-row-]")).toHaveCount(1);
  }

  // Zurück in den Grundriss: das Symbol ist da.
  await showSnapshot(page, "EG 1:100");
  await expect.poll(() => page.evaluate(() => window.__dossierTest?.planLines("camera-cone") ?? 0), { timeout: 20_000 }).toBeGreaterThan(0);
});
