// [206]/[118] WebGPU-Geräteverlust (Mac: Ruhezustand, Grafikwechsel, eGPU, Speicherdruck; headless SwiftShader: schon beim
// ersten Präsentieren). Früher: render3d ohne Verlust-Behandlung → „RuntimeError: unreachable“ (wgpu-Panic auf totem
// Gerät), danach bei jedem Aufruf „recursive use of an object …“; render2d baute ohne Pause im Kreis neu auf.
// Hier wird der Verlust zusätzlich erzwungen: jedes WebGPU-Gerät wird mitten in der Bedienung per `GPUDevice.destroy()`
// zerstört (Testnaht über `addInitScript`, die App weiss davon nichts).
// Erwartet: kein Panic, kein gesperrtes Objekt; Plan bleibt sichtbar (render2d oder SVG-Rückfall mit Geometrie);
// Neuaufbau mit Backoff und Budget, also nur wenige neue Geräte statt einer Schleife.
import { blurFocus, commandInput, expect, finishCommand, openSample, startNewProject, test, typeCommand } from "./app";

test("WebGPU-Geräteverlust: kein Panic, Plan und 3D bleiben bedienbar, kein Neuaufbau im Kreis", async ({ page }) => {
  test.setTimeout(90_000);
  const bad: string[] = [];
  page.on("console", (m) => {
    const t = m.text();
    if (/recursive use of an object|unsafe aliasing|panicked at|unreachable/.test(t)) bad.push(t.slice(0, 300));
  });
  page.on("pageerror", (e) => bad.push(`pageerror: ${e.message.slice(0, 300)}`));
  await page.addInitScript(() => {
    const w = window as unknown as { __e2eDevices: GPUDevice[]; __e2eDeviceCount: number };
    w.__e2eDevices = [];
    w.__e2eDeviceCount = 0;
    const A = (globalThis as unknown as { GPUAdapter?: { prototype: GPUAdapter } }).GPUAdapter?.prototype;
    const D = (globalThis as unknown as { GPUDevice?: { prototype: GPUDevice } }).GPUDevice?.prototype;
    if (!A || !D) return;
    // Wie Chromium auf einem verlorenen Gerät (Instanz weg, Grenzen 0): `createBuffer(mappedAtCreation)` wirft.
    // Genau das löste in wgpu den Panic aus (`webgpu.rs` unwrap → „unreachable“, danach „recursive use …“).
    const dead = new WeakSet<GPUDevice>();
    const destroy = D.destroy;
    D.destroy = function (this: GPUDevice) {
      dead.add(this);
      return destroy.call(this);
    };
    const createBuffer = D.createBuffer;
    D.createBuffer = function (this: GPUDevice, desc: GPUBufferDescriptor) {
      if (dead.has(this) && desc.mappedAtCreation)
        throw new RangeError(`createBuffer failed, size (${desc.size}) is too large for the implementation when mappedAtCreation == true`);
      return createBuffer.call(this, desc);
    };
    const orig = A.requestDevice;
    A.requestDevice = async function (this: GPUAdapter, ...a: Parameters<GPUAdapter["requestDevice"]>) {
      const d = await orig.apply(this, a);
      w.__e2eDevices.push(d);
      w.__e2eDeviceCount++;
      return d;
    };
  });
  const killAll = () =>
    page.evaluate(() => {
      const w = window as unknown as { __e2eDevices: GPUDevice[] };
      for (const d of w.__e2eDevices.splice(0)) d.destroy();
    });

  await startNewProject(page);
  await openSample(page);
  const svg = page.locator("svg.plan-svg").first();
  const box = (await svg.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Eine Wand, damit Rückgängig/Wiederholen das Modell (Plan-Szene, 3D-Teile) ändern.
  await page.getByRole("button", { name: "Wand", exact: true }).click();
  await commandInput(page).focus();
  await typeCommand(page, "0,0");
  await typeCommand(page, "3,0");
  await finishCommand(page);
  await blurFocus(page);

  for (let round = 0; round < 3; round++) {
    await killAll();
    // Mitten in Rad-Zoom und Schwenken: Aufrufe treffen auf das tote Gerät.
    await page.mouse.move(cx, cy);
    for (let k = 0; k < 8; k++) await page.mouse.wheel(0, k % 2 ? 200 : -200);
    await page.keyboard.press("ControlOrMeta+z");
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await page.waitForTimeout(300);
  }

  // 3D: Gerät zerstören, während das Modell steht; dann drehen und zurück zum Plan.
  await page.getByRole("button", { name: "Ansicht", exact: true }).click();
  await page.getByRole("option", { name: "Perspektive" }).first().click();
  const canvas3d = page.locator("canvas[data-engine=render3d]");
  await expect(canvas3d).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(800);
  // [118] Eine gesetzte Kamera muss den Geräteverlust samt Neuaufbau überleben (früher: Preset neu angewandt).
  type CamApi = { getCamera: () => { position: number[]; direction: number[] } | null; setCamera: (c: unknown, animate?: boolean) => boolean };
  await page.waitForFunction(() => (window as unknown as { __dossierCamera?: unknown }).__dossierCamera !== undefined, undefined, { timeout: 8_000 });
  const camBefore = await page.evaluate(() => {
    const api = (window as unknown as { __dossierCamera: CamApi }).__dossierCamera;
    const c = api.getCamera()!;
    api.setCamera({ ...c, position: [c.position[0] + 7, c.position[1] + 3, c.position[2] + 5] }, false);
    return api.getCamera()!.position;
  });
  await killAll();
  // Modelländerung im selben Takt wie der Verlust: Teile-Update lädt neue Puffer hoch.
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await page.waitForTimeout(300);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await page.waitForTimeout(1500);
  const camAfter = await page.evaluate(() => (window as unknown as { __dossierCamera: CamApi }).__dossierCamera.getCamera()!.position);
  for (let k = 0; k < 3; k++) expect(camAfter[k], "Kamera nach Geräteverlust erhalten").toBeCloseTo(camBefore[k], 4);
  const b3 = (await canvas3d.boundingBox())!;
  await page.mouse.move(b3.x + b3.width / 2, b3.y + b3.height / 2);
  await page.mouse.down();
  for (let k = 1; k <= 10; k++) await page.mouse.move(b3.x + b3.width / 2 + k * 12, b3.y + b3.height / 2 + k * 4);
  await page.mouse.up();
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "Ansicht", exact: true }).click();
  await page.getByRole("option", { name: "Grundriss" }).first().click();
  await blurFocus(page);
  await page.waitForTimeout(800);

  expect(bad, "Panic / gesperrter Renderer").toEqual([]);
  const engine = await page.locator("svg.plan-svg").first().getAttribute("data-engine");
  expect(["wasm", "svg"]).toContain(engine);
  if (engine === "svg") {
    const shapes = await page.locator("svg.plan-svg").first().locator("path, polygon, polyline, line").count();
    expect(shapes, "Geometrie im SVG").toBeGreaterThan(20);
  }
  // Backoff + gemeinsames Budget: wenige Geräte, keine Schleife (früher ein neues je Verlust ohne Pause).
  const count = await page.evaluate(() => (window as unknown as { __e2eDeviceCount: number }).__e2eDeviceCount);
  expect(count, "neu erzeugte WebGPU-Geräte").toBeLessThanOrEqual(8);
});
