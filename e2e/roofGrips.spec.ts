// [26] Dach im Grundriss: Eckgriffe am gewählten Dach (Umriss, hier ein Rechteck), Eckgriff ziehen (der Umriss
// wird schief, kein Rechteck erzwungen), Rückgängig stellt ihn her. Bildschirm-Punkte wie in sectionBend.spec.ts.
import type { Page } from "@playwright/test";
import { blurFocus, elementRows, expect, openSample, openTab, startNewProject, test } from "./app";

async function gripCentres(page: Page): Promise<{ x: number; y: number }[]> {
  const c = await page.locator(".plan-grip").evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }),
  );
  return c.sort((a, b) => a.x - b.x || a.y - b.y);
}

/** Griff ziehen: ein Griff bleibt nach dem Loslassen „bewaffnet" und folgt dem Zeiger, bis ein Klick ihn setzt. */
async function dragGrip(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
  await page.mouse.click(to.x, to.y);
}

test("Dach: Eckgriff im Grundriss ziehen, Rückgängig ([26])", async ({ page }) => {
  await startNewProject(page);
  await openSample(page);
  await openTab(page, "Elemente");
  await elementRows(page).filter({ hasText: "RF1" }).first().click();
  await expect(page.getByText("Dachform")).toBeVisible();

  await expect.poll(() => page.locator(".plan-grip").count()).toBe(4);
  // Kanten-Anfasser je Seite.
  await expect(page.locator(".plan-edge-grip")).toHaveCount(4);
  const before = await gripCentres(page);

  // Linkeste/oberste Ecke nach rechts-unten ziehen: Umriss wird schief, die übrigen Ecken bleiben.
  const corner = before[0];
  const target = { x: corner.x + 60, y: corner.y + 30 };
  await dragGrip(page, corner, target);
  await expect
    .poll(async () => (await gripCentres(page)).some((g) => Math.abs(g.x - target.x) < 3 && Math.abs(g.y - target.y) < 3))
    .toBe(true);
  const after = await gripCentres(page);
  expect(after).toHaveLength(4);
  const unchanged = before.filter((b) => after.some((a) => Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2));
  expect(unchanged.length).toBe(3);

  // Ein Undo-Schritt stellt den Umriss her.
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => gripCentres(page)).toEqual(before);
});
