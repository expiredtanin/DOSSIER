// [333] Anzeige-Engines mit echtem WebGPU (SwiftShader über ANGLE/Vulkan, Projekt „webgpu“ in playwright.config.ts):
// Die übrige Suite läuft ohne diese Flags — headless Chromium verliert dort das Gerät beim ersten Bild, der Plan fällt auf
// den SVG-Rückfall. Hier zeichnen render2d (Plan) und render3d (3D-Ansicht) wirklich: kein Rückfall, das Bild ist nicht
// leer und ändert sich beim Zoomen. Gelesen wird der Canvas gleich nach dem `GPUQueue.submit` der App (sonst ist der
// präsentierte Puffer schon leer). Eigener Port: E2E_PORT=5193 npx playwright test --project=webgpu
import { mkdirSync, writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, fileMenu, discardIfAsked, startNewProject, test } from "./app";

/** Je Canvas-Art ein Bild gleich nach dem nächsten submit (`window.__grab = "plan" | "3d"`). */
async function hookSubmit(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __grab: string | null; __img: string | null };
    w.__grab = null;
    w.__img = null;
    const orig = GPUQueue.prototype.submit;
    GPUQueue.prototype.submit = function (this: GPUQueue, ...a: Parameters<GPUQueue["submit"]>) {
      const r = orig.apply(this, a);
      if (w.__grab) {
        const c =
          w.__grab === "3d"
            ? document.querySelector<HTMLCanvasElement>("canvas[data-engine=render3d]")
            : document.querySelector("svg.plan-svg")?.parentElement?.querySelector<HTMLCanvasElement>("canvas");
        if (c && c.width > 0) {
          w.__img = c.toDataURL("image/png");
          w.__grab = null;
        }
      }
      return r;
    };
  });
}

/** Bild des Canvas nach der nächsten Geste `act` (die ein neues Bild auslöst). */
async function grab(page: Page, kind: "plan" | "3d", act: () => Promise<void>): Promise<string> {
  await page.evaluate((k) => {
    const w = window as unknown as { __grab: string | null; __img: string | null };
    w.__img = null;
    w.__grab = k;
  }, kind);
  await act();
  await page.waitForFunction(() => (window as unknown as { __img: string | null }).__img, null, { timeout: 20_000 });
  return page.evaluate(() => (window as unknown as { __img: string }).__img);
}

/** Anteil der Pixel, die sich deutlich vom häufigsten Farbwert (Hintergrund) unterscheiden. */
async function inkShare(page: Page, url: string): Promise<number> {
  return page.evaluate(async (u) => {
    const img = new Image();
    img.src = u;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const count = new Map<number, number>();
    for (let i = 0; i < d.length; i += 4) {
      const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
      count.set(k, (count.get(k) ?? 0) + 1);
    }
    const bg = [...count].sort((a, b) => b[1] - a[1])[0][0];
    const [br, bgc, bb] = [bg >> 16, (bg >> 8) & 255, bg & 255];
    let ink = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i] - br) + Math.abs(d[i + 1] - bgc) + Math.abs(d[i + 2] - bb) > 60) ink++;
    }
    return ink / (d.length / 4);
  }, url);
}

test("WebGPU: render2d zeichnet den Plan, render3d die 3D-Ansicht (kein SVG-Rückfall)", async ({ page }) => {
  test.setTimeout(120_000);
  const bad: string[] = [];
  page.on("console", (m) => {
    if (/panicked at|RuntimeError: unreachable|device.*lost|Gerät verloren/i.test(m.text())) bad.push(m.text().slice(0, 300));
  });
  await hookSubmit(page);
  await startNewProject(page);
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  const svg = page.locator("svg.plan-svg").first();
  await expect(svg).toHaveAttribute("data-engine", "wasm");

  // Plan: render2d zeichnet (Striche auf dem Canvas), Zoom ändert das Bild.
  const box = (await svg.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const a = await grab(page, "plan", () => page.mouse.wheel(0, -240));
  const b = await grab(page, "plan", () => page.mouse.wheel(0, 480));
  expect(await inkShare(page, a), "Plan-Canvas nicht leer").toBeGreaterThan(0.005);
  expect(b, "Zoom zeichnet neu").not.toBe(a);
  await page.waitForTimeout(600);
  await expect(svg, "nach dem Zoomen kein Rückfall").toHaveAttribute("data-engine", "wasm");

  // 3D-Ansicht: render3d zeichnet das Modell.
  await page.getByRole("button", { name: "Ansicht", exact: true }).click();
  await page.getByRole("option", { name: "3D-Ansicht", exact: true }).click();
  const canvas = page.locator("canvas[data-engine=render3d]");
  await canvas.waitFor({ timeout: 60_000 });
  await page.waitForTimeout(3000);
  const cb = (await canvas.boundingBox())!;
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
  const c3 = await grab(page, "3d", () => page.mouse.wheel(0, -120));
  expect(await inkShare(page, c3), "3D-Canvas nicht leer").toBeGreaterThan(0.01);

  expect(bad, "Panic / Geräteverlust").toEqual([]);
  mkdirSync("test-results", { recursive: true });
  // Prüfbilder: die ausgelesenen Canvas-Bilder (ein Seiten-Screenshot erfasst den präsentierten WebGPU-Puffer nicht).
  for (const [name, url] of [["plan", a], ["3d", c3]]) {
    writeFileSync(`test-results/webgpu333-${name}.png`, Buffer.from(url.split(",")[1], "base64"));
  }
});
