// [277] Rendering als EIGENES natives Tauri-Fenster (statt Overlay im Hauptfenster) — Hauptfenster-Seite der Brücke, nach dem
// Muster von settingsWindow.ts. Der Auftrag selbst (Szene aus dem Kern, Cycles/Blender, Abbruch, Bild) läuft weiter im Hauptfenster
// (`state/renderJob.ts`): dort liegt das Projekt, es wird nicht doppelt gehalten. Das Fenster zeigt Einstellungen, Fortschritt
// und Bild und schickt Befehle.
//
// Hauptfenster → Fenster: „render-sync-state“ { info, job, image } bei jeder Änderung + auf „render-window-ready“ (`info` = Vorgaben aus
//   dem Projekt, `job` = Stand des Auftrags, `image` = Vorschau des fertigen PNG als Base64, nur beim Wechsel mitgeschickt).
// Fenster → Hauptfenster: „render-command“ mit { name, args } — ein Schlüssel von `RenderCommands`.
//
// Position und Grösse des Fensters merkt sich die Fensterseite (`RenderWindowApp`) in localStorage; hier die reinen Teile.
// Im Browser (und Electron) gibt es kein Nebenfenster: dort bleibt der Overlay-Dialog (`ui/RenderDialog.tsx`).

import type { RenderCommands, RenderJobState, RenderSetupInfo } from "../state/renderJob";
import { BORDERLESS_WINDOW_CHROME } from "./windowChrome";
import { useWindowBridgeHost, type WindowHandlers } from "./windowBridge";
import { t } from "../i18n";

export const RENDER_WINDOW_LABEL = "render";

/** Zustand, den das Fenster über die Brücke bekommt. `info` ist `null`, bis das Hauptfenster es gebaut hat. */
export interface RenderSyncState {
  info: RenderSetupInfo | null;
  job: RenderJobState;
  /** Vorschau des fertigen Bildes als Base64 (PNG); `null` ohne Bild. */
  image: string | null;
}

export const RENDER_WINDOW_SIZE = { width: 520, height: 760, minWidth: 400, minHeight: 480 } as const;

const GEOMETRY_KEY = "dossier.renderWindow";

/** Gemerkte Lage des Fensters (logische Pixel). */
export interface WindowGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Liest eine gemerkte Lage; Unsinn (kaputtes JSON, NaN, zu klein) gibt `null`. */
export function parseWindowGeometry(raw: string | null): WindowGeometry | null {
  if (!raw) return null;
  try {
    const g = JSON.parse(raw) as Partial<WindowGeometry>;
    const ok = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
    if (!ok(g.x) || !ok(g.y) || !ok(g.width) || !ok(g.height)) return null;
    if (g.width < RENDER_WINDOW_SIZE.minWidth || g.height < RENDER_WINDOW_SIZE.minHeight || g.width > 10000 || g.height > 10000) return null;
    if (Math.abs(g.x) > 20000 || Math.abs(g.y) > 20000) return null;
    return { x: Math.round(g.x), y: Math.round(g.y), width: Math.round(g.width), height: Math.round(g.height) };
  } catch {
    return null;
  }
}

export function loadWindowGeometry(): WindowGeometry | null {
  try {
    return parseWindowGeometry(localStorage.getItem(GEOMETRY_KEY));
  } catch {
    return null;
  }
}

export function saveWindowGeometry(g: WindowGeometry): void {
  try {
    localStorage.setItem(GEOMETRY_KEY, JSON.stringify(g));
  } catch {
    /* Speicher gesperrt: Lage gilt nur bis zum Schliessen */
  }
}

/** Öffnet das native Rendering-Fenster (bzw. holt es nach vorne). */
export async function openRenderWindowNative(): Promise<void> {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const existing = await WebviewWindow.getByLabel(RENDER_WINDOW_LABEL);
  if (existing) {
    await existing.setFocus();
    return;
  }
  const g = loadWindowGeometry();
  new WebviewWindow(RENDER_WINDOW_LABEL, {
    url: "index.html?window=render",
    title: `${t("render.title")} — dossier`,
    width: g?.width ?? RENDER_WINDOW_SIZE.width,
    height: g?.height ?? RENDER_WINDOW_SIZE.height,
    ...(g ? { x: g.x, y: g.y } : {}),
    minWidth: RENDER_WINDOW_SIZE.minWidth,
    minHeight: RENDER_WINDOW_SIZE.minHeight,
    ...BORDERLESS_WINDOW_CHROME,
  });
}

/** Ist das Rendering-Fenster offen? (Nur Tauri.) */
export async function renderWindowExists(): Promise<boolean> {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  return (await WebviewWindow.getByLabel(RENDER_WINDOW_LABEL)) !== null;
}

/** PNG-Bytes als Base64 (in Stücken, damit `btoa` bei grossen Bildern nicht am Stapel scheitert). */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(out);
}

/** Hauptfenster-Seite der Sync-Brücke: hält das Rendering-Fenster (falls offen) synchron und führt dessen Befehle aus. No-op ausserhalb von Tauri. */
export function useRenderWindowHost(state: RenderSyncState, commands: RenderCommands): void {
  useWindowBridgeHost(RENDER_WINDOW_LABEL, "render", state, commands as unknown as WindowHandlers);
}
