// Panel-Layout — Standard + Persistenz (localStorage).
//
// Verwaltet den LayoutState (welche Panels in welchem Dock, aktiver Tab,
// Größen). Drei Ebenen:
//   1. defaultLayout()                 — der eingebaute Startzustand.
//   2. loadLayout()/saveLayout()       — das zuletzt benutzte Layout (1 Slot).
//   3. saveNamedLayout()/… und Co.     — benannte Layouts (Arbeitsbereiche).
//
// Sämtlicher localStorage-Zugriff ist in try/catch gekapselt und prüft, ob
// `localStorage` überhaupt existiert (SSR/Tests/Privatmodus) — Lesefehler
// liefern den Standard, Schreibfehler werden still geschluckt.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type {
  DockGroup,
  DockId,
  DockState,
  FloatingPanel,
  LayoutState,
} from "./types";

/**
 * Aktuelle Layout-Schema-Version (bei Strukturänderungen erhöhen). v2: rechtes
 * Dock standardmäßig leer, „Ressourcen" nun schwebendes Fenster statt Dock-
 * Panel. v3: schwebende Panels (`floating`). v4: Werkzeug-Palette als Kern-
 * Panel. v5: GESTAPELTE GRUPPEN — ein Dock hält eine Liste vertikaler Gruppen
 * (je eigener Tab-Stapel + aktiver Tab + Höhen-Gewicht) statt eines einzigen
 * Tab-Stapels. v6: Attribute- + Objekt-Info-Palette im Default-Layout
 * (Vectorworks-Bild). v7: Gelände-/Kontext-Palette („site") als weiterer Tab in
 * der rechten unteren Gruppe. Das Hochzählen verwirft alt gespeicherte Layouts
 * sauber auf den neuen Standard (kein Migrationspfad über die Strukturgrenze).
 */
export const LAYOUT_VERSION = 7;

/** localStorage-Schlüssel des zuletzt benutzten Layouts. */
const CURRENT_KEY = "cad.layout";
/** Präfix der localStorage-Schlüssel benannter Layouts: `cad.layouts.<name>`. */
const NAMED_PREFIX = "cad.layouts.";

/**
 * Konventionelle IDs der Kern-Panels für den Standard (entsprechen den IDs in
 * builtinPanels: "drawing-levels", "layers"). Sind diese Panels nicht
 * registriert (Plugin aus, Test), sollte der Host die IDs gegen die Registry
 * filtern (siehe `hasPanel`); das Layout selbst bleibt registry-unabhängig.
 *
 * Das rechte Dock ist standardmäßig LEER: „Ressourcen" ist kein Dock-Panel
 * mehr, sondern ein schwebendes Fenster (ResourceManager), das über die
 * Oberleiste geöffnet wird. Ein leeres Dock wird nicht gerendert, sodass die
 * Mitte (Grundriss/Perspektive) die Breite voll nutzt.
 */
/**
 * Standard-Gruppen je Dock-Seite (oben → unten) — das Vectorworks-Bild.
 * Links: Werkzeug-Palette OBEN, Attribute-Palette UNTEN. Rechts: Objekt-Info
 * OBEN, Zeichnungsebenen + Ebenen als Tab-Stapel UNTEN. (Ressourcen bleibt ein
 * schwebendes Fenster.) Jede Gruppe trägt ein Höhen-Gewicht.
 */
const DEFAULT_LEFT_GROUPS: DockGroup[] = [
  { tabs: ["tools"], activeTab: "tools", weight: 1 },
  { tabs: ["attributes"], activeTab: "attributes", weight: 1.1 },
];
const DEFAULT_RIGHT_GROUPS: DockGroup[] = [
  { tabs: ["object-info", "room-balance"], activeTab: "object-info", weight: 1 },
  {
    tabs: ["drawing-levels", "layers", "site"],
    activeTab: "drawing-levels",
    weight: 1.5,
  },
];

/** Standardbreiten der Docks in CSS-Pixeln. */
const DEFAULT_LEFT_SIZE = 280;
const DEFAULT_RIGHT_SIZE = 340;

/** Höhen-Gewicht einer neu erzeugten Gruppe (Mittel der vorhandenen, sonst 1). */
function newGroupWeight(groups: DockGroup[]): number {
  if (groups.length === 0) return 1;
  return groups.reduce((s, g) => s + g.weight, 0) / groups.length;
}

/** Tiefe (frische Objekte) Kopie einer Gruppenliste. */
function cloneGroups(groups: DockGroup[]): DockGroup[] {
  return groups.map((g) => ({ tabs: [...g.tabs], activeTab: g.activeTab, weight: g.weight }));
}

// ── Standard ────────────────────────────────────────────────────────────────

/**
 * Liefert den eingebauten Startzustand: links zwei Gruppen (Werkzeuge oben,
 * Zeichnungsebenen/Ebenen unten), rechts LEER. Jeder Aufruf erzeugt frische
 * Objekte/Arrays, damit Aufrufer das Ergebnis gefahrlos mutieren können.
 */
export function defaultLayout(): LayoutState {
  return {
    left: { groups: cloneGroups(DEFAULT_LEFT_GROUPS), size: DEFAULT_LEFT_SIZE },
    right: { groups: cloneGroups(DEFAULT_RIGHT_GROUPS), size: DEFAULT_RIGHT_SIZE },
    floating: [],
    version: LAYOUT_VERSION,
  };
}

// ── Mutations-Helfer (rein, immutabel) ──────────────────────────────────────
//
// Alle Helfer liefern ein NEUES LayoutState und mutieren die Eingabe nicht.
// Sie wahren die Invariante „jedes Panel an genau einer Stelle": ein Panel wird
// zuerst überall entfernt (beide Docks + floating), dann am Ziel eingefügt. Sie
// kennen die Registry NICHT — Aufrufer reichen gültige Panel-IDs herein.

/** Der gegenüberliegende Dock (für Aufräum-Logik). */
function otherDock(dock: DockId): DockId {
  return dock === "left" ? "right" : "left";
}

/**
 * Entfernt eine Panel-ID aus einer Gruppe (immutabel) oder liefert die Gruppe
 * unverändert zurück, wenn sie das Panel nicht enthält. Wird das Panel der
 * aktive Tab, rückt `activeTab` auf den nächstgelegenen Nachbarn (rechts, sonst
 * links); ist die Gruppe danach leer, wird `activeTab` `null`.
 */
function removeFromGroup(group: DockGroup, panelId: string): DockGroup {
  const i = group.tabs.indexOf(panelId);
  if (i < 0) return group;
  const tabs = group.tabs.filter((id) => id !== panelId);
  let activeTab = group.activeTab;
  if (activeTab === panelId) activeTab = tabs[i] ?? tabs[i - 1] ?? null;
  return { ...group, tabs, activeTab };
}

/**
 * Entfernt eine Panel-ID aus allen Gruppen eines Docks und wirft die dadurch
 * leer gewordenen Gruppen weg (immutabel). Dock-Breite bleibt erhalten.
 */
function removeFromDock(dock: DockState, panelId: string): DockState {
  const groups = dock.groups
    .map((g) => removeFromGroup(g, panelId))
    .filter((g) => g.tabs.length > 0);
  if (groups.length === dock.groups.length && groups.every((g, i) => g === dock.groups[i])) {
    return dock; // nichts geändert
  }
  return { ...dock, groups };
}

/**
 * Entfernt eine Panel-ID überall (beide Docks + floating). Basis für alle
 * „verschiebe nach …"-Helfer, damit die Eindeutigkeits-Invariante hält.
 */
function detach(layout: LayoutState, panelId: string): LayoutState {
  return {
    ...layout,
    left: removeFromDock(layout.left, panelId),
    right: removeFromDock(layout.right, panelId),
    floating: layout.floating.filter((f) => f.panelId !== panelId),
  };
}

/** Höchster vergebener z-Index der schwebenden Panels (0, wenn keine). */
function maxZ(floating: FloatingPanel[]): number {
  return floating.reduce((m, f) => Math.max(m, f.z), 0);
}

/**
 * Verschiebt ein Panel in eine BESTEHENDE Gruppe eines Docks und macht es dort
 * aktiv (Tab-Stapel zusammenlegen). Es wird zuvor überall entfernt. `tabIndex`
 * bestimmt die Einfügeposition in der Gruppe; fehlt er, wird angehängt. Liegt
 * `groupIndex` außerhalb (z. B. weil das Detachen eine Gruppe entfernt hat),
 * wird auf die letzte Gruppe geklemmt; gibt es danach keine Gruppe, wird eine
 * neue angelegt.
 */
export function moveToGroup(
  layout: LayoutState,
  panelId: string,
  dock: DockId,
  groupIndex: number,
  tabIndex?: number,
): LayoutState {
  const detached = detach(layout, panelId);
  const target = detached[dock];
  if (target.groups.length === 0) {
    return moveToNewGroup(detached, panelId, dock, 0);
  }
  const gi = Math.max(0, Math.min(groupIndex, target.groups.length - 1));
  const groups = target.groups.map((g, i) => {
    if (i !== gi) return g;
    const at =
      tabIndex === undefined
        ? g.tabs.length
        : Math.max(0, Math.min(tabIndex, g.tabs.length));
    const tabs = [...g.tabs.slice(0, at), panelId, ...g.tabs.slice(at)];
    return { ...g, tabs, activeTab: panelId };
  });
  return { ...detached, [dock]: { ...target, groups } };
}

/**
 * Legt ein Panel als NEUE Gruppe (eigener Stapel) an Position `atIndex` im Dock
 * an (für gestapelte Paletten). Es wird zuvor überall entfernt. `atIndex` wird
 * auf [0, groups.length] geklemmt; das neue Gewicht ist das Mittel der
 * vorhandenen Gruppen, damit der Stapel ausgewogen startet.
 */
export function moveToNewGroup(
  layout: LayoutState,
  panelId: string,
  dock: DockId,
  atIndex: number,
): LayoutState {
  const detached = detach(layout, panelId);
  const target = detached[dock];
  const at = Math.max(0, Math.min(atIndex, target.groups.length));
  const group: DockGroup = {
    tabs: [panelId],
    activeTab: panelId,
    weight: newGroupWeight(target.groups),
  };
  const groups = [...target.groups.slice(0, at), group, ...target.groups.slice(at)];
  return { ...detached, [dock]: { ...target, groups } };
}

/**
 * Rückwärtskompatible Hülle: verschiebt ein Panel in ein Dock, indem es als
 * neue Gruppe ans Ende gehängt wird (das natürliche Ziel beim Andocken an die
 * Rand-Zone oder beim Redock eines schwebenden Fensters).
 */
export function moveToDock(
  layout: LayoutState,
  panelId: string,
  dock: DockId,
): LayoutState {
  return moveToNewGroup(layout, panelId, dock, layout[dock].groups.length);
}

/**
 * Macht ein Panel schwebend (frei positioniert). Es wird zuvor aus jedem Dock
 * entfernt. `rect` setzt Position/Größe; das Panel kommt nach vorne (z über
 * allen anderen). War es bereits schwebend, wird sein Eintrag durch den neuen
 * (mit `rect` und Front-z) ersetzt.
 */
export function moveToFloat(
  layout: LayoutState,
  panelId: string,
  rect: { x: number; y: number; w: number; h: number },
): LayoutState {
  const detached = detach(layout, panelId);
  const z = maxZ(detached.floating) + 1;
  const panel: FloatingPanel = { panelId, ...rect, z };
  return { ...detached, floating: [...detached.floating, panel] };
}

/**
 * Ordnet einen Tab innerhalb EINER Gruppe um (immutabel). Bewegt den Tab an
 * `fromIndex` vor den Tab, der nach dem Entfernen an `toIndex` steht. Indizes
 * außerhalb des Bereichs werden geklemmt; ist nichts zu tun, kommt das Layout
 * unverändert zurück. Der aktive Tab bleibt erhalten (folgt seiner ID).
 */
export function reorderInGroup(
  layout: LayoutState,
  dock: DockId,
  groupIndex: number,
  fromIndex: number,
  toIndex: number,
): LayoutState {
  const d = layout[dock];
  const g = d.groups[groupIndex];
  if (!g) return layout;
  const n = g.tabs.length;
  if (n === 0) return layout;
  const from = Math.max(0, Math.min(fromIndex, n - 1));
  const to = Math.max(0, Math.min(toIndex, n - 1));
  if (from === to) return layout;
  const tabs = [...g.tabs];
  const [moved] = tabs.splice(from, 1);
  tabs.splice(to, 0, moved);
  const groups = d.groups.map((gr, i) => (i === groupIndex ? { ...gr, tabs } : gr));
  return { ...layout, [dock]: { ...d, groups } };
}

/**
 * Verteilt die Höhen-Gewichte der Gruppen eines Docks neu (immutabel) — vom
 * Gruppen-Splitter aufgerufen. `weights` muss so lang sein wie `groups`; zu
 * kleine/0-Werte werden auf ein Minimum angehoben, damit keine Gruppe
 * verschwindet.
 */
export function setGroupWeights(
  layout: LayoutState,
  dock: DockId,
  weights: number[],
): LayoutState {
  const d = layout[dock];
  if (weights.length !== d.groups.length) return layout;
  const groups = d.groups.map((g, i) => ({ ...g, weight: Math.max(0.05, weights[i]) }));
  return { ...layout, [dock]: { ...d, groups } };
}

/**
 * Aktualisiert ein schwebendes Panel (Position/Größe/z) per Teil-Patch. Ein
 * `z`-Wert im Patch wird übernommen wie gegeben (für gezieltes Setzen); zum
 * Nach-vorne-Holen siehe `bringToFront`. Unbekannte ID → Layout unverändert.
 */
export function updateFloat(
  layout: LayoutState,
  panelId: string,
  partial: Partial<Omit<FloatingPanel, "panelId">>,
): LayoutState {
  let changed = false;
  const floating = layout.floating.map((f) => {
    if (f.panelId !== panelId) return f;
    changed = true;
    return { ...f, ...partial };
  });
  return changed ? { ...layout, floating } : layout;
}

/**
 * Holt ein schwebendes Panel nach vorne (höchster z-Index). Ist es bereits
 * vorne (oder unbekannt), kommt das Layout unverändert zurück.
 */
export function bringToFront(layout: LayoutState, panelId: string): LayoutState {
  const top = maxZ(layout.floating);
  const current = layout.floating.find((f) => f.panelId === panelId);
  if (!current || current.z === top) return layout;
  return updateFloat(layout, panelId, { z: top + 1 });
}

/**
 * Entfernt ein schwebendes Panel aus `floating` (immutabel). Damit ist das
 * Panel an KEINER Stelle mehr — Aufrufer, die es nicht schließen, sondern
 * andocken wollen, nutzen `moveToDock`.
 */
export function removeFloat(layout: LayoutState, panelId: string): LayoutState {
  const floating = layout.floating.filter((f) => f.panelId !== panelId);
  if (floating.length === layout.floating.length) return layout;
  return { ...layout, floating };
}

/**
 * Entfernt ein Panel aus einem Dock (immutabel). Dünne, benannte Hülle um
 * `removeFromDock` auf Layout-Ebene; nützlich, um ein Panel ganz zu schließen.
 */
export function removeFromDockLayout(
  layout: LayoutState,
  dock: DockId,
  panelId: string,
): LayoutState {
  const next = removeFromDock(layout[dock], panelId);
  if (next === layout[dock]) return layout;
  return { ...layout, [dock]: next };
}

/**
 * Setzt das Panel als aktiven Tab innerhalb seiner Gruppe (immutabel). Sucht
 * die Gruppe im Dock, die das Panel enthält, und macht es dort aktiv. Liegt die
 * ID in keiner Gruppe des Docks (oder ist sie schon aktiv), kommt das Layout
 * unverändert zurück.
 */
export function setActiveTab(
  layout: LayoutState,
  dock: DockId,
  panelId: string,
): LayoutState {
  const d = layout[dock];
  const gi = d.groups.findIndex((g) => g.tabs.includes(panelId));
  if (gi < 0 || d.groups[gi].activeTab === panelId) return layout;
  const groups = d.groups.map((g, i) => (i === gi ? { ...g, activeTab: panelId } : g));
  return { ...layout, [dock]: { ...d, groups } };
}

// `otherDock` wird (noch) nicht extern gebraucht, ist aber Teil der Aufräum-
// Semantik; als Helfer exportiert, damit Wiring-Code symmetrisch arbeiten kann.
export { otherDock };

// ── localStorage-Sicherung ──────────────────────────────────────────────────

/** Liefert das localStorage-Objekt oder `null`, wenn nicht verfügbar. */
function storage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    // Zugriff kann werfen (z. B. blockierte Cookies/Privatmodus).
    return null;
  }
}

/** Liest und parst einen JSON-Wert; `null` bei Fehlen/ungültig. */
function readJson<T>(key: string): T | null {
  const ls = storage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Schreibt einen JSON-Wert; liefert `false`, wenn das Schreiben scheitert. */
function writeJson(key: string, value: unknown): boolean {
  const ls = storage();
  if (!ls) return false;
  try {
    ls.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // Kontingent überschritten oder Zugriff verweigert — still ignorieren.
    return false;
  }
}

// ── Validierung / Migration ─────────────────────────────────────────────────

/** Typwächter für eine DockGroup (toleriert Fremddaten aus localStorage). */
function isDockGroup(v: unknown): v is DockGroup {
  if (typeof v !== "object" || v === null) return false;
  const g = v as Record<string, unknown>;
  return (
    Array.isArray(g.tabs) &&
    g.tabs.every((t) => typeof t === "string") &&
    (g.activeTab === null || typeof g.activeTab === "string") &&
    typeof g.weight === "number"
  );
}

/** Typwächter für einen DockState (toleriert Fremddaten aus localStorage). */
function isDockState(v: unknown): v is DockState {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    Array.isArray(d.groups) &&
    d.groups.every(isDockGroup) &&
    typeof d.size === "number"
  );
}

/** Typwächter für einen FloatingPanel (toleriert Fremddaten aus localStorage). */
function isFloatingPanel(v: unknown): v is FloatingPanel {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  return (
    typeof f.panelId === "string" &&
    typeof f.x === "number" &&
    typeof f.y === "number" &&
    typeof f.w === "number" &&
    typeof f.h === "number" &&
    typeof f.z === "number"
  );
}

/**
 * Prüft eine geladene Struktur und führt sie bei Bedarf auf ein gültiges
 * Layout zurück. Beschädigte Daten ergeben den Standard (konservativ statt
 * Absturz).
 *
 * MIGRATION: Ältere Layouts (Version < aktuell) ohne `floating` werden
 * angehoben, statt verworfen — die Docks bleiben erhalten, `floating` wird zu
 * `[]`. So überlebt das zuletzt benutzte Layout den Umbau auf schwebende
 * Panels. Unbekannte/zukünftige (zu hohe) Versionen ergeben den Standard.
 */
function normalizeLayout(v: unknown): LayoutState {
  if (typeof v !== "object" || v === null) return defaultLayout();
  const o = v as Record<string, unknown>;
  // Andere Version (älter ODER neuer) → auf den aktuellen Standard zurückfallen.
  // So erscheinen bei Schema-/Default-Änderungen (z. B. neues Kern-Panel
  // „tools") die neuen Standard-Tabs, statt dass ein altes Layout sie verdeckt.
  if (typeof o.version !== "number" || o.version !== LAYOUT_VERSION) {
    return defaultLayout();
  }
  if (!isDockState(o.left) || !isDockState(o.right)) return defaultLayout();
  // floating fehlt in v2 → leeres Array; sonst nur gültige Einträge übernehmen.
  const floating = Array.isArray(o.floating)
    ? o.floating.filter(isFloatingPanel)
    : [];
  return {
    left: o.left,
    right: o.right,
    floating,
    version: LAYOUT_VERSION,
  };
}

// ── Aktuelles Layout (1 Slot) ───────────────────────────────────────────────

/**
 * Lädt das zuletzt benutzte Layout. Fehlt es, ist es beschädigt oder ist
 * localStorage nicht verfügbar, kommt `defaultLayout()` zurück.
 */
export function loadLayout(): LayoutState {
  const raw = readJson<unknown>(CURRENT_KEY);
  if (raw === null) return defaultLayout();
  return normalizeLayout(raw);
}

/** Speichert das aktuelle Layout. Liefert `true` bei Erfolg. */
export function saveLayout(layout: LayoutState): boolean {
  return writeJson(CURRENT_KEY, layout);
}

// ── Benannte Layouts (Arbeitsbereiche) ──────────────────────────────────────

/** Baut den localStorage-Schlüssel für ein benanntes Layout. */
function namedKey(name: string): string {
  return NAMED_PREFIX + name;
}

/** Speichert ein Layout unter einem Namen. Liefert `true` bei Erfolg. */
export function saveNamedLayout(name: string, layout: LayoutState): boolean {
  if (!name) return false;
  return writeJson(namedKey(name), layout);
}

/**
 * Lädt ein benanntes Layout. Fehlt es oder ist es beschädigt, kommt `null`
 * zurück (anders als `loadLayout`, damit Aufrufer „nicht gefunden" erkennen).
 */
export function loadNamedLayout(name: string): LayoutState | null {
  const raw = readJson<unknown>(namedKey(name));
  if (raw === null) return null;
  return normalizeLayout(raw);
}

/**
 * Listet die Namen aller gespeicherten benannten Layouts (alphabetisch
 * sortiert). Leer, wenn localStorage nicht verfügbar ist.
 */
export function listNamedLayouts(): string[] {
  const ls = storage();
  if (!ls) return [];
  const names: string[] = [];
  try {
    for (let i = 0; i < ls.length; i++) {
      const key = ls.key(i);
      if (key && key.startsWith(NAMED_PREFIX)) {
        names.push(key.slice(NAMED_PREFIX.length));
      }
    }
  } catch {
    return [];
  }
  return names.sort();
}

/** Löscht ein benanntes Layout. Liefert `true`, wenn der Zugriff gelang. */
export function deleteNamedLayout(name: string): boolean {
  const ls = storage();
  if (!ls) return false;
  try {
    ls.removeItem(namedKey(name));
    return true;
  } catch {
    return false;
  }
}
