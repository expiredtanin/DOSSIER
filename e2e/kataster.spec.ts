// Kataster aus DXF/DWG (Fehlerbericht 29.10.: „importierte Geometrien lassen sich nach dem Anwählen
// nicht mehr verändern, sie haben keine Eckpunkte"). Fixture: kleiner AV-artiger Ausschnitt in LV95
// (`fixtures/kataster.dxf`: Parzellen als geschlossene LWPOLYLINE teils mit Bögen, Grenzpunkte als
// INSERT mit ATTRIB, Nummern als TEXT/MTEXT, Gebäude mit HATCH, Strassenparzelle mit Bögen).
// Gewählt wird per Klick in den Plan (das Picken läuft im Kern auf dem Plan-Puffer, headless ok);
// Bildschirm-Punkte aus der viewBox-Abbildung des SVG-Overlays (`toScreen`: x·90, −y·90, minus
// lokalem Ursprung `data-origin-x/y`, s. `planView/overlayOrigin.ts`).
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { blurFocus, expect, fileMenu, startNewProject, test } from "./app";
import { KATASTER_DXF } from "./paths";

const E0 = 2_600_000;
const N0 = 1_200_000;

/** DXF importieren (Vorgaben des Dialogs: neue Zeichnung, Ebenen als Kategorien, Landeskoordinaten). */
async function importDxf(page: Page, name: string, text: string): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await fileMenu(page, /DXF\/DWG importieren/);
  await (await chooser).setFiles({ name, mimeType: "application/dxf", buffer: Buffer.from(text, "utf8") });
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator(".imp-btn.primary").click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
}

/**
 * Modellpunkt (Versatz zu E0/N0 in m) → Client-Pixel, in f64 wie `PlanView` (`clientToView`):
 * viewBox-Attribut + Box des SVG, `meet`-Einpassung. NICHT `getScreenCTM()`: der Browser rechnet
 * SVG-Koordinaten in f32, bei LV95 (≈ 2.3e8 viewBox-Einheiten) liegt das Pixel daneben.
 */
async function screenOf(page: Page, dx: number, dy: number): Promise<{ x: number; y: number }> {
  return page.locator("svg.plan-svg").evaluate(
    (el, [x, y]) => {
      const [vx, vy, vw, vh] = el.getAttribute("viewBox")!.split(/\s+/).map(Number);
      const ox = Number(el.getAttribute("data-origin-x") ?? 0);
      const oy = Number(el.getAttribute("data-origin-y") ?? 0);
      const r = el.getBoundingClientRect();
      const s = Math.min(r.width / vw, r.height / vh);
      return {
        x: r.left + (r.width - vw * s) / 2 + (x * 90 - ox - vx) * s,
        y: r.top + (r.height - vh * s) / 2 + (-y * 90 - oy - vy) * s,
      };
    },
    [E0 + dx, N0 + dy],
  );
}

async function clickModel(page: Page, dx: number, dy: number): Promise<void> {
  const p = await screenOf(page, dx, dy);
  await page.mouse.click(p.x, p.y);
}

/** Abstand (px) des nächsten gezeichneten Griffs zum Bildschirmort des Modellpunkts. */
async function gripOffset(page: Page, dx: number, dy: number): Promise<number> {
  const want = await screenOf(page, dx, dy);
  const boxes = await page.locator(".plan-grip").evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }),
  );
  return Math.min(...boxes.map((b) => Math.hypot(b.x - want.x, b.y - want.y)));
}

/** Ein gezeichneter Griff liegt (± 1 px) am Bildschirmort des Modellpunkts. */
async function expectGripAt(page: Page, dx: number, dy: number): Promise<void> {
  // Griffe werden nach Zoom/Pan neu gezeichnet: auf den Endzustand warten (±1 px bleibt die Aussage).
  let d = Number.POSITIVE_INFINITY;
  await expect
    .poll(async () => (d = await gripOffset(page, dx, dy)), {
      message: `Griff bei ${dx}/${dy}: nächster gezeichneter ${d.toFixed(2)} px entfernt`,
    })
    .toBeLessThan(1);
}

/** Breite des Ausschnitts in Metern (viewBox-Breite / 90). */
async function viewWidthM(page: Page): Promise<number> {
  const vb = await page.locator("svg.plan-svg").getAttribute("viewBox");
  return Number(vb!.split(/\s+/)[2]) / 90;
}

/** viewBox-Attribut, sobald es sich über zwei Abfragen im Abstand > Festschreibe-Pause nicht ändert. */
async function settledViewBox(page: Page): Promise<string> {
  const read = () => page.locator("svg.plan-svg").getAttribute("viewBox") as Promise<string>;
  let last = await read();
  let stable = 0;
  // Rad-Zoom wird imperativ angewandt und erst nach 70 ms Ruhe festgeschrieben; unter Last
  // dauert das länger — also auf beobachtbaren Zustand warten statt feste Pausen.
  await expect
    .poll(
      async () => {
        const now = await read();
        stable = now === last ? stable + 1 : 0;
        last = now;
        return stable;
      },
      { timeout: 15_000, intervals: [120] },
    )
    .toBeGreaterThanOrEqual(2);
  return last;
}

/**
 * Mit dem Mausrad um den Modellpunkt hineinzoomen, bis der Ausschnitt höchstens `widthM` breit ist.
 * Mehrere Rad-Ereignisse pro Runde (der Anker bleibt am selben Bildschirmpunkt), danach warten,
 * bis die viewBox festgeschrieben ist — erst dann wird der Punkt neu berechnet.
 */
async function zoomTo(page: Page, dx: number, dy: number, widthM: number): Promise<void> {
  for (let k = 0; k < 40 && (await viewWidthM(page)) > widthM; k++) {
    const p = await screenOf(page, dx, dy);
    await page.mouse.move(p.x, p.y);
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -400);
    await settledViewBox(page);
  }
  await settledViewBox(page);
  expect(await viewWidthM(page)).toBeLessThanOrEqual(widthM);
}

const widthField = (page: Page) => page.locator(".objinfo-field").filter({ hasText: "Breite" }).locator("input");

test("Kataster-DXF in LV95: Parzelle anklicken, Eckgriff ziehen, Rückgängig", async ({ page }) => {
  await startNewProject(page);
  await importDxf(page, "kataster.dxf", await readFile(KATASTER_DXF, "utf8"));

  // Parzelle oben rechts (38..68 × 38..68 m): linke Kante anklicken.
  await clickModel(page, 38, 53);
  await expect(widthField(page)).toHaveValue("30.000");
  // 4 Eckgriffe (gerade Kanten: keine Bogen-Mitten-Griffe).
  await expect(page.locator(".plan-grip")).toHaveCount(4);
  // Die Griffe liegen sichtbar auf den Ecken (früher: `<circle cx>` mit LV95-Koordinaten, vom
  // Browser als CSS-Länge auf ±33.5 Mio. geklemmt → weit ausserhalb des Bildes).
  await expectGripAt(page, 68, 68);
  await expectGripAt(page, 38, 38);
  await expectGripAt(page, 38, 68);

  // Ecke oben rechts 5 m nach rechts ziehen → 35 m breit. Der Griff bleibt nach dem Loslassen
  // „bewaffnet" und folgt dem Cursor; abgeschlossen wird mit einem zweiten Klick.
  const from = await screenOf(page, 68, 68);
  const to = await screenOf(page, 73, 68);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, from.y, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  await page.mouse.click(to.x, to.y);
  await expect(widthField(page)).toHaveValue("35.000");

  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(widthField(page)).toHaveValue("30.000");
});

test("Kataster: Strassenparzelle mit Bögen bleibt Bogen-Polylinie und hat Griffe", async ({ page }) => {
  await startNewProject(page);
  await importDxf(page, "kataster.dxf", await readFile(KATASTER_DXF, "utf8"));
  // Ecke der Strassenparzelle (22 Stützpunkte, jedes Segment ein Bogen) anklicken.
  await clickModel(page, -6 + 3 * 8, -3);
  await expect(widthField(page)).toHaveValue("80.000");
  // 22 Ecken + 22 Bogen-Mitten (früher: über 100 zerlegte Punkte, ohne Bogen-Griffe).
  await expect(page.locator(".plan-grip")).toHaveCount(44);
});

test("Kataster: einzeln gewähltes Element mit über 600 Stützpunkten bekommt Griffe", async ({ page }) => {
  await startNewProject(page);
  // Waldrand (Bodenbedeckung) mit 700 Stützpunkten an die Fixture anhängen: früher keine Griffe
  // (die Grenze von 600 Stützpunkten galt auch für ein einzelnes Element).
  const ring: string[] = [];
  for (let k = 0; k < 700; k++) {
    const a = (2 * Math.PI * k) / 700;
    const r = 20 + 2 * Math.sin(12 * a);
    ring.push("10", (E0 + 140 + r * Math.cos(a)).toFixed(3), "20", (N0 + 30 + r * Math.sin(a)).toFixed(3));
  }
  const wald = ["0", "LWPOLYLINE", "8", "BB_Wald", "90", "700", "70", "1", ...ring].join("\n");
  const text = (await readFile(KATASTER_DXF, "utf8")).replace(/0\nENDSEC\n0\nEOF\n?$/, `${wald}\n0\nENDSEC\n0\nEOF\n`);
  await importDxf(page, "kataster-wald.dxf", text);

  await clickModel(page, 140 + 20, 30); // Stützpunkt k = 0 des Waldrands
  await expect(widthField(page)).toHaveValue(/^4\d\.\d{3}$/);
  const grips = page.locator(".plan-grip");
  await expect.poll(() => grips.count()).toBeGreaterThan(50);
  // Gezeichnet werden nur die sichtbaren, je Bildschirmzelle einer (gripCull.ts) — nie alle 1400.
  expect(await grips.count()).toBeLessThanOrEqual(1400);
});

test("Kataster in LV95: Griffe auf den Ecken auch stark hineingezoomt, Lineal stimmt", async ({ page }) => {
  await startNewProject(page);
  await importDxf(page, "kataster.dxf", await readFile(KATASTER_DXF, "utf8"));
  await clickModel(page, 38, 53);
  await expect(page.locator(".plan-grip")).toHaveCount(4);
  await expectGripAt(page, 68, 68);

  // Bisher (Overlay in absoluten viewBox-Einheiten, Browser rechnet f32): ~6 px bei 11 m,
  // ~80 px bei 1.5 m Ausschnitt.
  await zoomTo(page, 68, 68, 11);
  await expectGripAt(page, 68, 68);
  await zoomTo(page, 68, 68, 1);
  await expectGripAt(page, 68, 68);

  // Lineal (`<rect>`/Ticks, früher als CSS-Länge geklemmt → unsichtbar): Leiste über die ganze
  // Breite, Beschriftung oben an der richtigen Stelle (Text beginnt 3 px rechts vom Tick).
  const strip = await page.locator(".plan-ruler-strip").first().boundingBox();
  const svgBox = await page.locator("svg.plan-svg").boundingBox();
  expect(strip!.width).toBeGreaterThan(svgBox!.width - 2);
  expect(strip!.x).toBeGreaterThanOrEqual(svgBox!.x - 1);
  const labels = await page
    .locator(".plan-ruler-text:not([transform])")
    .evaluateAll((els) => els.map((e) => ({ text: e.textContent ?? "", left: e.getBoundingClientRect().left })));
  expect(labels.length).toBeGreaterThan(1);
  for (const l of labels) {
    const m = Number.parseFloat(l.text);
    expect(m).toBeGreaterThan(E0 + 66);
    expect(m).toBeLessThan(E0 + 70);
    const want = await screenOf(page, m - E0, 0);
    expect(Math.abs(l.left - (want.x + 3)), `Lineal ${l.text}`).toBeLessThan(2);
  }
});

test("Kataster: geschlossene Bogen-Polylinie hat keine Kanten-Griffe im Innern", async ({ page }) => {
  await startNewProject(page);
  await importDxf(page, "kataster.dxf", await readFile(KATASTER_DXF, "utf8"));
  // Strassenparzelle: jedes Segment ein Bogen → Bogen-Mitten-Griffe, keine Kanten-Dreiecke
  // (früher liefen die Kanten-Griffe auch über die Bogen-Mitten: Dreiecke quer durchs Innere).
  await clickModel(page, -6 + 3 * 8, -3);
  await expect(page.locator(".plan-grip")).toHaveCount(44);
  await expect(page.locator(".plan-edge-grip")).toHaveCount(0);
  // Parzelle mit geraden Kanten: genau 4 Kanten-Griffe, je auf der Kantenmitte.
  await clickModel(page, 38, 53);
  await expect(page.locator(".plan-grip")).toHaveCount(4);
  await expect(page.locator(".plan-edge-grip")).toHaveCount(4);
  // Parzelle 0..30 m mit zwei Bogen- und zwei geraden Seiten: 4 Ecken + 2 Bogen-Mitten,
  // Kanten-Griffe nur an den geraden Seiten (rechts bei x = 30, links bei x = 0).
  await clickModel(page, 30, 15);
  await expect(page.locator(".plan-grip")).toHaveCount(6);
  const edges = page.locator(".plan-edge-grip");
  await expect(edges).toHaveCount(2);
  const right = await screenOf(page, 30, 15);
  const left = await screenOf(page, 0, 15);
  const centres = await edges.evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }),
  );
  for (const c of centres) {
    const d = Math.min(Math.hypot(c.x - right.x, c.y - right.y), Math.hypot(c.x - left.x, c.y - left.y));
    expect(d, "Kanten-Griff auf einer geraden Seite").toBeLessThan(12);
  }
});

test("Kataster: Vorschau-Kreis eines Grenzpunkts (Liste beim Strg-Klick) sitzt in LV95 am Ort", async ({ page }) => {
  await startNewProject(page);
  await importDxf(page, "kataster.dxf", await readFile(KATASTER_DXF, "utf8"));
  await zoomTo(page, 30, 0, 4);
  // Grenzpunkt (Kreis r = 0.25 m um 30/0) auf dem Rand anklicken, mit Strg: Liste der Objekte.
  const at = await screenOf(page, 30.25, 0);
  await page.keyboard.down("Control");
  await page.mouse.click(at.x, at.y);
  await page.keyboard.up("Control");
  const list = page.locator(".pick-list");
  await expect(list).toBeVisible();
  // Eintrag „Kreis" überfahren → Vorschau-Kreis im Plan (`<circle>`: cx/cy/r sind CSS-Längen,
  // früher bei LV95 auf ±33.5 Mio. geklemmt und damit ausserhalb des Bildes).
  await list.getByRole("option", { name: /Kreis/ }).hover();
  const circle = page.locator(".plan-hover-pick circle");
  await expect(circle).toHaveCount(1);
  const box = (await circle.boundingBox())!;
  const c = await screenOf(page, 30, 0);
  const e = await screenOf(page, 30.25, 0);
  const rPx = e.x - c.x;
  expect(Math.abs(box.x + box.width / 2 - c.x)).toBeLessThan(1);
  expect(Math.abs(box.y + box.height / 2 - c.y)).toBeLessThan(1);
  expect(Math.abs(box.width / 2 - rPx)).toBeLessThan(3); // Box mit Strich (≈ 4 px)
});
