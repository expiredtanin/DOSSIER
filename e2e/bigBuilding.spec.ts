// Frame-Zeiten im 2D-Plan am Grossgebäude ([20]): öffnet das parametrische Testgebäude (8 × 15,
// `model/sampleProjectBig.ts`, per CLI als .obp erzeugt) und misst beim Zoomen und Schwenken die
// requestAnimationFrame-Abstände. Gibt p50/p95/max aus; geprüft wird nur eine grosse Obergrenze (nicht flackernd).
// Läuft nur mit E2E_PERF=1 (`npm run e2e:perf`), damit die normale Suite nicht langsamer wird.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { discardIfAsked, expect, fileMenu, startNewProject, test } from "./app";

const BIG_OBP = resolve(".tmp-e2e/gross.obp");

function pct(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

test.describe("@perf Grossgebäude", () => {
  test.skip(!process.env.E2E_PERF, "Messung nur mit E2E_PERF=1");

  test("2D-Plan: Zoom und Schwenken, Frame-Zeiten", async ({ page }) => {
    test.setTimeout(60_000);
    mkdirSync(resolve(".tmp-e2e"), { recursive: true });
    execFileSync("node", ["dist-cli/dossier-cli.mjs", ":gross", "migrate", "--out", BIG_OBP], { stdio: "inherit" });

    await startNewProject(page);
    const chooser = page.waitForEvent("filechooser");
    await fileMenu(page, "Projekt öffnen");
    await (await chooser).setFiles(BIG_OBP);
    await discardIfAsked(page);
    await expect(page.locator(".project-name")).toHaveText(/Grossgebäude 8×15/, { timeout: 30_000 });
    const svg = page.locator("svg.plan-svg");
    await expect(svg).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1000);

    const box = (await svg.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);

    const start = () => page.evaluate(() => {
      const w = window as unknown as { __frames: number[]; __run: boolean };
      w.__frames = [];
      w.__run = true;
      let last = performance.now();
      const tick = (t: number) => {
        w.__frames.push(t - last);
        last = t;
        if (w.__run) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const stop = () => page.evaluate(() => {
      const w = window as unknown as { __frames: number[]; __run: boolean };
      w.__run = false;
      return w.__frames.slice(1);
    });

    const phases: Record<string, number[]> = {};
    // Zoom: rein und wieder heraus in kleinen Rad-Schritten.
    await start();
    for (let k = 0; k < 40; k++) { await page.mouse.wheel(0, k < 20 ? -120 : 120); await page.waitForTimeout(16); }
    await page.waitForTimeout(300);
    phases.zoom = await stop();
    // Schwenken: mittlere Taste ziehen.
    await start();
    await page.mouse.down({ button: "middle" });
    for (let k = 1; k <= 60; k++) await page.mouse.move(cx + Math.sin(k / 6) * 300, cy + Math.cos(k / 6) * 150, { steps: 2 });
    await page.mouse.up({ button: "middle" });
    phases.pan = await stop();

    for (const [name, f] of Object.entries(phases)) {
      const s = [...f].sort((a, b) => a - b);
      const line = `Frame-Zeiten ${name}: n=${s.length} p50=${pct(s, 0.5).toFixed(1)} ms p95=${pct(s, 0.95).toFixed(1)} ms max=${(s[s.length - 1] ?? 0).toFixed(1)} ms (Engine ${await svg.getAttribute("data-engine")})`;
      console.log(line);
      test.info().annotations.push({ type: `frames-${name}`, description: line });
      expect(s.length, `Frames ${name}`).toBeGreaterThan(5);
      // Grosse Obergrenze (Software-Rendering im Container): fängt nur Ausreisser wie Sekunden-Hänger.
      expect(pct(s, 0.5), `p50 ${name}`).toBeLessThan(500);
      expect(pct(s, 0.95), `p95 ${name}`).toBeLessThan(2000);
    }
  });
});
