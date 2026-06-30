// Probe für Shell-Phase: native-App-Verhalten, Marquee-Auswahl, i18n.
// Headless, dpr 2, swiftshader. Schreibt PNGs nach scripts/ und meldet je
// Test (a)-(e) ein Ergebnis als JSON auf stdout (letzte Zeile).
import puppeteer from "puppeteer";

const TARGET = "http://localhost:5173/";
const OUT = new URL("./", import.meta.url).pathname;

const results = {};
const log = (k, v) => {
  results[k] = v;
  console.log(`[${k}]`, JSON.stringify(v));
};

const browser = await puppeteer.launch({
  headless: "new",
  args: [
    "--no-sandbox",
    "--use-gl=swiftshader",
    "--enable-unsafe-swiftshader",
    "--disable-dev-shm-usage",
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error") console.log("[console.error]", t);
  });

  try {
    await page.goto(TARGET, { waitUntil: "networkidle0", timeout: 8000 });
  } catch {
    // networkidle-Timeout ignorieren (Dev-Server hält Verbindungen offen).
  }
  await page.waitForSelector(".plan-svg", { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 800));

  // ── (a) Deutsch: Sichtbarer Text unverändert ────────────────────────────
  const ger = await page.evaluate(() => {
    const body = document.body.innerText;
    return {
      grundriss: body.includes("Grundriss"),
      perspektive: body.includes("Perspektive"),
      auswahl: body.includes("Auswahl"),
      lang: window.__i18n?.getLanguage?.() ?? null,
    };
  });
  await page.screenshot({ path: OUT + "probe-shell-a-de.png" });
  log("a_german", {
    ...ger,
    ok: ger.grundriss && ger.perspektive && ger.lang === "de",
  });

  // ── (b) Native-App: contextmenu unterdrückt, user-select ────────────────
  const native = await page.evaluate(() => {
    const ev = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    const prevented = !document.body.dispatchEvent(ev);
    const bodySel = getComputedStyle(document.body).userSelect ||
      getComputedStyle(document.body).webkitUserSelect;
    return { defaultPrevented: prevented, bodyUserSelect: bodySel };
  });
  log("b_native_contextmenu", native);

  // Ressourcen-Fenster öffnen, dann ein <input> auf user-select:text prüfen.
  // Die Ressourcen-Aktion in der Topbar anklicken.
  const openedResources = await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button, [role=button], .nav-tab, .topbar *")];
    const hit = btns.find((b) => /Ressourcen/i.test(b.textContent || ""));
    if (hit) { hit.click(); return true; }
    return false;
  });
  await new Promise((r) => setTimeout(r, 500));
  // Falls noch kein input sichtbar, einen Manager-Tab öffnen (Bauteile etc.).
  const inputSel = await page.evaluate(() => {
    const inp = document.querySelector("input");
    if (!inp) return { found: false };
    const cs = getComputedStyle(inp);
    return {
      found: true,
      userSelect: cs.userSelect || cs.webkitUserSelect,
    };
  });
  await page.screenshot({ path: OUT + "probe-shell-b-resources.png" });
  log("b_input_userselect", {
    openedResources,
    ...inputSel,
    ok:
      native.defaultPrevented === true &&
      native.bodyUserSelect === "none" &&
      inputSel.userSelect === "text",
  });

  // Ressourcen-Fenster wieder schließen, damit der Plan frei liegt (ESC).
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 300));

  // ── (c) Marquee: Links-Drag über den Raum wählt mehrere Wände ───────────
  const planBox = await page.evaluate(() => {
    const svg = document.querySelector(".plan-svg");
    const r = svg.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  // Crossing-Marquee (rechts→rechts unten nach links oben): ein großes Rechteck,
  // das den ganzen Raum kreuzt und damit ALLE vier Wände berührt. Rechts→links
  // = crossing window (berührend), robust gegen exakte Wandlage.
  const cx = planBox.x + planBox.w / 2;
  const cy = planBox.y + planBox.h / 2;
  const x0 = cx + planBox.w * 0.42;
  const y0 = cy + planBox.h * 0.4;
  const x1 = cx - planBox.w * 0.42;
  const y1 = cy - planBox.h * 0.4;

  await page.mouse.move(x0, y0);
  await page.mouse.down({ button: "left" });
  // Mehrere Zwischenschritte, damit pointermove + Schwelle greifen.
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(
      x0 + ((x1 - x0) * i) / 8,
      y0 + ((y1 - y0) * i) / 8,
    );
    await new Promise((r) => setTimeout(r, 20));
  }
  await page.mouse.up({ button: "left" });
  await new Promise((r) => setTimeout(r, 400));

  const marquee = await page.evaluate(() => {
    const highlights = document.querySelectorAll(".plan-selected").length;
    const footer = document.body.innerText;
    const m = footer.match(/Auswahl:\s*(\d+)\s*(Wand|Wände)/);
    return {
      highlightPolys: highlights,
      footerMatch: m ? m[0] : null,
      footerN: m ? Number(m[1]) : 0,
    };
  });
  await page.screenshot({ path: OUT + "probe-shell-c-marquee.png" });
  log("c_marquee", {
    ...marquee,
    ok: marquee.footerN >= 2 && marquee.highlightPolys >= 1,
  });

  // Einzel-Klick wählt genau eine Wand. Eine echte Wandfläche im DOM finden
  // (gefülltes <polygon> innerhalb der SVG, das nicht Hintergrund/Auswahl ist),
  // dann auf ihren Schwerpunkt in Client-Koordinaten klicken — deterministisch.
  const wallPoint = await page.evaluate(() => {
    const svg = document.querySelector(".plan-svg");
    const polys = [...svg.querySelectorAll("polygon")].filter(
      (p) =>
        !p.classList.contains("plan-selected") &&
        !p.classList.contains("plan-bg"),
    );
    const ctm = svg.getScreenCTM();
    let best = null;
    let bestArea = 0;
    for (const poly of polys) {
      const pts = poly.getAttribute("points");
      if (!pts) continue;
      const nums = pts.trim().split(/[\s,]+/).map(Number);
      let cxv = 0,
        cyv = 0,
        n = 0;
      let area = 0;
      for (let i = 0; i + 1 < nums.length; i += 2) {
        cxv += nums[i];
        cyv += nums[i + 1];
        n++;
      }
      if (n < 3) continue;
      // grobe Bounding-Box-Fläche als Größenmaß
      const xs = nums.filter((_, i) => i % 2 === 0);
      const ys = nums.filter((_, i) => i % 2 === 1);
      area =
        (Math.max(...xs) - Math.min(...xs)) *
        (Math.max(...ys) - Math.min(...ys));
      if (area > bestArea) {
        bestArea = area;
        // SVG-User-Space → Client über CTM transformieren.
        const ptObj = svg.createSVGPoint();
        ptObj.x = cxv / n;
        ptObj.y = cyv / n;
        const sp = ptObj.matrixTransform(ctm);
        best = { x: sp.x, y: sp.y };
      }
    }
    return best;
  });
  if (wallPoint) {
    await page.mouse.click(wallPoint.x, wallPoint.y, { button: "left" });
    await new Promise((r) => setTimeout(r, 350));
  }
  const single = await page.evaluate(() => {
    const footer = document.body.innerText;
    const m = footer.match(/Auswahl:\s*(\d+)\s*(Wand|Wände)/);
    return {
      footerMatch: m ? m[0] : null,
      footerN: m ? Number(m[1]) : 0,
      highlightPolys: document.querySelectorAll(".plan-selected").length,
    };
  });
  await page.screenshot({ path: OUT + "probe-shell-c2-single.png" });
  log("c_single_click", { ...single, ok: single.footerN === 1 });

  // ── (d) Rechtsklick auf den Plan öffnet UNSER ContextMenu (.ctx-menu) ────
  // Erst sicherstellen, dass eine Wand gewählt ist (Einzelklick oben hat das
  // getan). Rechtsklick auf den Plan.
  await page.evaluate(
    ({ x, y }) => {
      const svg = document.querySelector(".plan-svg");
      const ev = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 2,
      });
      svg.dispatchEvent(ev);
    },
    { x: cx, y: planBox.y + planBox.h * 0.22 },
  );
  await new Promise((r) => setTimeout(r, 300));
  const planCtx = await page.evaluate(() => ({
    ctxMenu: document.querySelectorAll(".ctx-menu").length,
  }));
  await page.screenshot({ path: OUT + "probe-shell-d-plan-context.png" });
  log("d_plan_context", { ...planCtx, ok: planCtx.ctxMenu >= 1 });
  // Menü schliessen.
  await page.mouse.click(planBox.x + 4, planBox.y + 4, { button: "left" });
  await new Promise((r) => setTimeout(r, 200));

  // Rechtsklick auf eine Ebenen-Zeile (linke Liste) öffnet ebenfalls .ctx-menu.
  const layerCtx = await page.evaluate(() => {
    const row =
      document.querySelector(".nav-list .cat-name")?.closest("div") ||
      document.querySelector(".nav-list > *");
    if (!row) return { found: false, ctxMenu: 0 };
    const r = row.getBoundingClientRect();
    const ev = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: r.x + 10,
      clientY: r.y + r.height / 2,
      button: 2,
    });
    row.dispatchEvent(ev);
    return { found: true };
  });
  await new Promise((r) => setTimeout(r, 300));
  const layerCtxCount = await page.evaluate(() => ({
    ctxMenu: document.querySelectorAll(".ctx-menu").length,
  }));
  await page.screenshot({ path: OUT + "probe-shell-d2-layer-context.png" });
  log("d_layer_context", {
    ...layerCtx,
    ...layerCtxCount,
    ok: layerCtx.found && layerCtxCount.ctxMenu >= 1,
  });
  await page.mouse.click(planBox.x + 4, planBox.y + 4, { button: "left" });
  await new Promise((r) => setTimeout(r, 200));

  // ── (e) i18n auf Englisch schalten + Screenshot ─────────────────────────
  const enFlip = await page.evaluate(() => {
    if (!window.__i18n?.setLanguage) return { exposed: false };
    window.__i18n.setLanguage("en");
    return { exposed: true, lang: window.__i18n.getLanguage() };
  });
  await new Promise((r) => setTimeout(r, 400));
  const enText = await page.evaluate(() => {
    const body = document.body.innerText;
    return {
      plan: body.includes("Plan"),
      perspective: body.includes("Perspective"),
      stillGerman: body.includes("Grundriss"),
    };
  });
  await page.screenshot({ path: OUT + "probe-shell-e-en.png" });
  log("e_english", {
    ...enFlip,
    ...enText,
    ok:
      enFlip.exposed === true &&
      enFlip.lang === "en" &&
      enText.perspective &&
      !enText.stillGerman,
  });

  // Zurück auf Deutsch.
  await page.evaluate(() => window.__i18n?.setLanguage("de"));

  const allOk = Object.values(results).every((r) => r.ok !== false);
  console.log("\nRESULT " + JSON.stringify({ allOk, results }));
} finally {
  await browser.close();
}
