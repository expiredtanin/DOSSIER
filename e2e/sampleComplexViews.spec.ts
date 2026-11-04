// Musterhaus komplex ([133]): jeder gespeicherte Grundriss-Ausschnitt öffnet mit sinnvollem Zoom und zeigt das
// Gebäude (Haupthaus 0…15 × 0…10 m) — auch beim Wechsel aus Detail, 3D, Schnitt und Ansicht zurück.
import { discardIfAsked, expect, fileMenu, startNewProject, test } from "./app";

// [Name, Massstab-Nenner]
const PLANS: [string, number][] = [["UG 1:100", 100], ["EG 1:100", 100], ["OG 1:100", 100], ["DG 1:100", 100], ["EG 1:50 Ausschnitt Wohnen", 50], ["Situation 1:500", 500], ["EG Brandschutz", 100]];
// Zwischenstationen: danach muss EG 1:100 wieder sauber öffnen.
const DETOURS = ["Detail Deckenauflager 1:10", "Axonometrie Südost", "Schnitt A-A", "Ansicht Süd"];
const PX_PER_M = 90; // viewBox-Einheiten je Meter (geometry.ts)

test.use({ viewport: { width: 1600, height: 1000 } });

test("Musterhaus komplex: gespeicherte Grundriss-Ausschnitte öffnen mit sinnvollem Zoom", async ({ page }) => {
  test.setTimeout(240_000);
  const shots = process.env.DOSSIER_SHOTS;
  await startNewProject(page);
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });
  const tabs = page.getByRole("tablist", { name: "Zeichnungen" });
  const tab = (name: string) => tabs.getByRole("tab", { name: `${name} Ausschnitt-Tab löschen`, exact: true });

  const check = async (name: string, scale = 100) => {
    await tab(name).click();
    const svg = page.locator("svg.plan-svg").first();
    await expect(svg).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(800);
    const m = await svg.evaluate((el) => {
      const vb = (el.getAttribute("viewBox") ?? "").split(/[ ,]+/).map(Number);
      const r = el.getBoundingClientRect();
      return { vb, pxPerM: Math.min(r.width / vb[2], r.height / vb[3]) * 90 };
    });
    if (shots) await page.screenshot({ path: `${shots}/${name.replace(/[^\w]+/g, "_")}.png` });
    // Zoom im sinnvollen Rahmen (kein „1000 %") …
    expect(m.pxPerM, name).toBeGreaterThan(3);
    expect(m.pxPerM, name).toBeLessThan(80);
    // Live-Massstab = gespeicherter Massstab des Ausschnitts (±3 %).
    const live = (96 / 25.4) * 1000 / m.pxPerM;
    expect(Math.abs(live / scale - 1), name).toBeLessThan(0.03);
    // … und das Haupthaus liegt im sichtbaren Ausschnitt (y gespiegelt; 1:50 zeigt bewusst nur einen Teil).
    if (scale < 100) return;
    const [x, y, w, h] = m.vb;
    expect(x, name).toBeLessThanOrEqual(0);
    expect(x + w, name).toBeGreaterThanOrEqual(15 * PX_PER_M);
    expect(y, name).toBeLessThanOrEqual(-10 * PX_PER_M);
    expect(y + h, name).toBeGreaterThanOrEqual(0);
  };

  for (const [name, scale] of PLANS) await check(name, scale);
  for (const detour of DETOURS) {
    await tab(detour).click();
    await page.waitForTimeout(1000);
    await check("EG 1:100");
  }
});
