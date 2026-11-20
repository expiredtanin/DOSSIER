// [317] Anwählen in Schnitt- und Ansichts-Reitern: jedes Bauteil, das ein Primitiv mit Pick-Id trägt, lässt sich an
// einer Stelle, die kein anderes Bauteil überdeckt, per Klick anwählen (Selection enthält es danach). Die Klickpunkte
// kommen aus dem gezeigten Plan (Test-Naht `viewPickPoints`, [317]); Bildschirmpunkte über die viewBox des SVG-Overlays.
// Eigener Port: E2E_PORT=5192 npx playwright test e2e/sectionPick317.spec.ts
import { writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { blurFocus, discardIfAsked, expect, fileMenu, showSnapshot, test } from "./app";
import type {} from "../src/state/testHooks";

test.use({ viewport: { width: 1600, height: 1000 } });

const SEL_KIND: Record<string, string> = {
  wallId: "walls", ceilingId: "ceilings", openingId: "openings", stairId: "stairs", roofId: "roofs", columnId: "columns",
  extrudedSolidId: "solids", drawingId: "drawings", roomId: "rooms", treeId: "trees", railingId: "railings", contextObjectId: "contextObjects",
};

async function screenAt(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
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

async function open(page: Page, menu: RegExp, name: string) {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await fileMenu(page, menu);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toContainText(name, { timeout: 30_000 });
}

/** Alle Klickpunkte des gezeigten Plans anklicken; liefert die Fehlschläge (`key:id`) und die Zahl der Prüfungen. */
async function clickAll(page: Page, only?: (key: string) => boolean): Promise<{ failed: string[]; checked: number; covered: string[]; unknown: string[] }> {
  await expect(page.locator("svg.plan-svg").first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => window.__dossierTest!.viewPickPoints().length), { timeout: 30_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(800);
  const pts = await page.evaluate(() => window.__dossierTest!.viewPickPoints());
  const failed: string[] = [];
  const covered: string[] = [];
  const unknown: string[] = [];
  let checked = 0;
  for (const p of pts) {
    if (!p.known) unknown.push(`${p.key}:${p.id}`);
    if (p.covered) { covered.push(`${p.key}:${p.id}`); continue; }
    if (p.key === "roomId" || (only && !only(p.key))) continue;
    const kind = SEL_KIND[p.key];
    await blurFocus(page);
    await page.keyboard.press("Escape");
    const s = await screenAt(page, p.x, p.y);
    const box = (await page.locator("svg.plan-svg").first().boundingBox())!;
    if (s.x < box.x + 2 || s.x > box.x + box.width - 2 || s.y < box.y + 2 || s.y > box.y + box.height - 2) continue; // ausserhalb des Bildausschnitts
    await page.mouse.click(s.x, s.y);
    // Die Auswahl kann dem Klick um einen Frame hinterherhinken: bis zu 1.5 s warten, dann gilt das Ergebnis.
    let sel: Record<string, string[]> = {};
    for (let i = 0; i < 15; i++) {
      sel = await page.evaluate(() => JSON.parse(window.__dossierTest!.selected().all) as Record<string, string[]>);
      if (sel[kind]?.includes(p.id)) break;
      await page.waitForTimeout(100);
    }
    checked++;
    if (!sel[kind]?.includes(p.id)) failed.push(`${p.key}:${p.id} -> ${JSON.stringify(Object.fromEntries(Object.entries(sel).filter(([, v]) => v.length)))}`);
    await page.waitForTimeout(450); // kein Doppelklick
  }
  return { failed, checked, covered, unknown };
}

test("Schnitt und Ansicht: jedes Bauteil ist per Klick anwählbar, Pick-Ids gehören zu echten Elementen", async ({ page }) => {
  test.setTimeout(300_000);
  await open(page, /Musterhaus \(komplex\)/, "Musterhaus komplex");
  for (const n of ["Schnitt A-A", "Schnitt B-B", "Ansicht Süd"]) {
    await showSnapshot(page, n);
    const r = await clickAll(page);
    expect(r.checked, n).toBeGreaterThan(8);
    expect(r.unknown, `${n}: Pick-Id ohne Element`).toEqual([]);
    expect(r.failed, n).toEqual([]);
  }
  // Nach Zoom und Verschieben trifft der Klick weiter (Pick rechnet in Modellkoordinaten).
  const box = (await page.locator("svg.plan-svg").first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(500);
  const r = await clickAll(page);
  expect(r.checked, "nach Zoom").toBeGreaterThan(3);
  expect(r.failed, "nach Zoom").toEqual([]);
});

test("Wettbewerb: Schnitt A-A — Treppe, Decke, Wand, Dach, Zeichnung (Entourage) anwählbar", async ({ page }) => {
  test.setTimeout(300_000);
  await open(page, /^Neu aus Vorlage: Wettbewerb$/, "Wettbewerb");
  await showSnapshot(page, "Schnitt A-A");
  const r = await clickAll(page);
  expect(r.checked).toBeGreaterThan(8);
  expect(r.unknown).toEqual([]);
  expect(r.failed).toEqual([]);
});

test("Träger im Schnitt: Klick wählt Stütze/Träger, nicht eine Decke gleicher Id", async ({ page }) => {
  test.setTimeout(300_000);
  await open(page, /Musterhaus \(komplex\)/, "Musterhaus komplex");
  await showSnapshot(page, "Schnitt A-A");
  await expect.poll(() => page.evaluate(() => window.__dossierTest!.viewPickPoints().some((p) => p.key === "columnId" && p.id === "tg-eg-1")), { timeout: 30_000 }).toBe(true);
  const p = (await page.evaluate(() => window.__dossierTest!.viewPickPoints())).find((q) => q.key === "columnId" && q.id === "tg-eg-1")!;
  expect(p.known).toBe(true);
  await blurFocus(page);
  const s = await screenAt(page, p.x, p.y);
  await page.mouse.click(s.x, s.y);
  const sel = await page.evaluate(() => JSON.parse(window.__dossierTest!.selected().all) as Record<string, string[]>);
  expect(sel.columns).toContain("tg-eg-1");
  expect(sel.ceilings).toEqual([]);
});

test("Rahmen im Schnitt/in der Ansicht wählt Stützen, Dächer und Fenster mit", async ({ page }) => {
  test.setTimeout(300_000);
  await open(page, /Musterhaus \(komplex\)/, "Musterhaus komplex");
  await showSnapshot(page, "Ansicht Süd");
  await expect.poll(() => page.evaluate(() => window.__dossierTest!.viewPickPoints().length), { timeout: 30_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(800);
  const box = (await page.locator("svg.plan-svg").first().boundingBox())!;
  // Von rechts unten nach links oben (berührende Bauteile zählen), über die ganze Zeichenfläche.
  await page.mouse.move(box.x + box.width - 4, box.y + box.height - 4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
  await page.mouse.move(box.x + 4, box.y + 4, { steps: 6 });
  await page.mouse.up();
  const sel = await page.evaluate(() => JSON.parse(window.__dossierTest!.selected().all) as Record<string, string[]>);
  expect(sel.walls.length).toBeGreaterThan(0);
  expect(sel.columns.length).toBeGreaterThan(0);
  expect(sel.roofs.length).toBeGreaterThan(0);
  expect(sel.openings.length).toBeGreaterThan(0);
});

test.describe("Erkundung", () => {
  test.skip(!process.env.SURVEY317, "schreibt /tmp/a317/pick.json");
  test("Anwahl je Bauteil in Schnitt und Ansicht", async ({ page }) => {
    test.setTimeout(1_200_000);
    const res: Record<string, unknown> = {};
    await open(page, /Musterhaus \(komplex\)/, "Musterhaus komplex");
    for (const n of ["Schnitt A-A", "Schnitt B-B", "Ansicht Süd", "Ansicht Ost"]) {
      await showSnapshot(page, n);
      res[`komplex ${n}`] = await clickAll(page);
      writeFileSync("/tmp/a317/pick.json", JSON.stringify(res, null, 1));
    }
  });
});
