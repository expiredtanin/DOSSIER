// [265] „Vorschau“-Kennzeichnung: Pathtracing (Darstellungsart), Rendering mit Blender (Ansichtsmenü, Dialogtitel),
// Kamerafahrt/Video (Knöpfe, Dialogtitel), Geist-Modus beim Begehen (Knopf, Hilfe) tragen die Marke samt Tooltip.
// Eigener Port: E2E_PORT=5196 npx playwright test e2e/previewBadge265.spec.ts
import type { Page } from "@playwright/test";
import { expect, fileMenu, openTab, showSnapshot, test } from "./app";

// 1920 breit: bei 1280 liegt die Darstellungsart seit dem Überlauf-Menü [263] im „⋯“.
test.use({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });

const shot = async (page: Page, name: string) => {
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/${name}.png`, type: "png" });
};

async function openKomplex(page: Page, lang: "de" | "en"): Promise<void> {
  await page.goto(`/?dossierTest&lang=${lang}`);
  await page.getByRole("button", { name: lang === "de" ? /Neues Projekt/ : /New project/ }).first().click();
  await expect(page.locator(".project-name")).toBeVisible();
  if (lang === "de") {
    await fileMenu(page, /Musterhaus \(komplex\)/);
  } else {
    await page.getByRole("button", { name: "File", exact: true }).click();
    await page.getByRole("option", { name: /Sample House \(Complex\)/ }).click();
  }
  const discard = page.getByRole("button", { name: lang === "de" ? "Nicht speichern" : "Don't save" });
  if (await discard.waitFor({ timeout: 1500 }).then(() => true, () => false)) await discard.click();
  await expect(page.locator(".project-name")).toHaveText(/Musterhaus komplex|Sample House/, { timeout: 30_000 });
}

test("Vorschau-Marke in Menü, Darstellungsart, Kamerafahrt und Geist (de)", async ({ page }) => {
  test.setTimeout(150_000);
  await openKomplex(page, "de");

  // Ansichtsmenü: „Rendering mit Blender …“ mit Marke, „3D-Bild …“ ohne.
  await page.getByRole("button", { name: "Ansicht", exact: true }).click();
  const render = page.getByRole("option", { name: /Rendering mit Blender/ });
  await expect(render.getByTestId("preview-badge")).toHaveText("Vorschau");
  await expect(render).toHaveAttribute("title", "Noch nicht fertig — Ergebnisse können abweichen");
  await expect(page.getByRole("option", { name: /^3D-Bild/ }).getByTestId("preview-badge")).toHaveCount(0);
  await shot(page, "preview-de-menu");
  await render.click();
  const dlg = page.getByRole("dialog", { name: "Rendering mit Blender" });
  await expect(dlg.getByTestId("preview-badge")).toHaveText("Vorschau");
  await shot(page, "preview-de-render-dialog");
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);

  // 3D: Darstellungsart Pathtracing und Geist-Knopf.
  await showSnapshot(page, "Axonometrie Südost");
  await page.getByRole("button", { name: "Darstellungsart der aktiven Ansicht" }).click();
  await expect(page.getByRole("option", { name: /Pathtracing/ }).getByTestId("preview-badge")).toHaveText("Vorschau");
  await expect(page.getByRole("option", { name: /Shaded|Schattiert|Flächen/ }).first().getByTestId("preview-badge")).toHaveCount(0);
  await shot(page, "preview-de-style");
  await page.keyboard.press("Escape");

  const walk = page.getByTestId("walk-toggle");
  await expect(walk).toBeVisible({ timeout: 30_000 });
  await walk.click();
  const ghost = page.getByTestId("walk-ghost");
  await expect(ghost).toHaveAttribute("data-tip", /Vorschau/);
  await expect(ghost).toHaveAttribute("aria-label", "Geist (Wände durchlaufen)");
  await expect(page.getByTestId("walk-help").getByTestId("preview-badge")).toHaveText("Vorschau");
  await shot(page, "preview-de-walk");
  await page.keyboard.press("Escape");

  // Kamerafahrt: Knöpfe im Panel „Ausschnitte“, Dialogtitel.
  await openTab(page, "Ausschnitte");
  await page.getByTestId("camera-create").click();
  const tour = page.getByTestId("camera-tour");
  await expect(tour.getByTestId("preview-badge")).toHaveText("Vorschau");
  await expect(tour).toHaveAttribute("title", /Noch nicht fertig/);
  await tour.scrollIntoViewIfNeeded();
  await shot(page, "preview-de-cameras");
  await page.getByTestId("camera-tour-video").click();
  await expect(page.getByTestId("tour-dialog").getByTestId("preview-badge")).toHaveText("Vorschau");
  await shot(page, "preview-de-tour-dialog");
});

test("Vorschau-Marke auf Englisch: Preview", async ({ page }) => {
  test.setTimeout(150_000);
  await openKomplex(page, "en");
  await page.getByRole("button", { name: "View", exact: true }).click();
  const render = page.getByRole("option", { name: /Render with Blender/ });
  await expect(render.getByTestId("preview-badge")).toHaveText("Preview");
  await expect(render).toHaveAttribute("title", "Not finished yet — results may differ");
  await shot(page, "preview-en-menu");
  await page.keyboard.press("Escape");
  await openTab(page, "Views");
  await expect(page.getByTestId("camera-tour").getByTestId("preview-badge")).toHaveText("Preview");
  await page.getByTestId("camera-tour").scrollIntoViewIfNeeded();
  await shot(page, "preview-en-cameras");
});
