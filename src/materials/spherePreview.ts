// PBR-Materialkugel-Vorschau (CAD/DCC-üblich) für den Ressourcen-Manager.
// EIN geteilter offscreen three.js-Renderer erzeugt nacheinander pro Material
// eine Kugel und cached das Ergebnis als PNG-DataURL — bewusst NICHT ein
// WebGL-Context je Kachel (Browser begrenzt gleichzeitige Kontexte). Aufträge
// laufen seriell über eine Warteschlange, damit Renderer/Szene/Material sich
// nie zwei Materialien gleichzeitig "gehören".
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import * as THREE from "three";
import type { MaterialAsset, MaterialMapKind } from "./library";

/** Kantenlänge der gerenderten Vorschau in Pixeln (CSS skaliert die Kachel). */
const PREVIEW_SIZE = 128;

type PreviewStatus = "pending" | "ready" | "error";

interface PreviewEntry {
  status: PreviewStatus;
  url?: string;
  subscribers: Set<(url: string) => void>;
}

/** Fertige/aktive Vorschauen, Schlüssel = stabile Material-Signatur. */
const cache = new Map<string, PreviewEntry>();

/**
 * Stabile Cache-Signatur eines Assets: ändert sich, sobald sich eine Karten-
 * URL ändert (z. B. weil die Bibliothek neu generiert wurde) — dadurch wird
 * eine veraltete Vorschau automatisch verworfen, auch bei gleicher ID.
 */
function signatureOf(asset: MaterialAsset): string {
  const m = asset.maps;
  return [
    asset.id,
    m.color ?? "",
    m.normal ?? "",
    m.roughness ?? "",
    m.metalness ?? "",
    m.ao ?? "",
    m.displacement ?? "",
  ].join("|");
}

// ── Geteilte Render-Infrastruktur (eine Instanz für die gesamte App-Laufzeit) ─

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let sphereMesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial> | null =
  null;

function ensureRenderer(): void {
  if (renderer) return;

  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true, // nötig für toDataURL() nach dem Render.
  });
  renderer.setSize(PREVIEW_SIZE, PREVIEW_SIZE);
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0); // transparent — die Kachel liefert den Hintergrund.

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(32, 1, 0.1, 10);
  camera.position.set(0, 0.12, 3.1);
  camera.lookAt(0, 0, 0);

  // Neutrale Studio-Beleuchtung: Himmelslicht (füllt Schatten weich auf) plus
  // ein Key-Light für Glanzlichter/Rauheits-Lesbarkeit, ein dezentes Fülllicht
  // gegen zu harte Kernschatten.
  scene.add(new THREE.HemisphereLight(0xffffff, 0x2c2c28, 1.15));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(2.2, 2.6, 2.4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.45);
  fill.position.set(-2.2, 0.5, 1.3);
  scene.add(fill);

  const geometry = new THREE.SphereGeometry(1, 48, 48);
  const material = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
  sphereMesh = new THREE.Mesh(geometry, material);
  scene.add(sphereMesh);
}

// ── Textur-Ladecache (geteilte Quell-Texturen je URL) ──────────────────────

const textureLoader = new THREE.TextureLoader();
const textureCache = new Map<string, THREE.Texture>();

function loadTexture(url: string, srgb: boolean): Promise<THREE.Texture> {
  const key = `${srgb ? "s" : "l"}|${url}`;
  const cached = textureCache.get(key);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    textureLoader.load(
      url,
      (tex) => {
        tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        textureCache.set(key, tex);
        resolve(tex);
      },
      undefined,
      () => reject(new Error(`Textur nicht ladbar: ${url}`)),
    );
  });
}

const MAP_SLOTS: { kind: MaterialMapKind; srgb: boolean }[] = [
  { kind: "color", srgb: true },
  { kind: "normal", srgb: false },
  { kind: "roughness", srgb: false },
  { kind: "metalness", srgb: false },
  { kind: "ao", srgb: false },
  { kind: "displacement", srgb: false },
];

/** Rendert die Vorschau-Kugel eines Assets und liefert eine PNG-DataURL. */
async function renderPreview(asset: MaterialAsset): Promise<string> {
  ensureRenderer();
  const mat = sphereMesh!.material;

  // Karten der zuvor gerenderten Kugel lösen (kein Überstand ins nächste Material).
  mat.map = null;
  mat.normalMap = null;
  mat.roughnessMap = null;
  mat.metalnessMap = null;
  mat.aoMap = null;
  mat.displacementMap = null;
  mat.displacementScale = 0;

  const loaded = await Promise.allSettled(
    MAP_SLOTS.map(async ({ kind, srgb }) => {
      const url = asset.maps[kind];
      if (!url) return null;
      const tex = await loadTexture(url, srgb);
      return { kind, tex };
    }),
  );
  for (const res of loaded) {
    if (res.status !== "fulfilled" || !res.value) continue;
    const { kind, tex } = res.value;
    switch (kind) {
      case "color":
        mat.map = tex;
        break;
      case "normal":
        mat.normalMap = tex;
        break;
      case "roughness":
        mat.roughnessMap = tex;
        break;
      case "metalness":
        mat.metalnessMap = tex;
        break;
      case "ao":
        mat.aoMap = tex;
        break;
      case "displacement":
        mat.displacementMap = tex;
        // Dezent — die eigentliche Tiefe liest sich über die Normal-Map.
        mat.displacementScale = 0.04;
        break;
    }
  }
  // Weiß als Albedo-Basis (Farb-Karte bleibt unverfälscht), sonst neutrales Grau.
  mat.color.set(asset.maps.color ? 0xffffff : 0xcccccc);
  mat.metalness = asset.maps.metalness ? 1 : 0;
  mat.needsUpdate = true;

  renderer!.render(scene!, camera!);
  return renderer!.domElement.toDataURL("image/png");
}

// ── Serielle Warteschlange (ein Render-Auftrag zur Zeit, geteilter Kontext) ─

let queue: Promise<void> = Promise.resolve();

/**
 * Fordert die Kugel-Vorschau eines Bibliotheks-Materials an. Liefert sofort
 * die gecachte DataURL, falls schon fertig gerendert; andernfalls wird der
 * Render-Auftrag (serialisiert über die geteilte Warteschlange) eingereiht und
 * `onReady` genau einmal mit der fertigen URL aufgerufen. Wiederholte Aufrufe
 * mit demselben Material treffen den Cache (kein erneutes Rendern) — außer die
 * Karten-Signatur hat sich geändert (Bibliothek aktualisiert).
 */
export function requestMaterialPreview(
  asset: MaterialAsset,
  onReady: (url: string) => void,
): string | undefined {
  const key = signatureOf(asset);
  let entry = cache.get(key);
  if (!entry) {
    entry = { status: "pending", subscribers: new Set() };
    cache.set(key, entry);
    queue = queue
      .then(() => renderPreview(asset))
      .then((url) => {
        entry!.status = "ready";
        entry!.url = url;
        for (const cb of entry!.subscribers) cb(url);
        entry!.subscribers.clear();
      })
      .catch((err) => {
        entry!.status = "error";
        entry!.subscribers.clear();
        console.error("[spherePreview] Vorschau-Render fehlgeschlagen:", err);
      });
  }
  if (entry.status === "ready" && entry.url) return entry.url;
  entry.subscribers.add(onReady);
  return undefined;
}

/** Meldet einen Abonnenten wieder ab (Aufräumen bei Unmount vor Fertigstellung). */
export function cancelMaterialPreview(
  asset: MaterialAsset,
  onReady: (url: string) => void,
): void {
  cache.get(signatureOf(asset))?.subscribers.delete(onReady);
}
