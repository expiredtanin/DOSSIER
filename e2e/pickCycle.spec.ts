// [137] Alles Sichtbare anwählbar, Teil Plan/Blatt: (1) Klick-Zyklus in der dichten Situation 1:500 — ein
// erneuter Klick an derselben Stelle wählt das nächste Objekt darunter (Bemassung → … → Schatten → Gelände),
// die Statusleiste zeigt „n/m Treffer"; (2) Präsentationsplan: Massstabsbalken als Gruppe wählen, verschieben,
// löschen; Schriftfeld anklicken und die Plan-Nr. ändern. Bildschirm-Punkte aus der viewBox-Abbildung des
// SVG-Overlays wie in `siteSelect.spec.ts`; Projekt-Daten über die Test-Naht `?dossierTest`.
import type { Page } from "@playwright/test";
import { blurFocus, discardIfAsked, expect, fileMenu, openTab, showSnapshot, test, typeCommand } from "./app";
import type {} from "../src/state/testHooks";

test.use({ viewport: { width: 1600, height: 1000 } });

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

async function openComplex(page: Page): Promise<void> {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });
}

const objInfo = (page: Page) => page.locator(".objinfo-panel").first();

test("Situation 1:500: erneuter Klick schaltet durch Bemassung, Schatten und Gelände", async ({ page }) => {
  test.setTimeout(120_000);
  await openComplex(page);
  await openTab(page, "Objekt-Info");
  await showSnapshot(page, "Situation 1:500");
  await expect(page.locator("svg.plan-svg").first()).toBeVisible({ timeout: 30_000 });
  const hint = page.getByTestId("status-hint");
  // Südfassade: Fensterbemassung über Baugrube, Schatten, Gelände, Höhenlinien und Parzelle.
  await expect(async () => {
    await page.keyboard.press("Escape");
    const p = await screenAt(page, 9.2, -1.19);
    await page.mouse.click(p.x, p.y);
    await expect(hint).toContainText(/^1\/\d+ Treffer/, { timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  const n = Number((await hint.textContent())!.match(/^1\/(\d+)/)![1]);
  expect(n).toBeGreaterThanOrEqual(3);
  const seen: string[] = [];
  for (let i = 2; i <= n; i++) {
    await page.waitForTimeout(450); // kein Doppelklick
    const p = await screenAt(page, 9.2, -1.19);
    await page.mouse.click(p.x, p.y);
    await expect(hint).toContainText(`${i}/${n} Treffer`);
    seen.push((await objInfo(page).locator(".objinfo-kind").first().textContent().catch(() => "")) ?? "");
    if (await objInfo(page).getByTestId("terrain-smooth").isVisible()) seen.push("terrain");
  }
  expect(seen).toContain("Schatten (Sonnenstand)");
  expect(seen).toContain("terrain");
  // Nach dem letzten wieder der erste Treffer.
  await page.waitForTimeout(450);
  const p = await screenAt(page, 9.2, -1.19);
  await page.mouse.click(p.x, p.y);
  await expect(hint).toContainText(`1/${n} Treffer`);
  // Escape hebt die Auswahl auf, der Hinweis verschwindet.
  await page.keyboard.press("Escape");
  await expect(hint).not.toContainText("Treffer");
});

test("Präsentationsplan: Massstabsbalken als Ganzes wählen, verschieben, löschen; Schriftfeld bearbeiten", async ({ page }) => {
  test.setTimeout(120_000);
  await openComplex(page);
  await typeCommand(page, "praesentationsplan");
  const dialog = page.getByRole("dialog", { name: "Präsentationsplan" });
  await expect(dialog).toBeVisible();
  await dialog.locator("[data-testid=presentation-create]").click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("[data-viewport-id]").first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1000);

  const bar = () => page.evaluate(() => window.__dossierTest!.polylines("d-pres-").filter((d) => /-s\d$/.test(d.id)));
  const before = await bar();
  expect(before.length).toBe(5);
  const field = before[0].pts;
  const cx = (field[0].x + field[2].x) / 2;
  const cy = (field[0].y + field[2].y) / 2;
  // Heranzoomen (der Balken ist auf dem ganzen A1-Blatt nur wenige Pixel hoch).
  const z = await screenAt(page, cx, cy);
  await page.mouse.move(z.x, z.y);
  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel(0, -200);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(500);
  // Klick auf ein Feld des Balkens wählt die ganze Gruppe (5 Felder + 2 Beschriftungen).
  await expect(async () => {
    await page.keyboard.press("Escape");
    const p = await screenAt(page, cx, cy);
    await page.mouse.click(p.x, p.y);
    const sel = await page.evaluate(() => window.__dossierTest!.selected());
    expect(sel.groups.some((g) => g.endsWith("-s"))).toBe(true);
    expect(sel.drawings.length).toBe(7);
  }).toPass({ timeout: 20_000 });

  // Ziehen verschiebt alle Teile gleich.
  const p = await screenAt(page, cx, cy);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 30, p.y + 10, { steps: 5 });
  await page.mouse.move(p.x + 60, p.y + 20, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await bar())[0].pts[0].x).not.toBeCloseTo(before[0].pts[0].x, 5);
  const moved = await bar();
  const dx = moved[0].pts[0].x - before[0].pts[0].x;
  expect(dx).toBeGreaterThan(0);
  for (const [i, d] of moved.entries()) expect(d.pts[2].x - before[i].pts[2].x).toBeCloseTo(dx, 6);

  // Entf löscht den ganzen Balken.
  await blurFocus(page);
  await page.keyboard.press("Delete");
  await expect.poll(async () => (await bar()).length).toBe(0);

  // Schriftfeld (unten rechts, A1 quer 841 × 594 mm): anklicken, Plan-Nr. setzen.
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Einpassen", exact: true }).click();
  await page.waitForTimeout(500);
  const tb = await screenAt(page, (841 - 40) / 1000, -(594 - 20) / 1000);
  await page.mouse.click(tb.x, tb.y);
  const hud = page.getByTestId("titleblock-hud");
  await expect(hud).toBeVisible();
  await hud.locator("[data-tb-field=planNumber]").fill("A-07");
  await expect(page.locator("[data-sheet-backdrop]")).toContainText("A-07");
});
