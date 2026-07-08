// Inhalts-Panel „Ausschnitte" — benannte, gespeicherte Ansichten (View-Snapshots,
// DOSSIER A2, ROADMAP §2c/§11) als ORDNER-/BAUM-Struktur (spiegelbildlich zum
// Layouts-Panel).
//
// Ein Ausschnitt fängt den kompletten Darstellungszustand ein (Ansichtstyp,
// Kamera-Preset, Massstab, Detailgrad, Ebenen-/Zeichnungssichtbarkeit, aktive
// Overrides, aktives Geschoss) und stellt ihn per Klick wieder her. Das Panel
// zeigt Ordner (auf-/zuklappbar) mit Ausschnitten als Blättern; zwei Header-
// Buttons legen einen Ordner bzw. einen neuen Ausschnitt im AKTIVEN Ordner an
// (Klick auf eine Ordnerzeile = aktiver Ordner; ohne Auswahl = Wurzel). Neue
// Ordner werden sofort inline umbenannt (autofocus/Enter — KEIN window.prompt,
// im Tauri-WKWebView deaktiviert). Ausschnitte/Ordner lassen sich per HTML5-
// Drag&Drop zwischen Ordnern verschieben (Zyklus-Schutz im Host).
//
// Die Footer-Bar (Massstab/Kombis/Overrides/Umbenennen bei angewähltem
// Ausschnitt) und die Anwahl-Persistenz (`selectedViewSnapshotId`) bleiben
// unverändert erhalten — sie hängen unter dem Baum.
//
// Reine Verdrahtung über den Host-Context (usePanelHost); die Erfassungs-/
// Anwendungslogik lebt in App.tsx (Setter/rAF) bzw. state/viewSnapshots.ts, die
// pure Baum-/Ordner-Logik in state/viewSnapshotFolders.ts.
//
// Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md).

import { useMemo, useState } from "react";
import { usePanelHost } from "./host";
import type { ViewSnapshot } from "../model/types";
import {
  buildViewSnapshotTree,
  type ViewSnapshotFolderNode,
} from "../state/viewSnapshotFolders";
import { t } from "../i18n";

// ── Baum-Icons (inline-SVG im Panel-Stil: 14px, stroke currentColor 1.4) ──────

/** Gemeinsame SVG-Hülle der kleinen Baum-Icons. */
function TreeIcon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ flex: "0 0 auto" }}
    >
      {children}
    </svg>
  );
}

/** Ordner-Symbol — geschlossen (Registerlasche) bzw. offen (aufgeklappter Deckel). */
function FolderIcon({ open }: { open: boolean }) {
  return (
    <TreeIcon>
      {open ? (
        <path d="M2 5.5l1-1.5h3.2l1.3 1.5H14v1.5H2.9L1.5 13h11l1.6-5H4" />
      ) : (
        <path d="M2 4.2l1-1.2h3.4l1.3 1.5H14v7.3H2z" />
      )}
    </TreeIcon>
  );
}

/** „Ordner erstellen" — geschlossener Ordner mit kleinem Plus oben rechts. */
function FolderPlusIcon() {
  return (
    <TreeIcon>
      <path d="M2 4.2l1-1.2h3.4l1.3 1.5H14v3" />
      <path d="M2 4.2v9.3h6.5" />
      <line x1="11.5" y1="9" x2="11.5" y2="14" />
      <line x1="9" y1="11.5" x2="14" y2="11.5" />
    </TreeIcon>
  );
}

/** „Erstellen" — reines Plus (neuer Ausschnitt). */
function PlusIcon() {
  return (
    <TreeIcon>
      <line x1="8" y1="3" x2="8" y2="13" />
      <line x1="3" y1="8" x2="13" y2="8" />
    </TreeIcon>
  );
}

/** Ausschnitt-Blatt — Kamera-Sucherrahmen (passt zum Tab-Symbol). */
function SnapshotIcon() {
  return (
    <TreeIcon>
      <rect x="2.5" y="4" width="11" height="8" rx="1" />
      <circle cx="8" cy="8" r="2" />
      <line x1="5" y1="4" x2="5.8" y2="2.8" />
    </TreeIcon>
  );
}

/** Ein Inline-Rename-Input (autoFocus/Enter/Escape/Blur). */
function RenameInput({
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return (
    <input
      className="settings-num-input"
      style={{ flex: 1, minWidth: 0 }}
      type="text"
      autoFocus
      spellCheck={false}
      value={value}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit();
        else if (e.key === "Escape") onCancel();
      }}
      onBlur={onCommit}
    />
  );
}

/** Deep-Equal zweier `Record<string, boolean>`-Maps (gleiche Keys UND Werte). */
function boolMapEqual(
  a: Record<string, boolean>,
  b: Record<string, boolean>,
): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

/**
 * Sucht unter den gespeicherten Kombinationen (`names` + `load`) diejenige,
 * deren Map EXAKT `target` entspricht — liefert den Namen oder `null`. Grundlage
 * der Footer-Anzeige „welche Ebenen-/Zeichnungskombi war aktiv".
 */
function matchingComboName(
  names: string[],
  load: (name: string) => Record<string, boolean> | null,
  target: Record<string, boolean>,
): string | null {
  for (const name of names) {
    const map = load(name);
    if (map && boolMapEqual(map, target)) return name;
  }
  return null;
}

/** Welche Zeilenart gerade inline umbenannt wird (Commit unterscheidet sich). */
type RenameKind = "folder" | "snapshot";
interface Renaming {
  id: string;
  kind: RenameKind;
}

export function ViewSnapshotsPanel() {
  const host = usePanelHost();
  const snaps = host.project.viewSnapshots ?? [];
  const folders = host.project.viewSnapshotFolders ?? [];

  const tree = useMemo(
    () => buildViewSnapshotTree(folders, snaps),
    [folders, snaps],
  );

  // In-App-Eingabe statt window.prompt (im Tauri-WKWebView deaktiviert → gäbe
  // null zurück, nichts würde gespeichert). `naming` = neuer Ausschnitt.
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState("");
  // Inline-Rename einer Baumzeile (Ordner ODER Ausschnitt) + Entwurf.
  const [renaming, setRenaming] = useState<Renaming | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // Inline-Umbenennen DIREKT in der Footer-Bar (eigener Draft, damit Liste und
  // Footer sich nicht ins Gehege kommen). `footerRenaming` = Bearbeitung aktiv.
  const [footerRenaming, setFooterRenaming] = useState(false);
  const [footerDraft, setFooterDraft] = useState("");

  // Aktiver Ordner = Ziel neuer Ausschnitte/Ordner (Klick auf Ordnerzeile). Null = Wurzel.
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  // Auf-/zugeklappte Ordner.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Drag&Drop: gezogenes Element + überfahrenes Drop-Ziel (Ordner-Id oder "root").
  const [dragItem, setDragItem] = useState<{
    kind: "snapshot" | "folder";
    id: string;
  } | null>(null);
  const [dragOverId, setDragOverId] = useState<string | "root" | null>(null);

  // Der aktuell „angewählte" Ausschnitt (bleibt markiert, bis App bei einer
  // Abweichung `selectedViewSnapshotId` auf null setzt). Footer-Bar nur sichtbar,
  // solange dieser existiert.
  const selectedId = host.selectedViewSnapshotId;
  const selectedSnap = useMemo(
    () => (selectedId ? snaps.find((s) => s.id === selectedId) ?? null : null),
    [selectedId, snaps],
  );

  // Footer-Auflösung: Massstab, passende Ebenen-/Zeichnungskombi (Deep-Equal auf
  // die gespeicherte Map) und die Namen der aktiven Override-Regeln.
  const footer = useMemo(() => {
    if (!selectedSnap) return null;
    const layerCombo = matchingComboName(
      host.listLayerCombos(),
      host.loadLayerCombo,
      selectedSnap.layerVisibility,
    );
    const drawingCombo = matchingComboName(
      host.listDrawingCombos(),
      host.loadDrawingCombo,
      selectedSnap.drawingVisibility,
    );
    const ids = new Set(selectedSnap.enabledOverrideRuleIds ?? []);
    const overrideNames = (host.project.overrideRules ?? [])
      .filter((r) => ids.has(r.id))
      .map((r) => r.name);
    return { layerCombo, drawingCombo, overrideNames };
  }, [selectedSnap, host]);

  // ── Auf-/Zuklappen ────────────────────────────────────────────────────────
  const isExpanded = (id: string) => !collapsed.has(id);
  const toggleFolder = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const expandFolder = (id: string) =>
    setCollapsed((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

  // ── Inline-Rename (Baumzeilen) ──────────────────────────────────────────────
  const beginRename = (id: string, kind: RenameKind, currentName: string) => {
    setRenaming({ id, kind });
    setRenameDraft(currentName);
  };
  const commitRename = () => {
    if (!renaming) return;
    const name = renameDraft.trim();
    if (name) {
      if (renaming.kind === "folder")
        host.onRenameViewSnapshotFolder(renaming.id, name);
      else host.onRenameViewSnapshot(renaming.id, name);
    }
    setRenaming(null);
  };
  const cancelRename = () => setRenaming(null);
  const renamingRow = (id: string, kind: RenameKind) =>
    renaming?.id === id && renaming.kind === kind;

  // ── Anlegen (zwei Header-Buttons) ──────────────────────────────────────────
  const addFolder = () => {
    const id = host.onAddViewSnapshotFolder(activeFolderId ?? undefined);
    if (activeFolderId) expandFolder(activeFolderId);
    beginRename(id, "folder", t("viewsnap.folder.defaultName"));
  };
  const commitSave = () => {
    const name = draft.trim();
    if (name) host.onCaptureViewSnapshot(name, activeFolderId ?? undefined);
    if (activeFolderId) expandFolder(activeFolderId);
    setNaming(false);
    setDraft("");
  };

  // ── Drag&Drop ──────────────────────────────────────────────────────────────
  const endDrag = () => {
    setDragItem(null);
    setDragOverId(null);
  };
  const dropOnFolder = (targetFolderId: string) => {
    if (!dragItem) return;
    if (dragItem.kind === "snapshot") {
      host.onMoveViewSnapshotToFolder(dragItem.id, targetFolderId);
    } else if (dragItem.id !== targetFolderId) {
      // Zyklen (Ordner in eigenen Nachfahren) verwirft der Host (No-op).
      host.onMoveViewSnapshotFolder(dragItem.id, targetFolderId);
    }
    expandFolder(targetFolderId);
    endDrag();
  };
  const dropOnRoot = () => {
    if (!dragItem) return;
    if (dragItem.kind === "snapshot")
      host.onMoveViewSnapshotToFolder(dragItem.id, null);
    else host.onMoveViewSnapshotFolder(dragItem.id, null);
    endDrag();
  };

  // ── Footer-Rename ──────────────────────────────────────────────────────────
  const startFooterRename = () => {
    if (!selectedSnap) return;
    setFooterRenaming(true);
    setFooterDraft(selectedSnap.name);
  };
  const commitFooterRename = () => {
    if (!selectedSnap) return;
    const name = footerDraft.trim();
    if (name && name !== selectedSnap.name)
      host.onRenameViewSnapshot(selectedSnap.id, name);
    setFooterRenaming(false);
  };

  // ── Baum-Zeilen ────────────────────────────────────────────────────────────
  const SnapshotRow = (snap: ViewSnapshot, depth: number) => (
    <div
      key={snap.id}
      className={"nav-row" + (snap.id === selectedId ? " active" : "")}
      title={t("viewsnap.applyHint", { name: snap.name })}
      draggable={!renamingRow(snap.id, "snapshot")}
      onDragStart={(e) => {
        e.stopPropagation();
        setDragItem({ kind: "snapshot", id: snap.id });
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragEnd={endDrag}
      onClick={() =>
        renamingRow(snap.id, "snapshot")
          ? undefined
          : host.onApplyViewSnapshot(snap.id)
      }
      style={{ display: "flex", alignItems: "center", gap: 4, paddingLeft: 10 + depth * 14 }}
    >
      {renamingRow(snap.id, "snapshot") ? (
        <RenameInput
          value={renameDraft}
          onChange={setRenameDraft}
          onCommit={commitRename}
          onCancel={cancelRename}
        />
      ) : (
        <span
          className="nav-label"
          style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 5 }}
        >
          <SnapshotIcon />
          {snap.name}
        </span>
      )}
      <button
        className="nav-add"
        style={{ padding: "1px 5px" }}
        title={t("viewsnap.rename")}
        onClick={(e) => {
          e.stopPropagation();
          beginRename(snap.id, "snapshot", snap.name);
        }}
      >
        ✎
      </button>
      <button
        className="nav-add"
        style={{ padding: "1px 5px" }}
        title={t("viewsnap.delete")}
        onClick={(e) => {
          e.stopPropagation();
          host.onDeleteViewSnapshot(snap.id);
        }}
      >
        ✕
      </button>
    </div>
  );

  const FolderRowTree = (
    node: ViewSnapshotFolderNode,
    depth: number,
  ): React.ReactNode => {
    const { folder } = node;
    const expanded = isExpanded(folder.id);
    const active = activeFolderId === folder.id;
    const empty = node.snapshots.length === 0 && node.subfolders.length === 0;
    const isDragged = dragItem?.kind === "folder" && dragItem.id === folder.id;
    const dragOver = dragOverId === folder.id && !isDragged;
    return (
      <div key={folder.id}>
        <div
          className={`nav-row${active ? " active" : ""}${dragOver ? " drag-over" : ""}`}
          title={folder.name}
          draggable={!renamingRow(folder.id, "folder")}
          onDragStart={(e) => {
            e.stopPropagation();
            setDragItem({ kind: "folder", id: folder.id });
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragEnd={endDrag}
          onDragOver={(e) => {
            if (!dragItem) return;
            e.stopPropagation();
            if (isDragged) {
              if (dragOverId !== null) setDragOverId(null);
              return;
            }
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (dragOverId !== folder.id) setDragOverId(folder.id);
          }}
          onDragLeave={() => {
            if (dragOverId === folder.id) setDragOverId(null);
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            dropOnFolder(folder.id);
          }}
          onClick={() => setActiveFolderId(active ? null : folder.id)}
          style={{ display: "flex", alignItems: "center", gap: 4, paddingLeft: 10 + depth * 14 }}
        >
          <button
            className="nav-add"
            style={{ padding: "0 3px", visibility: empty ? "hidden" : "visible" }}
            title={expanded ? "▾" : "▸"}
            onClick={(e) => {
              e.stopPropagation();
              toggleFolder(folder.id);
            }}
          >
            {expanded ? "▾" : "▸"}
          </button>
          {renamingRow(folder.id, "folder") ? (
            <RenameInput
              value={renameDraft}
              onChange={setRenameDraft}
              onCommit={commitRename}
              onCancel={cancelRename}
            />
          ) : (
            <span
              className="nav-label"
              style={{
                flex: 1,
                minWidth: 0,
                fontWeight: 600,
                display: "flex",
                alignItems: "center",
                gap: 5,
              }}
            >
              <FolderIcon open={expanded} />
              {folder.name}
            </span>
          )}
          <button
            className="nav-add"
            style={{ padding: "1px 5px" }}
            title={t("viewsnap.folder.rename")}
            onClick={(e) => {
              e.stopPropagation();
              beginRename(folder.id, "folder", folder.name);
            }}
          >
            ✎
          </button>
          <button
            className="nav-add"
            style={{ padding: "1px 5px" }}
            title={t("viewsnap.folder.delete")}
            onClick={(e) => {
              e.stopPropagation();
              if (activeFolderId === folder.id) setActiveFolderId(null);
              host.onDeleteViewSnapshotFolder(folder.id);
            }}
          >
            ✕
          </button>
        </div>
        {expanded && (
          <>
            {node.subfolders.map((sub) => FolderRowTree(sub, depth + 1))}
            {node.snapshots.map((s) => SnapshotRow(s, depth + 1))}
            {empty && (
              <div
                style={{
                  padding: "2px 10px 4px",
                  paddingLeft: 10 + (depth + 1) * 14,
                  fontSize: 11,
                  color: "var(--muted)",
                }}
              >
                {t("viewsnap.folder.empty")}
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  const treeEmpty =
    tree.rootFolders.length === 0 && tree.rootSnapshots.length === 0;

  return (
    <section className="nav-group">
      <header className="nav-group-head">
        <span className="nav-group-title">{t("viewsnap.title")}</span>
        <span className="nav-group-actions">
          <button
            className="nav-add"
            style={{ display: "inline-flex", padding: "1px 5px" }}
            title={t("viewsnap.add.folder")}
            onClick={addFolder}
          >
            <FolderPlusIcon />
          </button>
          <button
            className="nav-add"
            style={{ display: "inline-flex", padding: "1px 5px" }}
            title={t("viewsnap.add.snapshot")}
            onClick={() => {
              setNaming(true);
              setDraft("");
            }}
          >
            <PlusIcon />
          </button>
        </span>
      </header>

      {naming && (
        <div className="nav-row" style={{ display: "flex", gap: 4, padding: "4px 8px" }}>
          <input
            className="settings-num-input"
            style={{ flex: 1, minWidth: 0 }}
            type="text"
            autoFocus
            spellCheck={false}
            placeholder={t("viewsnap.savePrompt")}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitSave();
              else if (e.key === "Escape") {
                setNaming(false);
                setDraft("");
              }
            }}
          />
          <button className="nav-add" onClick={commitSave} title={t("viewsnap.add.snapshot")}>
            ✓
          </button>
        </div>
      )}

      {treeEmpty ? (
        <div style={{ padding: "10px 10px", fontSize: 12, color: "var(--muted)" }}>
          {t("viewsnap.empty")}
        </div>
      ) : (
        <div
          className={`nav-list${dragOverId === "root" ? " drag-over-root" : ""}`}
          onDragOver={(e) => {
            if (!dragItem) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (dragOverId !== "root") setDragOverId("root");
          }}
          onDragLeave={(e) => {
            // Nur löschen, wenn der Zeiger den Container wirklich verlässt.
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
              if (dragOverId === "root") setDragOverId(null);
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            dropOnRoot();
          }}
        >
          {tree.rootFolders.map((node) => FolderRowTree(node, 0))}
          {tree.rootSnapshots.map((s) => SnapshotRow(s, 0))}
        </div>
      )}

      {/* Footer-Bar: sichtbar, sobald ein Ausschnitt angewählt ist. Zeigt den
          erfassten Massstab, die passende Ebenen-/Zeichnungskombi und die
          aktiven Overrides und erlaubt das Umbenennen direkt hier. */}
      {selectedSnap && footer && (
        <div className="viewsnap-footer">
          <div className="viewsnap-footer-name">
            {footerRenaming ? (
              <input
                className="settings-num-input"
                style={{ flex: 1, minWidth: 0 }}
                type="text"
                autoFocus
                spellCheck={false}
                value={footerDraft}
                onChange={(e) => setFooterDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitFooterRename();
                  else if (e.key === "Escape") setFooterRenaming(false);
                }}
                onBlur={commitFooterRename}
              />
            ) : (
              <>
                <span className="viewsnap-footer-title">{selectedSnap.name}</span>
                <button
                  className="nav-add"
                  style={{ padding: "1px 5px" }}
                  title={t("viewsnap.rename")}
                  onClick={startFooterRename}
                >
                  ✎
                </button>
              </>
            )}
          </div>
          <dl className="viewsnap-footer-grid">
            <dt>{t("viewsnap.footer.scale")}</dt>
            <dd>1:{selectedSnap.scaleDenominator}</dd>
            <dt>{t("viewsnap.footer.layerCombo")}</dt>
            <dd>{footer.layerCombo ?? t("viewsnap.footer.none")}</dd>
            <dt>{t("viewsnap.footer.drawingCombo")}</dt>
            <dd>{footer.drawingCombo ?? t("viewsnap.footer.none")}</dd>
            <dt>{t("viewsnap.footer.overrides")}</dt>
            <dd>
              {footer.overrideNames.length
                ? footer.overrideNames.join(", ")
                : t("viewsnap.footer.none")}
            </dd>
          </dl>
        </div>
      )}
    </section>
  );
}

/** Tab-Symbol „Ausschnitte" — Kamera-Blende / Sucherrahmen. */
export function ViewSnapshotsTabIcon() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="2" y="3.5" width="12" height="9" rx="1.5" />
      <circle cx="8" cy="8" r="2.4" />
      <line x1="4.5" y1="3.5" x2="5.5" y2="2" />
      <line x1="11.5" y1="3.5" x2="10.5" y2="2" />
    </svg>
  );
}
