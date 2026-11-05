// Startseite: Scroll-Video (Blob, geglättete Zeit, gegatete Seeks), Textabschnitte, Schnittmarken,
// „Schnitt setzen". Standard s. website/_design/DESIGN-PAKET.md (Technik) und TODO.md [138].
import { initCommon } from "./common.js";

initCommon();

const VIDEO_URL = "/hero/hero-scrub.mp4";
const POSTER_URL = "/hero/hero-poster.jpg";
// Die fünf Bedingungen für die ruhige Startseite, Zeichen für Zeichen wie in home.css
const GATES = [
  "(max-width: 720px)",
  "(orientation: portrait) and (max-width: 1024px)",
  "(orientation: portrait) and (pointer: coarse)",
  "(orientation: landscape) and (pointer: coarse) and (max-height: 560px)",
  "(prefers-reduced-motion: reduce)",
];
const RM = matchMedia("(prefers-reduced-motion: reduce)");

const root = document.documentElement;
const hero = document.querySelector(".hero");
const stage = hero.querySelector(".stage");
const video = hero.querySelector(".hero-video");
const poster = hero.querySelector(".poster");
const ring = hero.querySelector(".ring");
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const smoothstep = (p, e0, e1) => {
  const t = clamp((p - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

// ---- Text zerlegen (einmal): unsichtbarer Satz für Vorleser, sichtbare Kopie aus Wörtern/Zeichen ----
const OPENING_WORDS = new Set(["Fenstern,", "Türen."]);
function split(el, mode, seed) {
  const text = el.textContent.replace(/\s+/g, " ").trim();
  const r = rng(seed);
  const sr = document.createElement("span");
  sr.className = "vh";
  sr.textContent = text;
  const vis = document.createElement("span");
  vis.setAttribute("aria-hidden", "true");
  const word = (w, th) => {
    const s = document.createElement("span");
    s.className = "w";
    s.textContent = w;
    s.style.setProperty("--th", th.toFixed(3));
    return s;
  };
  if (mode === "chars") {
    // Zeichen in Wort-Hüllen, damit nie mitten im Wort umbrochen wird
    const n = text.length;
    let i = 0;
    text.split(" ").forEach((w, wi, all) => {
      const ws = document.createElement("span");
      ws.className = "w";
      for (const ch of w) {
        const c = document.createElement("span");
        c.className = "c";
        c.textContent = ch;
        c.style.setProperty("--th", ((i / n) * 0.6 + r() * 0.05).toFixed(3));
        ws.append(c);
        i++;
      }
      vis.append(ws);
      if (wi < all.length - 1) {
        vis.append(" ");
        i++;
      }
    });
  } else if (mode === "words" || mode === "rise") {
    const words = mode === "rise" ? text.split(/(?<=-)/) : text.split(" ");
    words.forEach((w, i) => {
      const s = word(w, mode === "rise" ? i * 0.14 : (i / words.length) * 0.55 + r() * 0.06);
      if (OPENING_WORDS.has(w)) s.classList.add("em");
      vis.append(s);
      if (mode === "words" && i < words.length - 1) vis.append(" ");
    });
  } else {
    // Zeilen bzw. Hälften: Kinder-<span> der Vorlage
    const parts = [...el.querySelectorAll(":scope > span")].map((s) => s.textContent.trim());
    parts.forEach((p, li) => {
      const line = document.createElement("span");
      line.className = mode === "lines" ? "ln" : "half";
      if (mode === "lines") {
        line.style.setProperty("--lt", (li * 0.32).toFixed(3));
        const ws = p.split(" ");
        ws.forEach((w, i) => {
          line.append(word(w, li * 0.32 + i * 0.05 + r() * 0.03));
          if (i < ws.length - 1) line.append(" ");
        });
      } else line.textContent = p;
      vis.append(line);
    });
  }
  el.replaceChildren(sr, vis);
}
document.querySelectorAll("[data-split]").forEach((el, i) => split(el, el.dataset.split, 17 + i * 31));

// ---- Abschnitte im Hero (Scroll-Distanz) ----
const bands = [...hero.querySelectorAll(".band")].map((el, i, all) => ({
  el,
  a: +el.dataset.a,
  b: +el.dataset.b,
  ramp: el.dataset.ramp ? +el.dataset.ramp : 0,
  first: i === 0,
  last: i === all.length - 1,
  op: -1,
  k: -1,
  on: null,
}));
let loadK = 0;
function updateCaptions(p) {
  for (const B of bands) {
    const f = Math.min(0.02, (B.b - B.a) / 3);
    let op = (B.first ? 1 : smoothstep(p, B.a, B.a + f)) * (B.last ? 1 : 1 - smoothstep(p, B.b - f, B.b));
    let k = clamp((p - B.a) / (B.ramp || Math.min(0.025, (B.b - B.a) * 0.35)), 0, 1);
    if (B.first) k = Math.max(k, loadK);
    if (p < B.a - 0.001 || p > B.b + 0.001) op = B.first && p <= B.b ? op : 0;
    op = Math.round(op * 1000) / 1000;
    if (op !== B.op) {
      B.op = op;
      B.el.style.opacity = String(op);
    }
    if (Math.abs(k - B.k) > 0.008 || (k !== B.k && (k === 0 || k === 1))) {
      B.k = k;
      B.el.style.setProperty("--k", k.toFixed(3));
    }
    const on = op > 0.5;
    if (on !== B.on) {
      B.on = on;
      B.el.classList.toggle("on", on);
    }
  }
}
function clearCaptions() {
  for (const B of bands) {
    B.el.style.removeProperty("opacity");
    B.el.style.removeProperty("--k");
    B.el.classList.remove("on");
    B.op = B.k = -1;
    B.on = null;
  }
}

// ---- Scroll → Zeit, geglättet, ruht bei Gleichstand ----
function heroProgress() {
  const r = hero.getBoundingClientRect();
  const range = hero.offsetHeight - innerHeight;
  return range > 0 ? clamp(-r.top / range, 0, 1) : 0;
}
let target = 0;
let shown = 0;
let rafId = null;
let lastTick = 0;
let heroOnScreen = true;
let moved = false;
function tick(now) {
  const dt = Math.min(100, now - (lastTick || now));
  lastTick = now;
  shown += (target - shown) * (1 - Math.pow(1 - 0.16, dt / 16.667));
  if (Math.abs(target - shown) < 0.0005) {
    shown = target;
    rafId = null;
    lastTick = 0;
  } else rafId = requestAnimationFrame(tick);
  requestSeek(shown * (video.duration || 0));
  updateCaptions(shown);
  const m = shown > 0.015;
  if (m !== moved) {
    moved = m;
    stage.classList.toggle("moved", m);
  }
}
function onScroll() {
  target = heroProgress();
  if (rafId === null && heroOnScreen) rafId = requestAnimationFrame(tick);
}
new IntersectionObserver((es) => {
  heroOnScreen = es[0].isIntersecting;
  if (heroOnScreen && scrubOn) onScroll();
}).observe(hero);

// ---- Gegatete Seeks (nie zwei gleichzeitig, nur der neueste zählt) ----
let seekBusy = false;
let pendingTime = null;
function requestSeek(t) {
  if (!video.duration || !videoReady) return;
  if (Math.abs(video.currentTime - t) < 0.001) return;
  if (seekBusy) {
    pendingTime = t;
    return;
  }
  seekBusy = true;
  video.currentTime = t;
}
video.addEventListener("seeked", () => {
  seekBusy = false;
  if (pendingTime !== null) {
    const t = pendingTime;
    pendingTime = null;
    requestSeek(t);
  }
});
video.addEventListener("error", () => {
  seekBusy = false;
  pendingTime = null;
  failVideo();
});

// ---- Video als Blob (Range-unabhängig), Poster zuerst, Wachhund ----
let videoReady = false;
let heroInit = false;
function failVideo() {
  stage.classList.add("video-failed");
}
async function loadHeroBlob() {
  const ctrl = new AbortController();
  let watchdog = setTimeout(() => ctrl.abort(), 20000);
  const res = await fetch(VIDEO_URL, { priority: "low", signal: ctrl.signal });
  if (!res.ok || !res.body) throw new Error(String(res.status));
  const total = Number(res.headers.get("Content-Length")) || 3019980;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  let lastRing = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    clearTimeout(watchdog);
    watchdog = setTimeout(() => ctrl.abort(), 20000);
    chunks.push(value);
    got += value.length;
    const frac = Math.min(1, got / total);
    const now = performance.now();
    if (now - lastRing > 100 || frac === 1) {
      lastRing = now;
      ring.style.setProperty("--ld", String(Math.round(126 * (1 - frac))));
    }
  }
  clearTimeout(watchdog);
  ring.style.setProperty("--ld", "0");
  video.src = URL.createObjectURL(new Blob(chunks, { type: "video/mp4" }));
  video.load();
  video.addEventListener(
    "canplay",
    () => {
      videoReady = true;
      requestSeek(heroProgress() * video.duration);
      stage.classList.add("video-ready");
    },
    { once: true },
  );
}
function initHeroOnce() {
  if (heroInit) return;
  heroInit = true;
  poster.style.backgroundImage = `url("${POSTER_URL}")`;
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    loadHeroBlob().catch(failVideo);
  };
  const img = new Image();
  img.onload = start;
  img.onerror = start;
  img.src = POSTER_URL;
  setTimeout(start, 4000);
}

// ---- Die fünf Bedingungen, live ----
let scrubOn = false;
function enableScrub() {
  if (scrubOn) return;
  scrubOn = true;
  root.classList.add("scrub");
  initHeroOnce();
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("resize", onScroll, { passive: true });
  bands.forEach((B) => {
    B.op = -1;
    B.k = -1;
  });
  unpinFinalStates();
  shown = target = heroProgress();
  updateCaptions(shown);
  onScroll();
}
function disableScrub() {
  if (!scrubOn) return;
  scrubOn = false;
  removeEventListener("scroll", onScroll);
  removeEventListener("resize", onScroll);
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  root.classList.remove("scrub");
  clearCaptions();
}
function applyHeroMode() {
  if (GATES.some((q) => matchMedia(q).matches)) disableScrub();
  else enableScrub();
}
const MQLS = GATES.map((q) => matchMedia(q));
MQLS.forEach((m) => m.addEventListener("change", applyHeroMode));

// Abschnitt 1 setzt sich beim Laden einmal zusammen (danach übernimmt der Scroll)
const loadStart = performance.now();
function loadRamp(now) {
  loadK = smoothstep(now - loadStart, 150, 1400);
  if (scrubOn) updateCaptions(shown);
  if (loadK < 1) requestAnimationFrame(loadRamp);
}

// ---- Schnittmarken, Masslinien, Auftritte ----
const reveals = [...document.querySelectorAll(".cutmark, .dimline, .reveal, .end .wall")];
const ARROW = '<svg viewBox="0 0 20 28" aria-hidden="true"><path d="M10 1V26M4 20l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
function buildCutmark(el) {
  const L = el.dataset.letter;
  if (!el.firstChild) {
    el.innerHTML = `<span class="cm-end">${ARROW}<b>${L}</b></span><span class="cm-line"></span><span class="cm-end">${ARROW}<b>${L}</b></span>`;
  }
  const line = el.querySelector(".cm-line");
  const w = line.getBoundingClientRect().width;
  // Strich-Punkt wie die Schnittlinie im Plan: 22 lang, 6 Lücke, 3 Punkt, 6 Lücke
  const n = Math.max(2, Math.floor(w / 37));
  if (line.childElementCount === n * 2) return;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < n; i++) {
    const d = Math.abs((i + 0.5) / n - 0.5) * 2;
    for (const cls of ["", "dot"]) {
      const s = document.createElement("i");
      if (cls) s.className = cls;
      s.style.setProperty("--dl", `${(d * 0.55).toFixed(3)}s`);
      frag.append(s);
    }
  }
  line.replaceChildren(frag);
}
const cutmarks = [...document.querySelectorAll(".cutmark")];
cutmarks.forEach(buildCutmark);
let rsz = 0;
addEventListener("resize", () => {
  clearTimeout(rsz);
  rsz = setTimeout(() => cutmarks.forEach(buildCutmark), 200);
});
const revealIO = new IntersectionObserver(
  (es) => {
    for (const e of es) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("in");
      if (e.target.matches(".step-list, .feat-list")) setTimeout(() => e.target.classList.add("done"), 1400);
    }
  },
  { rootMargin: "0px 0px -12% 0px" },
);
reveals.forEach((el) => revealIO.observe(el));
// Lebendige Elemente nur auf dem Bildschirm
const liveIO = new IntersectionObserver((es) => es.forEach((e) => e.target.classList.toggle("live", e.isIntersecting)));
document.querySelectorAll(".sec").forEach((s) => liveIO.observe(s));

// ---- Was alles drin ist: Bild beim Darüberfahren ----
const featBtns = [...document.querySelectorAll(".feat-list button")];
const shots = [...document.querySelectorAll(".shots img")];
function showShot(i) {
  featBtns.forEach((b, j) => b.setAttribute("aria-pressed", String(i === j)));
  shots.forEach((s, j) => s.classList.toggle("on", i === j));
}
featBtns.forEach((b, i) => {
  b.addEventListener("click", () => showShot(i));
  b.addEventListener("pointerenter", (e) => {
    if (e.pointerType === "mouse") showShot(i);
  });
  b.addEventListener("focus", () => showShot(i));
});

// ---- Schnitt setzen: Linie über den Grundriss ziehen, Schnitt folgt (12 vorgerechnete Schnitte) ----
// Lage der Schnittlinien im Modell (x in m) und Ausschnitt des Grundrissbilds (viewBox x, Breite)
const CUT_X = Array.from({ length: 12 }, (_, i) => 0.6 + (i * 16.6) / 11);
const PLAN_VB = [-7.2, 28.25406];
const cutPlan = document.querySelector(".cut-plan");
const cutLine = document.querySelector(".cut-line");
const cutImgs = [...document.querySelectorAll(".cut-view img")];
const cutRange = document.querySelector(".cut-ctrl input");
const cutOut = document.querySelector(".cut-ctrl .kote");
const f0 = (CUT_X[0] - PLAN_VB[0]) / PLAN_VB[1];
const f1 = (CUT_X[11] - PLAN_VB[0]) / PLAN_VB[1];
let cutIdx = -1;
let cutU = 0.5;
let lastCutPx = -1;
function setCut(u) {
  cutU = clamp(u, 0, 1);
  const px = Math.round((f0 + (f1 - f0) * cutU) * cutPlan.clientWidth * 10) / 10;
  if (px !== lastCutPx) {
    lastCutPx = px;
    cutLine.style.transform = `translateX(${px}px)`;
  }
  const i = Math.round(cutU * 11);
  if (i !== cutIdx) {
    cutIdx = i;
    cutImgs.forEach((im, j) => im.classList.toggle("on", j === i));
    const x = CUT_X[i].toFixed(2);
    cutOut.textContent = `A–A  ${x}`;
    cutRange.setAttribute("aria-valuetext", `${x} m von der Westfassade, Schnitt ${i + 1} von 12`);
  }
  const v = String(Math.round(cutU * 1000));
  if (cutRange.value !== v) cutRange.value = v;
}
cutRange.addEventListener("input", () => setCut(+cutRange.value / 1000));
// Loslassen: weich auf den gezeigten Schnitt einrasten
let snapRaf = null;
function snapCut() {
  if (RM.matches) return setCut(Math.round(cutU * 11) / 11);
  const goal = Math.round(cutU * 11) / 11;
  cancelAnimationFrame(snapRaf);
  const step = () => {
    const d = goal - cutU;
    if (Math.abs(d) < 0.001) return setCut(goal);
    setCut(cutU + d * 0.2);
    snapRaf = requestAnimationFrame(step);
  };
  snapRaf = requestAnimationFrame(step);
}
cutRange.addEventListener("change", snapCut);
let dragging = false;
const fromPointer = (e) => {
  const r = cutPlan.getBoundingClientRect();
  return ((e.clientX - r.left) / r.width - f0) / (f1 - f0);
};
cutPlan.addEventListener("pointerdown", (e) => {
  dragging = true;
  cancelAnimationFrame(snapRaf);
  cutPlan.setPointerCapture(e.pointerId);
  setCut(fromPointer(e));
});
cutPlan.addEventListener("pointermove", (e) => {
  if (dragging) setCut(fromPointer(e));
});
const endDrag = () => {
  if (!dragging) return;
  dragging = false;
  snapCut();
};
cutPlan.addEventListener("pointerup", endDrag);
cutPlan.addEventListener("pointercancel", endDrag);
addEventListener("resize", () => {
  lastCutPx = -1;
  setCut(cutU);
});
// Ohne Bewegung direkt der mittlere Schnitt; sonst ein langsamer Hinweis-Schwenk beim ersten Erscheinen
setCut(5 / 11);
let cutHinted = false;
new IntersectionObserver(
  (es) => {
    if (!es[0].isIntersecting || cutHinted || RM.matches) return;
    cutHinted = true;
    const t0 = performance.now();
    const from = cutU;
    const hint = (now) => {
      if (dragging || pinned) return;
      const t = clamp((now - t0) / 2600, 0, 1);
      setCut(from + Math.sin(t * Math.PI * 2) * 0.18 * (1 - t));
      if (t < 1) requestAnimationFrame(hint);
      else snapCut();
    };
    requestAnimationFrame(hint);
  },
  { threshold: 0.6 },
).observe(cutPlan);

// ---- Reduzierte Bewegung live, in beide Richtungen ----
let pinned = [];
function pinToFinalStates() {
  pinned = reveals.filter((el) => !el.classList.contains("in"));
  pinned.forEach((el) => el.classList.add("in", "done"));
  cancelAnimationFrame(snapRaf);
  setCut(5 / 11);
}
function unpinFinalStates() {
  for (const el of pinned) {
    if (el.getBoundingClientRect().top > innerHeight) el.classList.remove("in", "done");
  }
  pinned = [];
}
RM.addEventListener("change", (e) => {
  if (e.matches) pinToFinalStates();
  else applyHeroMode();
});

applyHeroMode();
if (RM.matches) pinToFinalStates();
requestAnimationFrame(loadRamp);
