// Zeichnen auf dem Layout-Blatt = Zeichnen im Grundriss (Wartungs-Feedback 29.10.: „es sollte sich
// genau gleich wie im normalen Ausschnitt anfühlen/sein"). Das Blatt ist die Blatt-Ebene des Layouts
// in derselben Plan-Ansicht: dieselbe Maus-/Tastenfolge erzeugt dort dieselben Elemente, mit Fang,
// Griffen und einem Undo-Schritt je Element. Bildschirm-Punkte aus der viewBox-Abbildung des
// SVG-Overlays (x·90, −y·90 minus lokalem Ursprung, s. `planView/overlayOrigin.ts`).
import type { Page } from "@playwright/test";
import { blurFocus, expect, openTab, startNewProject, test } from "./app";

type Pt = { x: number; y: number };

/** Bisherige Rückgängig-Schritte (Panel „Verlauf", ohne Ausgangsstand und wiederholbare). */
function doneSteps(page: Page) {
  return page.locator("[data-testid=history-panel] .history-row:not(.future)").filter({ hasNotText: "Ausgangsstand" });
}

async function openHistory(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Bearbeiten", exact: true }).click();
  await page.getByRole("option", { name: "Verlauf" }).click();
  await expect(page.locator("[data-testid=history-panel]")).toBeVisible();
  // Schwebendes Fenster aus dem Weg (über das rechte Dock) ziehen.
  const title = page.locator("section[aria-label=Verlauf] .floating-title");
  const tb = await title.boundingBox();
  if (tb && tb.x < 1250) {
    await page.mouse.move(tb.x + 10, tb.y + tb.height / 2);
    await page.mouse.down();
    await page.mouse.move(1300, 760, { steps: 5 });
    await page.mouse.up();
  }
}

/** Sichtbarer Bereich der Plan-Ansicht (Client-Pixel). */
async function planBox(page: Page) {
  return (await page.locator("svg.plan-svg").boundingBox())!;
}

/** Client-Pixel → Modellpunkt (m) über die viewBox der Plan-Ansicht. */
async function modelOf(page: Page, p: Pt): Promise<Pt> {
  return page.locator("svg.plan-svg").evaluate(
    (el, [cx, cy]) => {
      const [vx, vy, vw, vh] = el.getAttribute("viewBox")!.split(/\s+/).map(Number);
      const ox = Number(el.getAttribute("data-origin-x") ?? 0);
      const oy = Number(el.getAttribute("data-origin-y") ?? 0);
      const r = el.getBoundingClientRect();
      const s = Math.min(r.width / vw, r.height / vh);
      const lx = (cx - r.left - (r.width - vw * s) / 2) / s + vx + ox;
      const ly = (cy - r.top - (r.height - vh * s) / 2) / s + vy + oy;
      return { x: lx / 90, y: -ly / 90 };
    },
    [p.x, p.y],
  );
}

/** Mittelpunkte der gezeichneten Griffe (Client-Pixel). */
async function gripCenters(page: Page): Promise<Pt[]> {
  return page.locator(".plan-grip").evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }),
  );
}

async function pickTool(page: Page, name: string, prompt: string | RegExp): Promise<void> {
  await page.getByRole("button", { name, exact: true }).click();
  await expect(page.locator(".cmdline-prompt")).toHaveText(prompt);
}

async function clickAt(page: Page, p: Pt): Promise<void> {
  await page.mouse.move(p.x - 6, p.y - 6);
  await page.mouse.move(p.x, p.y, { steps: 3 });
  await page.mouse.click(p.x, p.y);
}

/** Zeichenzug beenden wie im Grundriss: leeres Enter in der Befehlszeile. */
async function finish(page: Page): Promise<void> {
  await page.locator(".cmdline-input").press("Enter");
  await expect(page.locator(".cmdline-prompt")).toHaveText("Befehl:");
}

/**
 * Dieselbe Folge wie im Grundriss: Linie (2 Klicks), Polylinie (3 Klicks + Enter), Rechteck
 * (2 Klicks), alles relativ zum Rahmen `f` (Client-Pixel). Danach: zweite Linie, deren Start 4 px
 * neben dem Ende der ersten Linie liegt — der Fang muss auf den Endpunkt ziehen.
 */
async function drawSequence(page: Page, f: { x: number; y: number; w: number; h: number }, base: number) {
  const steps = (n: number) => expect(doneSteps(page)).toHaveCount(base + n);
  const at = (u: number, v: number): Pt => ({ x: f.x + u * f.w, y: f.y + v * f.h });
  await pickTool(page, "Linie", /Startpunkt/);
  await clickAt(page, at(0.1, 0.15));
  await clickAt(page, at(0.45, 0.15));
  await finish(page);
  await steps(1);
  await pickTool(page, "Polylinie", /Startpunkt|Erster Punkt/);
  await clickAt(page, at(0.1, 0.35));
  await clickAt(page, at(0.3, 0.5));
  await clickAt(page, at(0.45, 0.35));
  await finish(page);
  await steps(2);
  await pickTool(page, "Rechteck", /Ecke|Startpunkt/);
  await clickAt(page, at(0.55, 0.15));
  await clickAt(page, at(0.9, 0.5));
  if ((await page.locator(".cmdline-prompt").textContent()) !== "Befehl:") await finish(page);
  await steps(3);

  // Fang: 4 px neben dem Endpunkt der ersten Linie → die Marke sitzt genau auf dem Endpunkt.
  const end = at(0.45, 0.15);
  await pickTool(page, "Linie", /Startpunkt/);
  await page.mouse.move(end.x + 4, end.y + 3, { steps: 4 });
  const marker = page.locator(".snap-marker .snap-glyph").first();
  await expect(marker).toBeVisible();
  const mb = (await marker.boundingBox())!;
  expect(Math.hypot(mb.x + mb.width / 2 - end.x, mb.y + mb.height / 2 - end.y)).toBeLessThan(1.5);
  await page.mouse.click(end.x + 4, end.y + 3);
  await clickAt(page, at(0.45, 0.3));
  await finish(page);
  await steps(4);
  return { at, end };
}

/** Elemente nacheinander rückgängig machen und wiederholen: je Element genau ein Schritt. */
async function undoEach(page: Page, base: number, n: number) {
  await blurFocus(page);
  for (let i = n; i > 0; i--) {
    await expect(doneSteps(page)).toHaveCount(base + i);
    await page.keyboard.press("ControlOrMeta+z");
  }
  await expect(doneSteps(page)).toHaveCount(base);
  for (let i = 1; i <= n; i++) {
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(doneSteps(page)).toHaveCount(base + i);
  }
}

/** Neues A4-Layout anlegen und öffnen. */
async function openNewLayout(page: Page) {
  await openTab(page, "Mappe");
  await page.getByRole("button", { name: "Layout erstellen" }).first().click();
  await page.getByRole("button", { name: "Erstellen", exact: true }).click();
  await page.keyboard.press("Enter");
  await page.locator(".nav-row", { hasText: "Layout" }).first().dblclick();
  await expect(page.locator(".layout-sheet-pane")).toBeVisible();
}

/** Bildschirm-Rahmen des Papiers (aus der Blatt-Gruppe im Hintergrund der Plan-Ansicht). */
async function paperBox(page: Page) {
  return (await page.locator("[data-sheet-backdrop] > rect").nth(1).boundingBox())!;
}

for (const where of ["Grundriss", "Layout-Blatt"] as const) {
  test(`Linie, Polylinie, Rechteck, Fang, Griff, Undo — ${where}`, async ({ page }) => {
    await startNewProject(page);
    let frame;
    if (where === "Layout-Blatt") {
      await openNewLayout(page);
      frame = await paperBox(page);
      // Das ganze Blatt ist eingepasst und sichtbar.
      const pb = await planBox(page);
      expect(frame.width).toBeGreaterThan(200);
      expect(frame.x).toBeGreaterThan(pb.x);
      expect(frame.y + frame.height).toBeLessThan(pb.y + pb.height);
    } else {
      const pb = await planBox(page);
      frame = { x: pb.x + pb.width * 0.3, y: pb.y + pb.height * 0.15, width: pb.width * 0.4, height: pb.height * 0.6 };
    }
    await openHistory(page);
    const base = await doneSteps(page).count();
    const f = { x: frame.x, y: frame.y, w: frame.width, h: frame.height };
    const { at, end } = await drawSequence(page, f, base);

    // Die zweite Linie beginnt exakt im Endpunkt der ersten: ihr Griff liegt auf dem Endpunkt.
    // Zurück zur Auswahl wie im Grundriss (Werkzeug „Auswahl").
    await page.getByRole("button", { name: "Auswahl", exact: true }).click();
    await blurFocus(page);
    const mid2 = at(0.45, 0.225);
    await page.mouse.click(mid2.x, mid2.y);
    await expect(page.locator(".plan-grip")).toHaveCount(2);
    const g = await gripCenters(page);
    expect(Math.min(...g.map((p) => Math.hypot(p.x - end.x, p.y - end.y)))).toBeLessThan(1);
    const m = await modelOf(page, end);
    // Sheet: Papier 1:1 in Metern (Ursprung oben links → y negativ), Grundriss: beliebig.
    if (where === "Layout-Blatt") expect(m.y).toBeLessThan(0);

    await page.screenshot({ path: `test-results/layout-sheet-${where === "Grundriss" ? "plan" : "sheet"}.png` });

    // Griff: Rechteck wählen, Ecke ziehen (Klick-Ziehen-Klick wie im Grundriss) → breiter; Undo.
    const rectEdge = at(0.9, 0.3);
    await page.mouse.click(rectEdge.x, rectEdge.y);
    await expect(page.locator(".plan-grip").first()).toBeVisible();
    const width = page.locator(".objinfo-field").filter({ hasText: "Breite" }).locator("input");
    await openTab(page, "Objekt-Info");
    const w0 = Number(await width.inputValue());
    const corner = at(0.9, 0.5);
    const to = at(0.97, 0.5);
    await page.mouse.move(corner.x, corner.y);
    await page.mouse.down();
    await page.mouse.move((corner.x + to.x) / 2, corner.y, { steps: 4 });
    await page.mouse.move(to.x, to.y, { steps: 4 });
    await page.mouse.up();
    await page.mouse.click(to.x, to.y);
    await expect.poll(async () => Number(await width.inputValue())).toBeGreaterThan(w0 * 1.1);
    await blurFocus(page);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => Number(await width.inputValue())).toBeCloseTo(w0, 6);

    // Undo je Element ein Schritt (4 Elemente).
    await page.keyboard.press("Escape");
    await openHistory(page);
    await undoEach(page, base, 4);
  });
}
