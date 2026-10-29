// Plan-Darstellung über render2d (WASM/WebGPU) bei schnellem Rad-Zoom, Schwenken und gleichzeitigen
// Szenen-Änderungen (G10, 29.10.): früher „recursive use of an object detected which would lead to
// unsafe aliasing in rust" und danach ein leerer Plan. Ursache: das WebGPU-Gerät ging verloren
// (headless SwiftShader verliert es beim ersten Präsentieren; real: Treiber-Reset, GPU-Prozess),
// wgpu paniert in `set_scene_bin`/`render`, das wasm-bindgen-Objekt blieb gesperrt, der GPU-Pfad
// aber „bereit" — das SVG zeichnete die Geometrie nicht mehr.
// Erwartet: kein gesperrter Renderer, kein Panic; der Plan wird entweder von render2d gezeichnet
// (`data-engine="wasm"`, echte GPU) oder vom SVG-Rückfall (`"svg"`, dann mit Geometrie im SVG).
import { blurFocus, commandInput, expect, finishCommand, openSample, startNewProject, test, typeCommand } from "./app";

test("render2d: schneller Rad-Zoom, Schwenken und Szenen-Änderungen lassen den Plan nie leer", async ({ page }) => {
  test.setTimeout(60_000);
  const bad: string[] = [];
  page.on("console", (m) => {
    const t = m.text();
    if (/recursive use of an object|unsafe aliasing|panicked at|RuntimeError: unreachable/.test(t)) bad.push(t.slice(0, 300));
  });
  await startNewProject(page);
  await openSample(page);
  const svg = page.locator("svg.plan-svg");
  const box = (await svg.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Eine Wand zeichnen, damit Rückgängig/Wiederholen die Szene während der Gesten wechseln.
  await page.getByRole("button", { name: "Wand", exact: true }).click();
  await expect(page.locator(".cmdline-prompt")).toHaveText("Startpunkt der Wand:");
  await commandInput(page).focus();
  await typeCommand(page, "0,0");
  await typeCommand(page, "3,0");
  await finishCommand(page);
  await blurFocus(page);

  for (let burst = 0; burst < 6; burst++) {
    await page.mouse.move(cx + (burst - 3) * 40, cy + (burst % 2) * 30);
    // Rad-Zoom-Stoss ohne Pause (über mehrere LOD-Stufen), dann zurück.
    for (let k = 0; k < 12; k++) await page.mouse.wheel(0, burst % 2 ? 300 : -300);
    // Szene wechselt mitten in der Geste.
    await page.keyboard.press(burst % 2 ? "ControlOrMeta+Shift+z" : "ControlOrMeta+z");
    // Schwenken mit der mittleren Taste.
    await page.mouse.down({ button: "middle" });
    for (let k = 1; k <= 8; k++) await page.mouse.move(cx + k * 15, cy - k * 10);
    await page.mouse.up({ button: "middle" });
    for (let k = 0; k < 12; k++) await page.mouse.wheel(0, burst % 2 ? -300 : 300);
  }
  await page.waitForTimeout(600); // Rad-Zoom wird nach einer Pause festgeschrieben

  expect(bad, "gesperrter Renderer / Panic").toEqual([]);
  const engine = await svg.getAttribute("data-engine");
  test.info().annotations.push({ type: "plan-engine", description: String(engine) });
  expect(["wasm", "svg"]).toContain(engine);
  if (engine === "svg") {
    // SVG-Rückfall zeichnet die Geometrie selbst.
    const shapes = await svg.locator("path, polygon, polyline, line").count();
    expect(shapes, "Geometrie im SVG").toBeGreaterThan(20);
  }
});
