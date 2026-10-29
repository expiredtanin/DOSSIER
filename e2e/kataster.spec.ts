// Kataster aus DXF/DWG (Fehlerbericht 29.10.: „importierte Geometrien lassen sich nach dem Anwählen
// nicht mehr verändern, sie haben keine Eckpunkte"). Fixture: kleiner AV-artiger Ausschnitt in LV95
// (`fixtures/kataster.dxf`: Parzellen als geschlossene LWPOLYLINE teils mit Bögen, Grenzpunkte als
// INSERT mit ATTRIB, Nummern als TEXT/MTEXT, Gebäude mit HATCH, Strassenparzelle mit Bögen).
// Gewählt wird per Klick in den Plan (das Picken läuft im Kern auf dem Plan-Puffer, headless ok);
// Bildschirm-Punkte aus der viewBox-Abbildung des SVG-Overlays (`toScreen`: x·90, −y·90).
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
      const r = el.getBoundingClientRect();
      const s = Math.min(r.width / vw, r.height / vh);
      return {
        x: r.left + (r.width - vw * s) / 2 + (x * 90 - vx) * s,
        y: r.top + (r.height - vh * s) / 2 + (-y * 90 - vy) * s,
      };
    },
    [E0 + dx, N0 + dy],
  );
}

async function clickModel(page: Page, dx: number, dy: number): Promise<void> {
  const p = await screenOf(page, dx, dy);
  await page.mouse.click(p.x, p.y);
}

/** Ein gezeichneter Griff liegt (± 3 px) am Bildschirmort des Modellpunkts. */
async function expectGripAt(page: Page, dx: number, dy: number): Promise<void> {
  const want = await screenOf(page, dx, dy);
  const boxes = await page.locator(".plan-grip").evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }),
  );
  const d = Math.min(...boxes.map((b) => Math.hypot(b.x - want.x, b.y - want.y)));
  expect(d, `Griff bei ${dx}/${dy}: nächster gezeichneter ${d.toFixed(1)} px entfernt`).toBeLessThan(3);
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
