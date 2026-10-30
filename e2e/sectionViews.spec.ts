// [115] Maintainer-Befund am Musterhaus komplex: aus Schnitt/Ansicht liess sich nicht ins 3D wechseln, und ein
// Schnitt liess sich nicht wie ein Grundriss auf ein Layout-Blatt legen (Viewport zeigte nur die 2D-Elemente).
import type { Page } from "@playwright/test";
import { discardIfAsked, expect, fileMenu, openTab, startNewProject, test } from "./app";

async function openComplex(page: Page) {
  await startNewProject(page);
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });
}

async function openViewTab(page: Page, name: string) {
  await page
    .getByRole("tablist", { name: "Zeichnungen" })
    .getByRole("tab", { name: `${name} Ausschnitt-Tab löschen`, exact: true })
    .click();
  await expect(page.locator("svg.plan-svg").first()).toBeVisible({ timeout: 30_000 });
}

test("Schnitt und Ansicht: Wechsel ins 3D (Schnitt mit Live-Schnitt) und zurück", async ({ page }) => {
  test.setTimeout(120_000);
  await openComplex(page);

  await openViewTab(page, "Schnitt A-A");
  // Axonometrie-Knopf in der Ansicht-Leiste ist nicht mehr gesperrt.
  await page.getByRole("button", { name: "Axonometrie", exact: true }).click();
  await expect(page.getByText("Perspektive · Schnitt A-A")).toBeVisible({ timeout: 30_000 });
  // Live-Schnitt an der Schnittlinie gebunden.
  await expect(page.getByRole("button", { name: "Schnittebene" })).toBeVisible();
  await page.screenshot({ path: "test-results/schnitt-3d.png" });
  // Zurück in die Schnittzeichnung.
  await page.getByRole("button", { name: "Grundriss", exact: true }).click();
  await expect(page.getByText("Perspektive · Schnitt A-A")).toHaveCount(0);
  await expect(page.locator("svg.plan-svg").first()).toBeVisible({ timeout: 30_000 });

  // Ansicht: über das Menü Ansicht → Perspektive.
  await openViewTab(page, "Ansicht Süd");
  await page.getByRole("button", { name: "Ansicht", exact: true }).click();
  await page.getByRole("option", { name: "Perspektive" }).first().click();
  await expect(page.getByText("Perspektive · Ansicht Süd")).toBeVisible({ timeout: 30_000 });
});

test("Layout-Blatt: Viewport zeigt Schnitt wie einen Grundriss", async ({ page }) => {
  test.setTimeout(120_000);
  await openComplex(page);
  await openTab(page, "Mappe");
  await page.getByRole("button", { name: "Layout erstellen" }).first().click();
  await page.getByRole("button", { name: "Erstellen", exact: true }).click();
  await page.keyboard.press("Enter");
  await page.locator(".nav-row", { hasText: "Neues Layout" }).first().dblclick();
  await expect(page.locator(".layout-sheet-pane")).toBeVisible({ timeout: 30_000 });
  const paper = (await page.locator("[data-sheet-backdrop] > rect").nth(1).boundingBox())!;
  await page.getByRole("button", { name: /Viewport aufziehen/ }).click();
  await page.mouse.move(paper.x + paper.width * 0.1, paper.y + paper.height * 0.1);
  await page.mouse.down();
  await page.mouse.move(paper.x + paper.width * 0.9, paper.y + paper.height * 0.85, { steps: 6 });
  await page.mouse.up();
  await page.locator(".layout-sheet-bind select").selectOption({ label: "Schnitt A-A" });
  await page.locator(".layout-sheet-bind button").first().click();
  // Der Schnitt mit seinen Höhenkoten — vorher rechnete der Viewport den Grundriss-Weg (Gelände-Höhenlinien,
  // Schnittlinien-Symbole „West"/„A-A" …), aber keinen Schnitt.
  const vp = page.locator("[data-viewport-id] svg").first();
  await expect(vp).toContainText("+2.70", { timeout: 30_000 });
  await expect(vp).not.toContainText("West");
  expect(await vp.locator("path, line, polygon, polyline").count()).toBeGreaterThan(200);
  await page.locator(".layout-sheet-pane").screenshot({ path: "test-results/blatt-schnitt.png" });
});
