// [26] Ecke einfügen/löschen am Umriss (Dach im Beispielprojekt): Einfüge-Raute ziehen → eine Ecke mehr, ein Undo-Schritt;
// Ecke zurück auf die Gerade ziehen → entfällt; Kontextmenü am Eck-Griff „Ecke löschen". Bildschirm-Punkte wie in roofGrips.spec.ts.
import type { Page } from "@playwright/test";
import { blurFocus, elementRows, expect, openSample, openTab, startNewProject, test } from "./app";

const CORNERS = ".plan-grip:not(.plan-grip-insert)";
const DIAMONDS = ".plan-grip-insert";

async function centres(page: Page, selector: string): Promise<{ x: number; y: number }[]> {
  const c = await page.locator(selector).evaluateAll((els) =>
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

async function selectRoof(page: Page): Promise<void> {
  await startNewProject(page);
  await openSample(page);
  await openTab(page, "Elemente");
  await elementRows(page).filter({ hasText: "RF1" }).first().click();
  await expect(page.getByText("Dachform")).toBeVisible();
  await expect.poll(() => page.locator(CORNERS).count()).toBe(4);
}

test("Dach: Einfüge-Raute ziehen fügt eine Ecke ein, Rückgängig, Zurückziehen entfernt sie ([26])", async ({ page }) => {
  await selectRoof(page);
  await expect(page.locator(DIAMONDS)).toHaveCount(4);
  const corners = await centres(page, CORNERS);
  const diamonds = await centres(page, DIAMONDS);

  // Die Raute mit dem kleinsten y (Nordkante) senkrecht herausziehen: Ecke mehr, Umriss bleibt sonst gleich.
  const top = [...diamonds].sort((a, b) => a.y - b.y)[0];
  await dragGrip(page, top, { x: top.x, y: top.y - 40 });
  await expect.poll(() => page.locator(CORNERS).count()).toBe(5);
  await expect(page.locator(DIAMONDS)).toHaveCount(5);

  // Ein Undo-Schritt nimmt Einfügen und Zug zusammen weg.
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => page.locator(CORNERS).count()).toBe(4);
  expect(await centres(page, CORNERS)).toEqual(corners);

  // Wieder einfügen, dann die neue Ecke auf die Kante zurückziehen: sie entfällt.
  await dragGrip(page, top, { x: top.x, y: top.y - 40 });
  await expect.poll(() => page.locator(CORNERS).count()).toBe(5);
  const added = (await centres(page, CORNERS)).find((g) => Math.abs(g.x - top.x) < 3 && g.y < top.y - 20)!;
  await dragGrip(page, added, { x: top.x, y: top.y });
  await expect.poll(() => page.locator(CORNERS).count()).toBe(4);
});

test("Dach: Kontextmenü am Eck-Griff löscht die Ecke, Rückgängig ([26])", async ({ page }) => {
  await selectRoof(page);
  const before = await centres(page, CORNERS);

  await page.mouse.click(before[0].x, before[0].y, { button: "right" });
  await page.getByRole("menuitem", { name: "Ecke löschen" }).click();
  await expect.poll(() => page.locator(CORNERS).count()).toBe(3);

  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => page.locator(CORNERS).count()).toBe(4);
  expect(await centres(page, CORNERS)).toEqual(before);
});
