// [137] Alles Sichtbare anwählbar (Mac-Befund: „Schatten und gewachsenes Terrain lassen sich nicht anwählen
// und bearbeiten"): im Musterhaus komplex das Gelände (Situation 1:500) und einen Schatten (EG 1:100) per
// Klick in den Plan wählen; die Objekt-Info zeigt ihre Einstellungen, je eine wird geändert und rückgängig
// gemacht. Gepickt wird im Kern auf dem Plan-Puffer (headless ok); Bildschirm-Punkte aus der viewBox-
// Abbildung des SVG-Overlays wie in `kataster.spec.ts`.
import type { Page } from "@playwright/test";
import { blurFocus, discardIfAsked, expect, fileMenu, openTab, showSnapshot, startNewProject, test } from "./app";

async function clickModel(page: Page, x: number, y: number): Promise<void> {
  const p = await page.locator("svg.plan-svg").first().evaluate(
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
  await page.mouse.click(p.x, p.y);
}

const objInfo = (page: Page) => page.locator(".objinfo-panel").first();

test("Musterhaus komplex: Gelände und Schatten anwählen und bearbeiten (mit Undo)", async ({ page }) => {
  test.setTimeout(120_000);
  await startNewProject(page);
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });
  await openTab(page, "Objekt-Info");

  // Gelände: Situation 1:500, Klick in den Garten (Südwest, innerhalb der Parzelle, weg von Linien).
  await showSnapshot(page, "Situation 1:500");
  await expect(page.locator("svg.plan-svg").first()).toBeVisible({ timeout: 30_000 });
  const smooth = objInfo(page).getByTestId("terrain-smooth");
  await expect(async () => {
    await page.keyboard.press("Escape");
    await clickModel(page, -12, -10);
    await expect(smooth).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  await expect(objInfo(page)).toContainText("Gelände");
  await expect(objInfo(page).getByTestId("terrain-visible")).toBeChecked();
  await expect(smooth).toHaveValue("2");
  await smooth.selectOption("0");
  await expect(smooth).toHaveValue("0");
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(smooth).toHaveValue("2");
  // Nur dieses Netz ausblenden (Kategorie bleibt an), Undo blendet es wieder ein.
  const meshVisible = objInfo(page).getByTestId("terrain-mesh-visible");
  await expect(meshVisible).toBeChecked();
  await meshVisible.uncheck();
  await expect(meshVisible).not.toBeChecked();
  await expect(objInfo(page).getByTestId("terrain-visible")).toBeChecked();
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(meshVisible).toBeChecked();

  // Schatten: EG 1:100, Klick nördlich des Eingangs (Schlagschatten am 21. Juni, 10 Uhr).
  await showSnapshot(page, "EG 1:100");
  await openTab(page, "Objekt-Info");
  const time = objInfo(page).locator(".sun-time");
  await expect(async () => {
    await page.keyboard.press("Escape");
    await clickModel(page, 0, 15);
    await expect(time).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  await expect(objInfo(page)).toContainText("Schatten (Sonnenstand)");
  await expect(time).toHaveText("10:00");
  await objInfo(page).getByRole("slider", { name: "Uhrzeit" }).fill("840");
  await expect(time).toHaveText("14:00");
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(time).toHaveText("10:00");
});
