// [147]/[204] Plan öffnet nicht zu stark gezoomt: neues Projekt = Standardansicht, Muster = eingepasst.
import type { Page } from "@playwright/test";
import { discardIfAsked, expect, fileMenu, startNewProject, test } from "./app";

/** Papier-Massstab-Nenner (96 dpi) und viewBox des grössten SVG (= Plan). */
async function view(page: Page) {
  const m = await page.evaluate(() => {
    const all = [...document.querySelectorAll("svg[viewBox]")] as SVGSVGElement[];
    const area = (e: Element) => e.getBoundingClientRect().width * e.getBoundingClientRect().height;
    const el = all.sort((a, b) => area(b) - area(a))[0];
    const vb = (el.getAttribute("viewBox") ?? "").split(/[ ,]+/).map(Number);
    const r = el.getBoundingClientRect();
    return { vb, pxPerM: Math.min(r.width / vb[2], r.height / vb[3]) * 90 };
  });
  return { ...m, n: (1000 * 96) / 25.4 / m.pxPerM };
}

const sane = (n: number, label: string) => {
  // Papier-Massstab zwischen ca. 1:30 und 1:400 (nicht „1:9 / 1111 %").
  expect(n, label).toBeGreaterThan(30);
  expect(n, label).toBeLessThan(400);
};
/** Rechteck (Modell-m) liegt ganz im sichtbaren Ausschnitt (y gespiegelt). */
const shows = (vb: number[], x0: number, y0: number, x1: number, y1: number) =>
  vb[0] <= x0 * 90 && vb[0] + vb[2] >= x1 * 90 && vb[1] <= -y1 * 90 && vb[1] + vb[3] >= -y0 * 90;

test("Startzoom: neues Projekt, Muster und komplexes Muster passen sich ein", async ({ page }) => {
  test.setTimeout(120_000);
  await startNewProject(page);
  await page.waitForTimeout(800);
  const m0 = await view(page);
  sane(m0.n, "neues Projekt");
  expect(shows(m0.vb, 0, 0, 10, 10), "neues Projekt: Ursprung und 10 m sichtbar").toBe(true);

  await fileMenu(page, /^Neu aus Vorlage: Musterhaus$/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Demo-Haus");
  await page.waitForTimeout(1200);
  const m1 = await view(page);
  sane(m1.n, "Musterhaus");
  expect(shows(m1.vb, 1, 1, 8, 6), "Musterhaus sichtbar").toBe(true);

  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });
  await page.waitForTimeout(1500);
  const m2 = await view(page);
  sane(m2.n, "Musterhaus komplex");
  expect(shows(m2.vb, 0, 0, 15, 10), "Musterhaus komplex sichtbar").toBe(true);
  // [204] Auf das Gebäude eingepasst, nicht auf das ganze Kataster (vorher 1:375, das Haus winzig).
  expect(m2.n, "Musterhaus komplex: aufs Gebäude, nicht aufs Kataster eingepasst").toBeLessThan(200);
});
