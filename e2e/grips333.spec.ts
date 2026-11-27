// [333] Grundriss-Griffe für Stützen und freie Körper (Musterhaus komplex): Stütze `st-carport-1` (EG, 12×12 cm) lässt
// sich an der Ecke aufziehen (Querschnitt wächst symmetrisch um die Mitte) und an der Mitte verschieben; ein Körper
// (`void-durchreiche`) an einer Profil-Ecke ziehen.
import type { Page } from "@playwright/test";
import { blurFocus, discardIfAsked, expect, fileMenu, openTab, test } from "./app";
import type {} from "../src/state/testHooks"; // Typ von window.__dossierTest

async function screenOf(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.locator("svg.plan-svg").first().evaluate(
    (el, [x, y]) => {
      const [vx, vy, vw, vh] = el.getAttribute("viewBox")!.split(/\s+/).map(Number);
      const ox = Number(el.getAttribute("data-origin-x") ?? 0);
      const oy = Number(el.getAttribute("data-origin-y") ?? 0);
      const r = el.getBoundingClientRect();
      const s = Math.min(r.width / vw, r.height / vh);
      return { x: r.left + (r.width - vw * s) / 2 + (x * 90 - ox - vx) * s, y: r.top + (r.height - vh * s) / 2 + (-y * 90 - oy - vy) * s };
    },
    [x, y],
  );
}

async function openComplex(page: Page) {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });
  await expect(page.locator("svg.plan-svg").first()).toBeVisible({ timeout: 30_000 });
}

const nav = (page: Page, name: string) => page.locator(".nav-row").filter({ hasText: name }).first();
const geom = (page: Page) => page.evaluate(() => window.__dossierTest!.gripGeom());
const column = async (page: Page) => (await geom(page)).columns.find((c) => c.id === "st-carport-1")!;

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}

async function openEg(page: Page) {
  await openComplex(page);
  await openTab(page, "Zeichnungsebenen");
  await nav(page, "Erdgeschoss").click();
  await page.waitForTimeout(800);
  await blurFocus(page);
}

test("Stütze: Ecken-Griff vergrössert den Querschnitt um die Mitte", async ({ page }) => {
  test.setTimeout(150_000);
  await openEg(page);
  await page.evaluate(() => window.__dossierTest!.select({ columns: ["st-carport-1"] }));
  await page.waitForTimeout(500);
  const before = await column(page);
  expect(before.width).toBeCloseTo(0.12, 6);
  // Eine 12-cm-Stütze ist im Plan nur wenige Pixel gross (Ecken- und Mitte-Griff liegen übereinander): erst per Kern-Griff auf
  // 1 × 1 m aufziehen (Ecke 3 = +x/+y), dann die Ecke mit der Maus weiterziehen.
  const [cx, cy] = [before.position.x, before.position.y];
  await page.evaluate(([x, y]) => window.__dossierTest!.columnGrip("st-carport-1", 3, x + 0.5, y + 0.5), [cx, cy]);
  await expect.poll(async () => (await column(page)).width).toBeCloseTo(1.0, 6);
  expect((await column(page)).depth).toBeCloseTo(1.0, 6);
  await page.waitForTimeout(500);
  const a = await screenOf(page, cx + 0.5, cy + 0.5);
  const b = await screenOf(page, cx + 0.9, cy + 0.8);
  await drag(page, a, b);
  // Der Fang kann den Zielpunkt verziehen: nur prüfen, dass beide Masse wachsen und die Mitte bleibt.
  await expect.poll(async () => (await column(page)).width, { timeout: 10_000 }).toBeGreaterThan(1.2);
  const after = await column(page);
  expect(after.depth).toBeGreaterThan(1.2);
  expect(Math.abs(after.position.x - before.position.x) + Math.abs(after.position.y - before.position.y)).toBeLessThan(1e-9);
});

test("Stütze: Mitte-Griff verschiebt die Stütze", async ({ page }) => {
  test.setTimeout(150_000);
  await openEg(page);
  await page.evaluate(() => window.__dossierTest!.select({ columns: ["st-carport-1"] }));
  await page.waitForTimeout(500);
  const before = await column(page);
  const a = await screenOf(page, before.position.x, before.position.y);
  const b = await screenOf(page, before.position.x + 0.8, before.position.y);
  await drag(page, a, b);
  await expect.poll(async () => (await column(page)).position.x, { timeout: 10_000 }).toBeGreaterThan(before.position.x + 0.3);
  expect((await column(page)).width).toBeCloseTo(0.12, 6);
});

test("Freier Körper: Eck-Griff verschiebt die Profil-Ecke", async ({ page }) => {
  test.setTimeout(150_000);
  await openEg(page);
  await page.evaluate(() => window.__dossierTest!.select({ solids: ["void-durchreiche"] }));
  await page.waitForTimeout(500);
  const solid = async () => (await geom(page)).solids.find((s) => s.id === "void-durchreiche")!;
  const before = await solid();
  const c = before.points[2];
  const a = await screenOf(page, c.x, c.y);
  const b = await screenOf(page, c.x + 0.5, c.y + 0.6);
  await drag(page, a, b);
  await expect.poll(async () => (await solid()).points[2].x, { timeout: 10_000 }).toBeGreaterThan(c.x + 0.2);
  expect((await solid()).points[0]).toEqual(before.points[0]);
});
