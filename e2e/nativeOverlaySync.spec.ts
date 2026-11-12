// [145] Texte beim Zoomen synchron: auf macOS zeichnet die native Metal-Fläche (`native2d`) die
// Geometrie, das SVG-Overlay der Webview darüber Raumstempel, Textfelder und Griffe. Früher setzte die
// Ansicht den Overlay-Ausschnitt erst, wenn `native2d_frame` BEANTWORTET war — die Webview malte ihn
// dann einen Frame nach der Geometrie, die Texte liefen beim Zoomen hinterher.
// Hier wird die native Fläche im Browser nachgestellt (`__TAURI_INTERNALS__`-Attrappe, Antwort mit
// IPC-Verzögerung). Gemessen wird, ob das Overlay noch im selben Task (vor dem nächsten Malen) auf
// demselben Ausschnitt steht wie der eben an die Fläche geschickte Frame.
import { blurFocus, commandInput, expect, startNewProject, test, typeCommand } from "./app";

declare global {
  interface Window {
    __nativeFrames?: { view: { x: number; y: number; w: number; h: number }; svg: number[] | null }[];
    /** [194] Zuletzt an die Fläche geschickte Textzeilen (Glyphen-Pass) samt Satz-Massstab. */
    __nativeSceneTexts?: { texts: string[]; codes: number[]; n: number } | null;
  }
}

test("native Fläche: Overlay-Ausschnitt folgt jedem Zoom-/Schwenk-Frame im selben Takt", async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    const frames: NonNullable<Window["__nativeFrames"]> = [];
    window.__nativeFrames = frames;
    /** Ausschnitt des Overlays in absoluten viewBox-Einheiten (viewBox ist lokal zum Ursprung). */
    const svgView = (): number[] | null => {
      const svg = document.querySelector("svg.plan-svg");
      const vb = svg?.getAttribute("viewBox");
      if (!svg || !vb) return null;
      const [x, y, w, h] = vb.split(/[\s,]+/).map(Number);
      const ox = Number(svg.getAttribute("data-origin-x") ?? 0);
      const oy = Number(svg.getAttribute("data-origin-y") ?? 0);
      return [x + ox, y + oy, w, h];
    };
    let cb = 1;
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      transformCallback: () => cb++,
      unregisterCallback: () => {},
      convertFileSrc: (p: string) => p,
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
      invoke(cmd: string, args: Record<string, unknown>) {
        if (cmd === "native2d_embed_available") return Promise.resolve(true);
        if (cmd === "native2d_texts") return Promise.resolve(true);
        if (cmd === "native2d_frame") {
          const rec = { view: args.view as { x: number; y: number; w: number; h: number }, svg: null as number[] | null };
          frames.push(rec);
          // Stand des Overlays am Ende dieses Tasks (= vor dem nächsten Malen der Webview).
          queueMicrotask(() => (rec.svg = svgView()));
          // Die echte Fläche antwortet nach dem Zeichnen (IPC über den Hauptthread).
          return new Promise((r) => setTimeout(() => r(null), 12));
        }
        // Übrige Tauri-Aufrufe (Fenster, Ereignisse, Menü …): stumm beantworten.
        return Promise.resolve(cmd === "plugin:window|get_all_windows" ? [] : null);
      },
    };
  });
  // Leeres Projekt genügt (das HTML-Dateimenü fehlt unter „Tauri", die Vorlage käme übers native Menü).
  await startNewProject(page);
  const svg = page.locator("svg.plan-svg");
  await expect(svg).toHaveAttribute("data-engine", "native");
  const box = (await svg.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.45);
  await page.evaluate(() => (window.__nativeFrames!.length = 0));
  for (let k = 0; k < 16; k++) {
    await page.mouse.wheel(0, k < 8 ? -120 : 120);
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(400);
  // Schwenken (mittlere Taste) läuft über denselben imperativen Weg.
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: "middle" });
  for (let k = 1; k <= 10; k++) {
    await page.mouse.move(cx + k * 12, cy - k * 7);
    await page.waitForTimeout(16);
  }
  await page.mouse.up({ button: "middle" });
  await page.waitForTimeout(300);
  const frames = await page.evaluate(() => window.__nativeFrames!);
  expect(frames.length, "Zoom-Frames an die native Fläche").toBeGreaterThan(14);
  const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
  const lagging = frames.filter((f) => {
    const s = f.svg;
    if (!s) return true;
    const tol = 1e-6 * Math.max(1, Math.abs(f.view.w));
    return !(near(s[0], f.view.x, tol) && near(s[1], f.view.y, tol) && near(s[2], f.view.w, tol) && near(s[3], f.view.h, tol));
  });
  expect(lagging.length, `Overlay hinter der Geometrie in ${lagging.length}/${frames.length} Frames`).toBe(0);
});

// [194] Die native Fläche zeichnet die Plan-Texte selbst (Glyphen-Pass im selben Frame wie die Linien):
// waagrechte Beschriftungen (hier Achsraster-Blasen und Masszahlen) gehen als gesetzte Zeilen an die Fläche
// und fehlen im SVG-Overlay; ohne Bestätigung der Fläche bleiben sie im Overlay.
for (const accept of [true, false]) {
  test(`native Fläche: Plan-Texte ${accept ? "im Glyphen-Pass, nicht im Overlay" : "im Overlay, wenn die Fläche ablehnt"}`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.addInitScript((acceptTexts: boolean) => {
      window.__nativeSceneTexts = null;
      let cb = 1;
      (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
        transformCallback: () => cb++,
        unregisterCallback: () => {},
        convertFileSrc: (p: string) => p,
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
        invoke(cmd: string, args: unknown, opts?: { headers?: Record<string, string> }) {
          if (cmd === "native2d_embed_available" || cmd === "native2d_texts") return Promise.resolve(true);
          if (cmd === "native2d_scene_texts") {
            const b = args as Uint8Array;
            const f = new Float64Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
            const n = f[0];
            let u = 1 + n * 9;
            const texts: string[] = [];
            const codes: number[] = [];
            for (let k = 0; k < n; k++) {
              const len = f[1 + k * 9 + 8];
              texts.push(String.fromCharCode(...Array.from(f.subarray(u, u + len))));
              codes.push(f[1 + k * 9 + 7]);
              u += len;
            }
            window.__nativeSceneTexts = { texts, codes, n: Number(opts?.headers?.["x-text-scale"]) };
            return Promise.resolve(acceptTexts);
          }
          return Promise.resolve(cmd === "plugin:window|get_all_windows" ? [] : null);
        },
      };
    }, accept);
    await startNewProject(page);
    const svg = page.locator("svg.plan-svg");
    await expect(svg).toHaveAttribute("data-engine", "native");
    await commandInput(page).focus();
    await typeCommand(page, "achsraster");
    await typeCommand(page, "0,0");
    await typeCommand(page, "6 6");
    await typeCommand(page, "5");
    await blurFocus(page);
    await page.getByTitle("Auf Plan einpassen").click();
    // Zeilen gehen an die Fläche (gesetzt zum Anzeige-Massstab 1:100).
    await expect
      .poll(() => page.evaluate(() => window.__nativeSceneTexts?.texts ?? []))
      .toEqual(expect.arrayContaining(["1", "2", "3", "A", "B"]));
    expect(await page.evaluate(() => window.__nativeSceneTexts!.n)).toBe(100);
    const overlay = () => page.locator("svg.plan-svg text").evaluateAll((els) => els.map((e) => e.textContent ?? ""));
    if (accept) {
      // Im Overlay keine dieser Beschriftungen mehr (sonst liefen sie beim Zoomen einen Frame hinterher).
      await expect.poll(overlay).not.toEqual(expect.arrayContaining(["A"]));
      expect((await overlay()).filter((t) => ["1", "2", "3", "A", "B"].includes(t))).toEqual([]);
    } else {
      await expect.poll(overlay).toEqual(expect.arrayContaining(["1", "2", "3", "A", "B"]));
    }
  });
}
