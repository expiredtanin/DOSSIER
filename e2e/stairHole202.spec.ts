// [202] Musterhaus komplex (Mac-Befund „Wenn ich die Wendeltreppe verschiebe, verschwindet sie"): die Wendeltreppe
// `tr-wendel` steht im UG und ist im EG nur durch das Deckenloch der UG-Decke `c-ug` sichtbar. Ziehen am Bewegpunkt
// (Griff `stairBy`) nimmt das Loch mit — im EG bleibt die Treppe sichtbar; Rückgängig stellt beides in einem Schritt her.
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

async function openComplex(page: Page): Promise<void> {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });
  await expect(page.locator("svg.plan-svg").first()).toBeVisible({ timeout: 30_000 });
}

const nav = (page: Page, name: string) => page.locator(".nav-row").filter({ hasText: name }).first();
const info = (page: Page) => page.evaluate(() => window.__dossierTest!.stairHole("tr-wendel", "c-ug"));

test("Wendeltreppe ziehen: Deckenloch wandert mit, im EG weiterhin sichtbar", async ({ page }) => {
  test.setTimeout(150_000);
  await openComplex(page);
  await openTab(page, "Zeichnungsebenen");
  await nav(page, "Erdgeschoss").click();
  await expect.poll(async () => (await info(page)).lines).toBeGreaterThan(10);
  const before = await info(page);
  expect(before.center).toEqual({ x: 15.3, y: 5 });

  // Im EG wählen und am Bewegpunkt (Zentrum der Wendeltreppe) um rund 1 m nach Westen ziehen.
  await blurFocus(page);
  await page.evaluate(() => window.__dossierTest!.select({ stairs: ["tr-wendel"] }));
  const a = await screenOf(page, 15.3, 5);
  const b = await screenOf(page, 14.3, 5);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, a.y + 3, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();

  await expect.poll(async () => (await info(page)).center!.x).toBeLessThan(14.8);
  const after = await info(page);
  // Loch um denselben Vektor verschoben wie die Treppe.
  const d = { x: after.center!.x - 15.3, y: after.center!.y - 5 };
  expect(Math.abs(after.hole0!.x - (before.hole0!.x + d.x))).toBeLessThan(1e-6);
  expect(Math.abs(after.hole0!.y - (before.hole0!.y + d.y))).toBeLessThan(1e-6);
  // Im EG weiterhin sichtbar (vorher: nichts mehr, weil das Loch stehen blieb).
  expect(after.lines).toBeGreaterThan(10);

  // Rückgängig: jeder Schritt nimmt Treppe und Loch zusammen zurück (Loch bleibt relativ zur Treppe gleich), bis
  // zur Ausgangslage. (Mehrere Schritte nur, weil im Container ein Mausschritt länger dauert als das
  // Koaleszenz-Fenster von 400 ms.)
  const rel = (q: Awaited<ReturnType<typeof info>>) => ({ x: q.hole0!.x - q.center!.x, y: q.hole0!.y - q.center!.y });
  await page.keyboard.press("Escape");
  await blurFocus(page);
  const home = async () => Math.abs((await info(page)).center!.x - 15.3) + Math.abs((await info(page)).center!.y - 5) < 1e-9;
  for (let i = 0; i < 30 && !(await home()); i++) {
    await page.keyboard.press("ControlOrMeta+z");
    await page.waitForTimeout(100);
    const r = rel(await info(page));
    expect(Math.abs(r.x - rel(before).x) + Math.abs(r.y - rel(before).y)).toBeLessThan(1e-6);
  }
  expect(await home()).toBe(true);
  const end = await info(page);
  expect(Math.abs(end.hole0!.x - before.hole0!.x) + Math.abs(end.hole0!.y - before.hole0!.y)).toBeLessThan(1e-9);
});
