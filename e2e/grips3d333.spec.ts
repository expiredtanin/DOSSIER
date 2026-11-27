// [333] 3D-Griffe für Stützen und Wandöffnungen (Projekt „webgpu“, echtes WebGPU über SwiftShader, s. webgpu333.spec.ts):
// gewähltes Element → DOM-Griff über dem 3D-Canvas → Klick bewaffnet, Mausbewegung zieht, zweiter Klick setzt.
// Geprüft wird, dass sich das Modell ändert (Kern-Zug wie im Plan: `columnGrip`, `openingSlide`).
// Lauf: E2E_PORT=5186 npx playwright test e2e/grips3d333.spec.ts --project=webgpu --trace off
import type { Page } from "@playwright/test";
import { expect, fileMenu, discardIfAsked, test } from "./app";

type Hooks = {
  select: (s: Record<string, string[]>) => void;
  gripGeom: () => { columns: { id: string; position: { x: number; y: number } }[] };
  openings: () => { id: string; position: number }[];
};
const hooks = (page: Page) => page.evaluate(() => (window as unknown as { __dossierTest: unknown }).__dossierTest !== undefined);

async function open3d(page: Page) {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await page.getByRole("button", { name: "Ansicht", exact: true }).click();
  await page.getByRole("option", { name: "3D-Ansicht", exact: true }).click();
  await page.locator("canvas[data-engine=render3d]").waitFor({ timeout: 60_000 });
  await page.waitForTimeout(2000);
  expect(await hooks(page)).toBe(true);
}

/** Griff anklicken (bewaffnet ihn), `dx`/`dy` Pixel weiterfahren, zweiter Klick setzt ihn. */
async function dragGrip(page: Page, title: string, dx: number, dy: number) {
  const grip = page.locator(`div[title="${title}"][style*="width: 16px"]`).first();
  await grip.waitFor({ timeout: 20_000 });
  const b = (await grip.boundingBox())!;
  const [x, y] = [b.x + b.width / 2, b.y + b.height / 2];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
  await page.mouse.move(x + dx, y + dy, { steps: 12 });
  await page.waitForTimeout(300);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(300);
}

test("3D-Griffe: Stütze verschieben, Fenster in der Wand gleiten", async ({ page }) => {
  test.setTimeout(180_000);
  await open3d(page);

  // Stütze: Mitte-Griff („Verschieben") ziehen.
  await page.evaluate(() => (window as unknown as { __dossierTest: Hooks }).__dossierTest.select({ columns: ["st-carport-1"] }));
  // 12 cm sind im ganzen Modell nur wenige Pixel: Stütze erst aufziehen (Kern-Griff 3), damit die Griffe getrennt liegen.
  await page.evaluate(() => {
    const h = (window as unknown as { __dossierTest: { columnGrip: (id: string, i: number, x: number, y: number) => void; gripGeom: Hooks["gripGeom"] } }).__dossierTest;
    const c = h.gripGeom().columns.find((x) => x.id === "st-carport-1")!;
    h.columnGrip("st-carport-1", 3, c.position.x + 5, c.position.y + 5);
  });
  await page.waitForTimeout(800);
  const before = await page.evaluate(() => (window as unknown as { __dossierTest: Hooks }).__dossierTest.gripGeom().columns.find((c) => c.id === "st-carport-1")!.position);
  await dragGrip(page, "Verschieben", 70, 30);
  const after = await page.evaluate(() => (window as unknown as { __dossierTest: Hooks }).__dossierTest.gripGeom().columns.find((c) => c.id === "st-carport-1")!.position);
  expect(Math.hypot(after.x - before.x, after.y - before.y), "Stütze verschoben").toBeGreaterThan(0.05);

  // Fenster: Gleit-Griff entlang der Wirtswand.
  const id = "eg-f1";
  await page.evaluate((i) => (window as unknown as { __dossierTest: Hooks }).__dossierTest.select({ openings: [i] }), id);
  const p0 = await page.evaluate((i) => (window as unknown as { __dossierTest: Hooks }).__dossierTest.openings().find((o) => o.id === i)!.position, id);
  await dragGrip(page, "Öffnung in der Wand verschieben", 90, 0);
  const p1 = await page.evaluate((i) => (window as unknown as { __dossierTest: Hooks }).__dossierTest.openings().find((o) => o.id === i)!.position, id);
  expect(Math.abs(p1 - p0), "Fenster gleitet").toBeGreaterThan(0.05);
});
