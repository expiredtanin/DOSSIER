// [176] Knick am bestehenden Schnitt per Griff einfügen: Schnittlinie wählen, Mittel-Griff ziehen (Knick entsteht,
// ein Undo-Schritt), Knick zurück auf die Gerade ziehen (Knick entfällt wieder). Bildschirm-Punkte aus der
// viewBox-Abbildung des SVG-Overlays (wie kataster.spec.ts).
import type { Page } from "@playwright/test";
import { blurFocus, commandInput, expect, finishCommand, startNewProject, test, typeCommand } from "./app";

async function screenOf(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.locator("svg.plan-svg").evaluate(
    (el, [mx, my]) => {
      const [vx, vy, vw, vh] = el.getAttribute("viewBox")!.split(/\s+/).map(Number);
      const ox = Number(el.getAttribute("data-origin-x") ?? 0);
      const oy = Number(el.getAttribute("data-origin-y") ?? 0);
      const r = el.getBoundingClientRect();
      const s = Math.min(r.width / vw, r.height / vh);
      return { x: r.left + (r.width - vw * s) / 2 + (mx * 90 - ox - vx) * s, y: r.top + (r.height - vh * s) / 2 + (-my * 90 - oy - vy) * s };
    },
    [x, y],
  );
}

async function gripCentres(page: Page): Promise<{ x: number; y: number }[]> {
  const c = await page.locator(".plan-grip").evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
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

test("Schnitt: Mittel-Griff ziehen fügt einen Knick ein, Zurückziehen auf die Gerade entfernt ihn, Rückgängig", async ({ page }) => {
  await startNewProject(page);
  await commandInput(page).focus();
  await typeCommand(page, "schnittlinie");
  await typeCommand(page, "0,0");
  await typeCommand(page, "10,0");
  await finishCommand(page); // Schnitt: weitere Klicks wären Knicke, Enter beendet
  await blurFocus(page);
  await page.locator('[title="Auf Plan einpassen"]').first().click();

  // Schnittlinie wählen (kräftiges Endstück am Anfang): Griffe Anfang, Ende + ein Mittel-Griff.
  const at = await screenOf(page, 0.4, 0);
  await page.mouse.click(at.x, at.y);
  await expect(page.locator(".plan-grip")).toHaveCount(3);
  const [start, mid, end] = await gripCentres(page);
  expect(Math.abs(mid.x - (start.x + end.x) / 2)).toBeLessThan(2);

  // Mittel-Griff nach unten ziehen: Knick (jetzt Anfang, Knick, Ende + zwei Mittel-Griffe).
  await dragGrip(page, mid, { x: mid.x, y: mid.y + 40 });
  await expect(page.locator(".plan-grip")).toHaveCount(5);

  // Rückgängig: ein Schritt nimmt Einfügen und Zug zusammen weg.
  await blurFocus(page);
  await page.keyboard.press("Control+z");
  await expect(page.locator(".plan-grip")).toHaveCount(3);

  // Wieder einfügen, dann den Knick auf die Gerade zurückziehen: er entfällt.
  await dragGrip(page, mid, { x: mid.x, y: mid.y + 40 });
  await expect(page.locator(".plan-grip")).toHaveCount(5);
  const bend = (await gripCentres(page)).find((g) => Math.abs(g.x - mid.x) < 3 && g.y > mid.y + 20)!;
  await dragGrip(page, bend, { x: mid.x, y: mid.y + 1 });
  await expect(page.locator(".plan-grip")).toHaveCount(3);
});
