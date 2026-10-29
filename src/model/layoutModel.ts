// Layout-Blätter mit Masterlayout (DOSSIER A3) — reine, testbare Logik.
//
// Enthält KEINE React-/DOM-Abhängigkeit: immutable CRUD auf Layouts/Master/Viewports, die
// Master-Vererbung der Titelblock-Werte, die Auflösung eines Viewports auf seinen gebundenen
// Ausschnitt und die Blatt-Geometrie (Papier-mm). Das UI-Wiring (App.tsx setProject, LayoutEditor-
// Rendering) baut hierauf auf.
//
// Rechnung im Rust-Kern ([K4] S3, `src-tauri/core/src/layout_model.rs`, `folder_tree.rs`): Blattgrössen,
// Ordner-Bäume (Aufbau, Blätter eines Ordners, Löschen, Nachfahren-Test), Seitenplanung des Ordner-PDF und
// Titelblock. Hier bleiben Fabriken, einfache Listen-Änderungen (Viewports, Annotationen, Blatt verschieben)
// und Nachschlagen; die Baum-Fassaden setzen die Knoten aus den Indizes des Kerns mit den Original-Objekten
// zusammen (Objekt-Identität bleibt).
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type {
  Layout,
  LayoutAnnotation,
  LayoutAnnotationPatch,
  LayoutFolder,
  LayoutOrientation,
  LayoutPaperFormat,
  LayoutViewport,
  MasterLayout,
  Project,
  ViewSnapshot,
} from "./types";
import { core } from "../engine/coreWasm";
import { documentFor } from "../core/document";
import { isDescendantFolder, treeBuild, treeCollect, treeDelete } from "./folderTree";

// ── Blatt-Geometrie ──────────────────────────────────────────────────────────

/**
 * Auswahlreihenfolge der Standard-Formate für Dropdowns (A-Reihe, dann B-Reihe).
 * Gruppierbar über {@link PAPER_FORMAT_GROUPS} (A/B) für optgroups.
 */
export const PAPER_FORMATS: LayoutPaperFormat[] = [
  "a0", "a1", "a2", "a3", "a4", "a5", "a6",
  "b0", "b1", "b2", "b3", "b4", "b5", "b6",
];

/** Format-Liste je Reihe (A/B) — für gruppierte Dropdown-Anzeige (optgroup). */
export const PAPER_FORMAT_GROUPS: { label: string; formats: LayoutPaperFormat[] }[] = [
  { label: "A", formats: ["a0", "a1", "a2", "a3", "a4", "a5", "a6"] },
  { label: "B", formats: ["b0", "b1", "b2", "b3", "b4", "b5", "b6"] },
];

/**
 * Blattmasse (mm) nach Format + Ausrichtung (Quer = Basis gedreht). Sind
 * `customWidthMm`/`customHeightMm` (freie Grösse) gesetzt und positiv, gewinnen
 * sie und `paper`/`orientation` werden ignoriert (additiv — Alt-Aufrufe ohne
 * Custom-Argumente verhalten sich unverändert).
 */
export function sheetSizeMm(
  paper: LayoutPaperFormat,
  orientation: LayoutOrientation,
  customWidthMm?: number,
  customHeightMm?: number,
): { w: number; h: number } {
  const out = core().layout_call(
    "sheetSize",
    JSON.stringify({ paper, landscape: orientation === "landscape", customWidthMm, customHeightMm }),
  );
  if (out === "") throw new Error(`Kern: unbekanntes Blattformat „${paper}"`);
  return JSON.parse(out) as { w: number; h: number };
}

/**
 * Effektive Blattgrösse eines Layouts/Masters (mm) — respektiert die freie
 * Grösse (`customWidthMm`/`customHeightMm`), sonst `paper`+`orientation`. EIN
 * Ort für die „Custom übersteuert Papier"-Regel (Panel/PDF/Editor teilen ihn).
 */
export function effectiveSheetSizeMm(item: {
  paper: LayoutPaperFormat;
  orientation: LayoutOrientation;
  customWidthMm?: number;
  customHeightMm?: number;
}): { w: number; h: number } {
  return sheetSizeMm(
    item.paper,
    item.orientation,
    item.customWidthMm,
    item.customHeightMm,
  );
}

// ── Fabriken ─────────────────────────────────────────────────────────────────

/** Neues, leeres Layout (ohne Viewports, ohne Master). */
export function createLayout(
  id: string,
  name: string,
  paper: LayoutPaperFormat,
  orientation: LayoutOrientation,
): Layout {
  return { id, name, paper, orientation, viewports: [] };
}

/** Neues Masterlayout mit leerem Titelblock + gezeichnetem Rahmen. */
export function createMasterLayout(
  id: string,
  name: string,
  paper: LayoutPaperFormat,
  orientation: LayoutOrientation,
  custom?: { widthMm: number; heightMm: number },
): MasterLayout {
  return {
    id,
    name,
    paper,
    orientation,
    titleBlock: {},
    border: true,
    ...(custom ? { customWidthMm: custom.widthMm, customHeightMm: custom.heightMm } : {}),
  };
}

/**
 * Neuer, leerer Ordner für den Layouts- ODER Master-Baum. `kind:"master"` markiert
 * einen Master-Ordner; `"layout"`/`undefined` bleibt ein (rückwärtskompatibler)
 * Layout-Ordner — das Feld wird dann NICHT gesetzt (Alt-Projekte unverändert).
 */
export function createLayoutFolder(
  id: string,
  name: string,
  parentId?: string,
  kind?: "layout" | "master",
): LayoutFolder {
  return {
    id,
    name,
    ...(parentId ? { parentId } : {}),
    ...(kind === "master" ? { kind } : {}),
  };
}

// ── Layouts-Baum (Ordner + Blätter) ──────────────────────────────────────────

/** Ein Ordner-Knoten im Baum: der Ordner, seine Unterordner und direkten Blätter. */
export interface FolderNode {
  folder: LayoutFolder;
  subfolders: FolderNode[];
  layouts: Layout[];
}

/** Der aufgebaute Baum: Wurzel-Blätter (ohne Ordner) + Wurzel-Ordner. */
export interface LayoutTree {
  /** Layouts ohne (gültigen) `folderId` — auf Wurzelebene. */
  rootLayouts: Layout[];
  /** Ordner ohne (gültigen) `parentId` — auf Wurzelebene, je mit Unterbaum. */
  rootFolders: FolderNode[];
}

/**
 * Baut aus der flachen Ordner-/Layout-Liste den verschachtelten Baum. Robust
 * gegen verwaiste Referenzen: ein Layout mit unbekanntem `folderId` bzw. ein
 * Ordner mit unbekanntem `parentId` landet auf der Wurzelebene (so bleiben
 * Alt-/Teilprojekte sichtbar). Die Eingabe-Reihenfolge bleibt je Ebene erhalten.
 */
export function buildLayoutTree(
  folders: LayoutFolder[],
  layouts: Layout[],
): LayoutTree {
  const shape = treeBuild(folders, layouts);
  const nodes: FolderNode[] = folders.map((folder) => ({ folder, subfolders: [], layouts: [] }));
  shape.nodes.forEach((n, i) => {
    nodes[i].subfolders = n.subfolders.map((j) => nodes[j]);
    nodes[i].layouts = n.leaves.map((k) => layouts[k]);
  });
  return {
    rootLayouts: shape.rootLeaves.map((k) => layouts[k]),
    rootFolders: shape.rootFolders.map((j) => nodes[j]),
  };
}

// ── Master-Baum (Ordner + Masterlayouts) ─────────────────────────────────────
// Eigener Baum NEBEN dem Layout-Baum: Master-Ordner (`kind:"master"`) tragen
// Masterlayouts als Blätter. Bewusst KEINE gemeinsame Struktur mit dem Layout-
// Baum, damit Layout- und Master-Ordner nie vermischt werden.

/** Ein Master-Ordner-Knoten: der Ordner, seine Unterordner und direkten Master. */
export interface MasterFolderNode {
  folder: LayoutFolder;
  subfolders: MasterFolderNode[];
  masters: MasterLayout[];
}

/** Der Master-Baum: Wurzel-Master (ohne Ordner) + Wurzel-Ordner. */
export interface MasterTree {
  /** Masterlayouts ohne (gültigen) `folderId` — auf Wurzelebene. */
  rootMasters: MasterLayout[];
  /** Master-Ordner ohne (gültigen) `parentId` — je mit Unterbaum. */
  rootFolders: MasterFolderNode[];
}

/**
 * Baut aus der flachen Master-Ordner-/Master-Liste den verschachtelten Baum —
 * analog {@link buildLayoutTree}, aber mit Masterlayouts als Blättern. Der
 * Aufrufer übergibt bereits die NUR-Master-Ordner (kind:"master"); verwaiste
 * Referenzen landen robust auf der Wurzelebene.
 */
export function buildMasterTree(
  folders: LayoutFolder[],
  masters: MasterLayout[],
): MasterTree {
  const shape = treeBuild(folders, masters);
  const nodes: MasterFolderNode[] = folders.map((folder) => ({ folder, subfolders: [], masters: [] }));
  shape.nodes.forEach((n, i) => {
    nodes[i].subfolders = n.subfolders.map((j) => nodes[j]);
    nodes[i].masters = n.leaves.map((k) => masters[k]);
  });
  return {
    rootMasters: shape.rootLeaves.map((k) => masters[k]),
    rootFolders: shape.rootFolders.map((j) => nodes[j]),
  };
}

/**
 * Alle Layouts eines Ordners in Baum-Reihenfolge — direkte Blätter zuerst, dann
 * (rekursiv) die Blätter der Unterordner. Für den Ordner→Mehrseiten-PDF-Export
 * (jedes Layout = eine Seite, deterministische Reihenfolge).
 */
export function collectFolderLayouts(
  folderId: string,
  folders: LayoutFolder[],
  layouts: Layout[],
): Layout[] {
  return treeCollect(folders, layouts, folderId).map((k) => layouts[k]);
}

/** Eine geplante Ordner-PDF-Seite: das Layout + seine effektive Blattgrösse (mm). */
export interface FolderPdfPage {
  layout: Layout;
  widthMm: number;
  heightMm: number;
}

/**
 * Reine Seiten-Planung des Ordner→Mehrseiten-PDF (ohne DOM/jsPDF): welche
 * Layouts in welcher Reihenfolge mit welcher Blattgrösse. Reihenfolge =
 * Baum-Reihenfolge (siehe {@link collectFolderLayouts}). Die effektive Grösse
 * respektiert die freie Grösse (Custom übersteuert Papier); ein gebundener
 * Master erzwingt die Blattgrösse (das Blatt erbt Papier/Ausrichtung des Masters).
 */
export function folderPdfPages(
  project: Project,
  folderId: string,
): FolderPdfPage[] {
  const layouts = project.layouts ?? [];
  return documentFor(project)
    .queryRoot<{ layout: number; widthMm: number; heightMm: number }[]>("folderPdfPages", folderId)
    .map((p) => ({ layout: layouts[p.layout], widthMm: p.widthMm, heightMm: p.heightMm }));
}

/**
 * Löscht einen Ordner (immutabel). Unterordner und Layouts des Ordners werden
 * auf die Ebene des gelöschten Ordners (dessen `parentId`) hochgezogen, statt
 * mitgelöscht zu werden — es gehen keine Blätter verloren. Liefert die neuen
 * `folders`/`layouts`-Listen.
 */
export function deleteFolder(
  folderId: string,
  folders: LayoutFolder[],
  layouts: Layout[],
): { folders: LayoutFolder[]; layouts: Layout[] } {
  const plan = treeDelete(folders, layouts, folderId);
  return {
    folders: foldersAfterDelete(folders, plan.folders),
    layouts: layouts.map((l, i) => {
      const c = plan.leaves[i];
      return c === null ? l : { ...l, folderId: c.v ?? undefined };
    }),
  };
}

/**
 * Löscht einen Master-Ordner (immutabel) — analog {@link deleteFolder}, aber die
 * enthaltenen Masterlayouts (und Unterordner) werden auf die Elternebene
 * hochgezogen statt mitgelöscht. Liefert die neuen `folders`/`masters`-Listen.
 */
export function deleteMasterFolder(
  folderId: string,
  folders: LayoutFolder[],
  masters: MasterLayout[],
): { folders: LayoutFolder[]; masters: MasterLayout[] } {
  const plan = treeDelete(folders, masters, folderId);
  return {
    folders: foldersAfterDelete(folders, plan.folders),
    masters: masters.map((m, i) => {
      const c = plan.leaves[i];
      return c === null ? m : { ...m, folderId: c.v ?? undefined };
    }),
  };
}

/**
 * Behaltene Ordner nach dem Löschen: direkte Unterordner rücken auf die Elternebene. Das `kind`-Feld bleibt
 * dabei ERHALTEN (Spread statt Neu-Bau), damit ein hochgezogener Master-Ordner nicht versehentlich zum
 * Layout-Ordner wird.
 */
function foldersAfterDelete(folders: LayoutFolder[], kept: [number, { v: string | null } | null][]): LayoutFolder[] {
  return kept.map(([i, c]) => (c === null ? folders[i] : c.v ? { ...folders[i], parentId: c.v } : stripParentId(folders[i])));
}

/** Ordner auf die Wurzelebene setzen (parentId entfernen, `kind` bleibt erhalten). */
function stripParentId(folder: LayoutFolder): LayoutFolder {
  const next = { ...folder };
  delete next.parentId;
  return next;
}

// ── Baum-Umsortieren (Drag & Drop) ───────────────────────────────────────────

/**
 * Ist `candidateId` gleich `rootId` oder ein Nachfahre von `rootId`? Für den
 * Zyklus-Schutz beim Ordner-in-Ordner-Verschieben: ein Ordner darf NICHT in sich
 * selbst oder einen seiner Nachfahren wandern (sonst löst sich der Ast vom Baum).
 * Robust gegen kaputte `parentId`-Ketten (bricht bei unbekannter Referenz ab).
 */
export function isDescendant(
  folders: LayoutFolder[],
  candidateId: string,
  rootId: string,
): boolean {
  return isDescendantFolder(folders, candidateId, rootId);
}

/**
 * Verschiebt ein Layout in einen anderen Ordner (immutabel). `folderId = null`
 * → zurück auf die Wurzelebene. No-op, wenn die Layout-Id fehlt.
 */
export function moveLayoutToFolder(
  layouts: Layout[],
  layoutId: string,
  folderId: string | null,
): Layout[] {
  return layouts.map((l) => {
    if (l.id !== layoutId) return l;
    if (folderId) return { ...l, folderId };
    const next = { ...l };
    delete next.folderId;
    return next;
  });
}

/**
 * Verschiebt einen Ordner unter einen neuen Elternordner (immutabel).
 * `parentId = null` → Wurzelebene. Verhindert Zyklen: ein Ordner kann nicht in
 * sich selbst oder einen seiner Nachfahren wandern (dann No-op — Original zurück).
 */
export function moveFolderToFolder(
  folders: LayoutFolder[],
  folderId: string,
  parentId: string | null,
): LayoutFolder[] {
  if (parentId && isDescendant(folders, parentId, folderId)) return folders;
  return folders.map((f) => {
    if (f.id !== folderId) return f;
    if (parentId) return { ...f, parentId };
    return stripParentId(f);
  });
}

/**
 * Neuer Viewport (Standardgrösse/-position). `snapshotId` bindet ihn an einen
 * Ausschnitt; Position/Grösse in Papier-mm setzt der Aufrufer per {@link patchViewport}.
 */
export function createViewport(
  id: string,
  snapshotId: string,
  init?: Partial<Omit<LayoutViewport, "id" | "snapshotId">>,
): LayoutViewport {
  return {
    id,
    snapshotId,
    xMm: init?.xMm ?? 20,
    yMm: init?.yMm ?? 20,
    widthMm: init?.widthMm ?? 120,
    heightMm: init?.heightMm ?? 90,
    ...(init?.scaleDenominator !== undefined
      ? { scaleDenominator: init.scaleDenominator }
      : {}),
  };
}

// ── Immutable CRUD (Viewports auf einem Layout) ──────────────────────────────

/** Fügt einen Viewport an (immutabel). */
export function addViewport(layout: Layout, viewport: LayoutViewport): Layout {
  return { ...layout, viewports: [...layout.viewports, viewport] };
}

/** Entfernt einen Viewport per Id (immutabel). */
export function removeViewport(layout: Layout, viewportId: string): Layout {
  return {
    ...layout,
    viewports: layout.viewports.filter((v) => v.id !== viewportId),
  };
}

/** Ändert Felder eines Viewports (immutabel). No-op, wenn die Id fehlt. */
export function patchViewport(
  layout: Layout,
  viewportId: string,
  patch: Partial<Omit<LayoutViewport, "id">>,
): Layout {
  return {
    ...layout,
    viewports: layout.viewports.map((v) =>
      v.id === viewportId ? { ...v, ...patch } : v,
    ),
  };
}

// ── Fabrik + immutable CRUD (Annotationen auf einem Layout) ─────────────────
// Analog zu Viewports: Linie/Rechteck/Text als vom Viewport-Baum unabhängige
// Markup-Schicht in Papier-mm. `annotations ?? []` ist überall die Basis, damit
// Alt-Layouts (ohne das Feld) unverändert bleiben (additiv).

/**
 * Neue Annotation mit Default-Geometrie je Art (Linie/Rechteck: sichtbare
 * Mindestgrösse; Text: 3.5 mm Zeilenhöhe, wie im Attribute-Editor üblich).
 * `init` überschreibt einzelne Felder — der Aufrufer (Editor) übergibt i. d. R.
 * die vollständige, aus dem Zeichnen gewonnene Geometrie.
 */
export function createAnnotation(
  id: string,
  kind: LayoutAnnotation["kind"],
  init: LayoutAnnotationPatch = {},
): LayoutAnnotation {
  const colorPatch = init.color !== undefined ? { color: init.color } : {};
  if (kind === "line") {
    return {
      id,
      kind: "line",
      x1Mm: init.x1Mm ?? 20,
      y1Mm: init.y1Mm ?? 20,
      x2Mm: init.x2Mm ?? 80,
      y2Mm: init.y2Mm ?? 20,
      ...colorPatch,
      ...(init.weightMm !== undefined ? { weightMm: init.weightMm } : {}),
    };
  }
  if (kind === "rect") {
    return {
      id,
      kind: "rect",
      xMm: init.xMm ?? 20,
      yMm: init.yMm ?? 20,
      widthMm: init.widthMm ?? 40,
      heightMm: init.heightMm ?? 30,
      ...colorPatch,
      ...(init.weightMm !== undefined ? { weightMm: init.weightMm } : {}),
    };
  }
  if (kind === "image") {
    return {
      id,
      kind: "image",
      xMm: init.xMm ?? 20,
      yMm: init.yMm ?? 20,
      widthMm: init.widthMm ?? 60,
      heightMm: init.heightMm ?? 40,
      src: init.src ?? "",
      ...(init.opacity !== undefined ? { opacity: init.opacity } : {}),
    };
  }
  return {
    id,
    kind: "text",
    xMm: init.xMm ?? 20,
    yMm: init.yMm ?? 20,
    text: init.text ?? "",
    heightMm: init.heightMm ?? 3.5,
    ...colorPatch,
    ...(init.doc !== undefined ? { doc: init.doc } : {}),
    ...(init.widthMm !== undefined ? { widthMm: init.widthMm } : {}),
  };
}

/** Fügt eine Annotation an (immutabel). */
export function addAnnotation(layout: Layout, annotation: LayoutAnnotation): Layout {
  return { ...layout, annotations: [...(layout.annotations ?? []), annotation] };
}

/** Entfernt eine Annotation per Id (immutabel). */
export function removeAnnotation(layout: Layout, annotationId: string): Layout {
  return {
    ...layout,
    annotations: (layout.annotations ?? []).filter((a) => a.id !== annotationId),
  };
}

/**
 * Ändert Felder einer Annotation (immutabel). No-op, wenn die Id fehlt. Der
 * Patch ist bewusst art-unabhängig ({@link LayoutAnnotationPatch}) — es werden
 * nur die tatsächlich übergebenen Felder gemergt.
 */
export function patchAnnotation(
  layout: Layout,
  annotationId: string,
  patch: LayoutAnnotationPatch,
): Layout {
  return {
    ...layout,
    annotations: (layout.annotations ?? []).map((a) =>
      a.id === annotationId ? ({ ...a, ...patch } as LayoutAnnotation) : a,
    ),
  };
}

// ── Auflösungen ──────────────────────────────────────────────────────────────

/** Findet einen Ausschnitt (View-Snapshot) im Projekt. */
export function findSnapshot(
  project: Project,
  snapshotId: string,
): ViewSnapshot | undefined {
  return (project.viewSnapshots ?? []).find((s) => s.id === snapshotId);
}

/** Findet das Masterlayout eines Layouts (falls gebunden). */
export function findMaster(
  project: Project,
  layout: Layout,
): MasterLayout | undefined {
  if (!layout.masterId) return undefined;
  return (project.masterLayouts ?? []).find((m) => m.id === layout.masterId);
}

/**
 * Effektiver Massstab-Nenner eines Viewports: sein `scaleDenominator` übersteuert
 * den des gebundenen Ausschnitts. Fällt auf `fallback` zurück, wenn weder
 * Viewport noch Ausschnitt einen Wert tragen (defensiv, sollte nicht auftreten).
 */
export function resolveViewportScale(
  viewport: LayoutViewport,
  snapshot: ViewSnapshot | undefined,
  fallback = 100,
): number {
  return viewport.scaleDenominator ?? snapshot?.scaleDenominator ?? fallback;
}

/** Aufgelöste Titelblock-Werte (alle Felder gefüllt) für die Darstellung. */
export interface ResolvedTitleBlock {
  projectName: string;
  sheetName: string;
  scale: string;
  date: string;
  author: string;
  /** Plannummer: `Layout.planNumber`, sonst laufende Nummer des Blatts im Projekt ("01", "02" …). */
  planNumber: string;
}

/**
 * Master-Vererbung der Titelblock-Werte: der Master liefert die Vorlagen-Texte;
 * leere Felder werden aus Projekt/Layout mit sinnvollen Defaults gefüllt
 * (Projektname ← `Project.name`, Blattname ← `Layout.name`, Datum ← `today`).
 * Ohne Master bleibt der Titelblock trotzdem sinnvoll befüllt (nur Defaults).
 * Der `scale`-Default ergibt sich aus dem ERSTEN Viewport des Layouts (falls
 * vorhanden), damit ein Ein-Viewport-Blatt gleich seinen Massstab trägt.
 */
export function resolveTitleBlock(
  project: Project,
  layout: Layout,
  master: MasterLayout | undefined,
  today: string = new Date().toISOString().slice(0, 10),
): ResolvedTitleBlock {
  const arg = {
    layout: { id: layout.id, name: layout.name, planNumber: layout.planNumber, viewports: (layout.viewports ?? []).slice(0, 1) },
    master: master ? { titleBlock: master.titleBlock } : null,
    today,
  };
  return documentFor(project).queryRoot<ResolvedTitleBlock>("layoutTitleBlock", JSON.stringify(arg));
}

/**
 * Sichtbare Kategorie-Codes eines Ausschnitts als Set (für `generatePlan`). Aus
 * der gespeicherten `layerVisibility`-Map (Code → sichtbar) abgeleitet.
 */
export function visibleCodesFromSnapshot(snap: ViewSnapshot): Set<string> {
  const out = new Set<string>();
  // Fehlt die Map (Datei/Import), ist nichts sichtbar — kein Absturz.
  for (const [code, visible] of Object.entries(snap.layerVisibility ?? {})) {
    if (visible) out.add(code);
  }
  return out;
}
