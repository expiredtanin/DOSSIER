// Layout-Blätter mit Masterlayout (DOSSIER A3) — reine, testbare Logik.
//
// Enthält KEINE React-/DOM-Abhängigkeit: nur immutable CRUD auf Layouts/Master/
// Viewports, die Master-Vererbung der Titelblock-Werte, die Auflösung eines
// Viewports auf seinen gebundenen Ausschnitt und die Blatt-Geometrie (Papier-mm).
// Das UI-Wiring (App.tsx setProject, LayoutEditor-Rendering) baut hierauf auf.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type {
  Layout,
  LayoutAnnotation,
  LayoutAnnotationPatch,
  LayoutFolder,
  LayoutOrientation,
  LayoutPaperFormat,
  LayoutTitleBlock,
  LayoutViewport,
  MasterLayout,
  Project,
  ViewSnapshot,
} from "../model/types";

// ── Blatt-Geometrie ──────────────────────────────────────────────────────────

/**
 * Blattmasse je Format im Hochformat (mm) — offizielle ISO-216-Masse (auf ganze
 * mm gerundet). A-Reihe A0–A6 und B-Reihe B0–B6.
 */
const PAGE_MM: Record<LayoutPaperFormat, { w: number; h: number }> = {
  a0: { w: 841, h: 1189 },
  a1: { w: 594, h: 841 },
  a2: { w: 420, h: 594 },
  a3: { w: 297, h: 420 },
  a4: { w: 210, h: 297 },
  a5: { w: 148, h: 210 },
  a6: { w: 105, h: 148 },
  b0: { w: 1000, h: 1414 },
  b1: { w: 707, h: 1000 },
  b2: { w: 500, h: 707 },
  b3: { w: 353, h: 500 },
  b4: { w: 250, h: 353 },
  b5: { w: 176, h: 250 },
  b6: { w: 125, h: 176 },
};

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
  if (
    customWidthMm !== undefined &&
    customHeightMm !== undefined &&
    customWidthMm > 0 &&
    customHeightMm > 0
  ) {
    return { w: customWidthMm, h: customHeightMm };
  }
  const base = PAGE_MM[paper];
  return orientation === "landscape" ? { w: base.h, h: base.w } : base;
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
  const folderIds = new Set(folders.map((f) => f.id));
  const nodes = new Map<string, FolderNode>();
  for (const f of folders) {
    nodes.set(f.id, { folder: f, subfolders: [], layouts: [] });
  }

  const rootFolders: FolderNode[] = [];
  for (const f of folders) {
    const node = nodes.get(f.id)!;
    const parent =
      f.parentId && folderIds.has(f.parentId) ? nodes.get(f.parentId) : undefined;
    if (parent) parent.subfolders.push(node);
    else rootFolders.push(node);
  }

  const rootLayouts: Layout[] = [];
  for (const l of layouts) {
    const node =
      l.folderId && folderIds.has(l.folderId) ? nodes.get(l.folderId) : undefined;
    if (node) node.layouts.push(l);
    else rootLayouts.push(l);
  }

  return { rootLayouts, rootFolders };
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
  const folderIds = new Set(folders.map((f) => f.id));
  const nodes = new Map<string, MasterFolderNode>();
  for (const f of folders) {
    nodes.set(f.id, { folder: f, subfolders: [], masters: [] });
  }

  const rootFolders: MasterFolderNode[] = [];
  for (const f of folders) {
    const node = nodes.get(f.id)!;
    const parent =
      f.parentId && folderIds.has(f.parentId) ? nodes.get(f.parentId) : undefined;
    if (parent) parent.subfolders.push(node);
    else rootFolders.push(node);
  }

  const rootMasters: MasterLayout[] = [];
  for (const m of masters) {
    const node =
      m.folderId && folderIds.has(m.folderId) ? nodes.get(m.folderId) : undefined;
    if (node) node.masters.push(m);
    else rootMasters.push(m);
  }

  return { rootMasters, rootFolders };
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
  const tree = buildLayoutTree(folders, layouts);
  const find = (nodes: FolderNode[]): FolderNode | undefined => {
    for (const n of nodes) {
      if (n.folder.id === folderId) return n;
      const deep = find(n.subfolders);
      if (deep) return deep;
    }
    return undefined;
  };
  const node = find(tree.rootFolders);
  if (!node) return [];
  const out: Layout[] = [];
  const walk = (n: FolderNode) => {
    out.push(...n.layouts);
    for (const sub of n.subfolders) walk(sub);
  };
  walk(node);
  return out;
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
  const folders = project.layoutFolders ?? [];
  const layouts = project.layouts ?? [];
  return collectFolderLayouts(folderId, folders, layouts).map((layout) => {
    const master = findMaster(project, layout);
    const { w, h } = effectiveSheetSizeMm(master ?? layout);
    return { layout, widthMm: w, heightMm: h };
  });
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
  const { folders: nextFolders, grandParentId } = foldersAfterDelete(folderId, folders);
  const nextLayouts = layouts.map((l) =>
    l.folderId === folderId
      ? grandParentId
        ? { ...l, folderId: grandParentId }
        : { ...l, folderId: undefined }
      : l,
  );
  return { folders: nextFolders, layouts: nextLayouts };
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
  const { folders: nextFolders, grandParentId } = foldersAfterDelete(folderId, folders);
  const nextMasters = masters.map((m) =>
    m.folderId === folderId
      ? grandParentId
        ? { ...m, folderId: grandParentId }
        : { ...m, folderId: undefined }
      : m,
  );
  return { folders: nextFolders, masters: nextMasters };
}

/**
 * Entfernt einen Ordner aus der flachen Liste und zieht dessen direkte
 * Unterordner auf die Elternebene (`grandParentId`). Das `kind`-Feld bleibt dabei
 * ERHALTEN (Spread statt Neu-Bau), damit ein hochgezogener Master-Ordner nicht
 * versehentlich zum Layout-Ordner wird. Liefert die neue Liste + `grandParentId`
 * (den die Blatt-Reparentierung der Aufrufer nutzt).
 */
function foldersAfterDelete(
  folderId: string,
  folders: LayoutFolder[],
): { folders: LayoutFolder[]; grandParentId?: string } {
  const target = folders.find((f) => f.id === folderId);
  const grandParentId = target?.parentId;
  const nextFolders = folders
    .filter((f) => f.id !== folderId)
    .map((f) =>
      f.parentId === folderId
        ? grandParentId
          ? { ...f, parentId: grandParentId }
          : stripParentId(f)
        : f,
    );
  return { folders: nextFolders, grandParentId };
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
  if (candidateId === rootId) return true;
  const byId = new Map(folders.map((f) => [f.id, f]));
  const seen = new Set<string>();
  let cur = byId.get(candidateId);
  while (cur && cur.parentId && !seen.has(cur.id)) {
    if (cur.parentId === rootId) return true;
    seen.add(cur.id);
    cur = byId.get(cur.parentId);
  }
  return false;
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
  const tb: LayoutTitleBlock = master?.titleBlock ?? {};
  const firstVp = layout.viewports[0];
  const firstSnap = firstVp ? findSnapshot(project, firstVp.snapshotId) : undefined;
  const scaleN = firstVp
    ? resolveViewportScale(firstVp, firstSnap)
    : undefined;
  const nonEmpty = (s: string | undefined): string | undefined =>
    s && s.trim() ? s.trim() : undefined;
  return {
    projectName: nonEmpty(tb.projectName) ?? project.name,
    sheetName: nonEmpty(tb.sheetName) ?? layout.name,
    scale: nonEmpty(tb.scale) ?? (scaleN ? `1:${scaleN}` : "—"),
    date: nonEmpty(tb.date) ?? today,
    author: nonEmpty(tb.author) ?? "",
  };
}

/**
 * Sichtbare Kategorie-Codes eines Ausschnitts als Set (für `generatePlan`). Aus
 * der gespeicherten `layerVisibility`-Map (Code → sichtbar) abgeleitet.
 */
export function visibleCodesFromSnapshot(snap: ViewSnapshot): Set<string> {
  const out = new Set<string>();
  for (const [code, visible] of Object.entries(snap.layerVisibility)) {
    if (visible) out.add(code);
  }
  return out;
}
