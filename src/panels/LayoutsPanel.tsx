// Inhalts-Panel „Layouts" — Druck-/Plan-Blätter als ORDNER-/BAUM-Struktur
// (DOSSIER A3, ROADMAP §11). Ordner enthalten Layouts (Verschachtelung möglich);
// Masterlayouts bilden einen eigenen Abschnitt (Vorlagen, kein Ordner-Mitglied).
//
// Ein einziges „＋"-Menü oben legt Ordner/Layout/Masterlayout an; Layout/Master
// öffnen zuvor einen Grössen-Dialog. Neu angelegte Elemente landen im aktiven
// Ordner (Klick auf eine Ordnerzeile) und werden SOFORT inline umbenennbar
// (autofocus, Enter bestätigt — KEIN window.prompt, im Tauri-WKWebView deaktiviert).
// Ein Ordner lässt sich als EIN Mehrseiten-PDF exportieren.
//
// Reine Verdrahtung über den Host-Context (usePanelHost); Mutationslogik in
// App.tsx (setProject), pure CRUD/Baum-Aufbau in panels/layoutModel.ts.
//
// Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md).

import { useState } from "react";
import { usePanelHost } from "./host";
import type {
  Layout,
  LayoutOrientation,
  LayoutPaperFormat,
  MasterLayout,
} from "../model/types";
import {
  buildLayoutTree,
  buildMasterTree,
  PAPER_FORMAT_GROUPS,
  type FolderNode,
  type MasterFolderNode,
} from "../model/layoutModel";
import {
  NewLayoutDialog,
  NewMasterLayoutDialog,
  type LayoutSizeStart,
  type NewLayoutStart,
} from "../ui/LayoutCreateDialogs";
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

/** Layout-Blatt — Papier-Rechteck mit ein paar Inhaltslinien. */
function LayoutSheetIcon() {
  return (
    <TreeIcon>
      <rect x="3.5" y="2" width="9" height="12" rx="1" />
      <line x1="5.5" y1="5" x2="10.5" y2="5" />
      <line x1="5.5" y1="7.5" x2="10.5" y2="7.5" />
      <line x1="5.5" y1="10" x2="8.5" y2="10" />
    </TreeIcon>
  );
}

/** Masterlayout — Papier mit Stern-Akzent (Vorlage), hebt sich vom Blatt ab. */
function MasterSheetIcon() {
  return (
    <TreeIcon>
      <rect x="3" y="2" width="10" height="12" rx="1" />
      <path d="M8 5l0.9 1.9 2 0.2-1.5 1.4 0.5 2L8 9.6 6.1 10.5l0.5-2L5.1 7.1l2-0.2z" />
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

/** „Erstellen" — reines Plus (Layout/Masterlayout). */
function PlusIcon() {
  return (
    <TreeIcon>
      <line x1="8" y1="3" x2="8" y2="13" />
      <line x1="3" y1="8" x2="13" y2="8" />
    </TreeIcon>
  );
}

/** Welche Zeilenart gerade inline umbenannt wird (Commit-Handler unterscheidet sich). */
type RenameKind = "folder" | "layout" | "master";
interface Renaming {
  id: string;
  kind: RenameKind;
}

/** Ein Inline-Rename-Input (Muster wie ViewSnapshotsPanel: autoFocus/Enter/Escape/Blur). */
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

/** Kompakte Paper/Orientation-Auswahl (Master-Editor). Setzt Custom zurück. */
function PaperControls({
  paper,
  orientation,
  onPaper,
  onOrientation,
}: {
  paper: LayoutPaperFormat;
  orientation: LayoutOrientation;
  onPaper: (p: LayoutPaperFormat) => void;
  onOrientation: (o: LayoutOrientation) => void;
}) {
  return (
    <>
      <select
        className="res-select"
        value={paper}
        title={t("layouts.paper")}
        onChange={(e) => onPaper(e.target.value as LayoutPaperFormat)}
      >
        {PAPER_FORMAT_GROUPS.map((g) => (
          <optgroup
            key={g.label}
            label={g.label === "A" ? t("layouts.paperGroup.a") : t("layouts.paperGroup.b")}
          >
            {g.formats.map((f) => (
              <option key={f} value={f}>
                {f.toUpperCase()}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <select
        className="res-select"
        value={orientation}
        title={t("layouts.orientation")}
        onChange={(e) => onOrientation(e.target.value as LayoutOrientation)}
      >
        <option value="portrait">{t("layouts.portrait")}</option>
        <option value="landscape">{t("layouts.landscape")}</option>
      </select>
    </>
  );
}

function MasterRow({
  master,
  depth,
  renaming,
  renameDraft,
  setRenameDraft,
  startRename,
  commitRename,
  cancelRename,
}: {
  master: MasterLayout;
  depth: number;
  renaming: boolean;
  renameDraft: string;
  setRenameDraft: (v: string) => void;
  startRename: (e: React.MouseEvent) => void;
  commitRename: () => void;
  cancelRename: () => void;
}) {
  const host = usePanelHost();
  const [open, setOpen] = useState(false);
  const tb = master.titleBlock;
  const onDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    host.onDeleteMasterLayout(master.id);
  };
  const field = (key: keyof typeof tb, label: string) => (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11,
        color: "var(--muted)",
      }}
    >
      <span style={{ flex: "0 0 82px" }}>{label}</span>
      <input
        type="text"
        className="res-input"
        style={{ flex: 1 }}
        value={tb[key] ?? ""}
        placeholder={t("layouts.tb.autoPlaceholder")}
        onChange={(e) =>
          host.onPatchMasterLayout(master.id, {
            titleBlock: { ...tb, [key]: e.target.value },
          })
        }
      />
    </label>
  );
  return (
    <div>
      <div
        className="nav-row"
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          cursor: "pointer",
          paddingLeft: 10 + depth * 14,
        }}
      >
        {renaming ? (
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
            <span style={{ flex: "0 0 auto" }}>{open ? "▾" : "▸"}</span>
            <MasterSheetIcon />
            {master.name}
          </span>
        )}
        <button
          className="nav-add"
          style={{ padding: "1px 5px" }}
          title={t("layouts.rename")}
          onClick={startRename}
        >
          ✎
        </button>
        <button
          className="nav-add"
          style={{ padding: "1px 5px" }}
          title={t("layouts.delete")}
          onClick={onDelete}
        >
          ✕
        </button>
      </div>
      {open && (
        <div
          style={{ display: "flex", flexDirection: "column", gap: 5, padding: "6px 10px 10px" }}
        >
          <div style={{ display: "flex", gap: 6 }}>
            <PaperControls
              paper={master.paper}
              orientation={master.orientation}
              onPaper={(p) =>
                host.onPatchMasterLayout(master.id, {
                  paper: p,
                  customWidthMm: undefined,
                  customHeightMm: undefined,
                })
              }
              onOrientation={(o) =>
                host.onPatchMasterLayout(master.id, {
                  orientation: o,
                  customWidthMm: undefined,
                  customHeightMm: undefined,
                })
              }
            />
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                fontSize: 11,
                color: "var(--muted)",
              }}
            >
              <input
                type="checkbox"
                checked={master.border ?? true}
                onChange={(e) =>
                  host.onPatchMasterLayout(master.id, { border: e.target.checked })
                }
              />
              {t("layouts.border")}
            </label>
          </div>
          {field("projectName", t("layouts.tb.projectName"))}
          {field("sheetName", t("layouts.tb.sheetName"))}
          {field("scale", t("layouts.tb.scale"))}
          {field("date", t("layouts.tb.date"))}
          {field("author", t("layouts.tb.author"))}
        </div>
      )}
    </div>
  );
}

export function LayoutsPanel() {
  const host = usePanelHost();
  const layouts = host.project.layouts ?? [];
  const masters = host.project.masterLayouts ?? [];
  const folders = host.project.layoutFolders ?? [];
  // Getrennte Bäume je `kind` — Layout- und Master-Ordner werden NIE vermischt.
  const layoutFolders = folders.filter((f) => f.kind !== "master");
  const masterFolders = folders.filter((f) => f.kind === "master");
  const tree = buildLayoutTree(layoutFolders, layouts);
  const masterTree = buildMasterTree(masterFolders, masters);

  // Aktiver Ordner = Ziel neuer Elemente (Klick auf eine Ordnerzeile). Null = Wurzel.
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  // Aktiver Master-Ordner (eigener Zustand — Ziel neuer Master/Master-Ordner).
  const [activeMasterFolderId, setActiveMasterFolderId] = useState<string | null>(null);
  // Auf-/zugeklappte Ordner.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Inline-Rename (welche Zeile + Entwurf).
  const [renaming, setRenaming] = useState<Renaming | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // Offener Erstell-Dialog.
  const [dialog, setDialog] = useState<null | "layout" | "master">(null);
  // Drag&Drop: gezogenes Element + gerade überfahrenes Drop-Ziel (Ordner-Id
  // oder "root" für die Wurzel-Ablagefläche).
  const [dragItem, setDragItem] = useState<{
    kind: "layout" | "folder";
    id: string;
  } | null>(null);
  const [dragOverId, setDragOverId] = useState<string | "root" | null>(null);

  const endDrag = () => {
    setDragItem(null);
    setDragOverId(null);
  };
  const dropOnFolder = (targetFolderId: string) => {
    if (!dragItem) return;
    if (dragItem.kind === "layout") {
      host.onMoveLayoutToFolder(dragItem.id, targetFolderId);
    } else if (dragItem.id !== targetFolderId) {
      // Zyklen (Ordner in eigenen Nachfahren) verwirft der Host (No-op).
      host.onMoveFolderToFolder(dragItem.id, targetFolderId);
    }
    expandFolder(targetFolderId);
    endDrag();
  };
  const dropOnRoot = () => {
    if (!dragItem) return;
    if (dragItem.kind === "layout") host.onMoveLayoutToFolder(dragItem.id, null);
    else host.onMoveFolderToFolder(dragItem.id, null);
    endDrag();
  };

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

  const beginRename = (id: string, kind: RenameKind, currentName: string) => {
    setRenaming({ id, kind });
    setRenameDraft(currentName);
  };
  const commitRename = () => {
    if (!renaming) return;
    const name = renameDraft.trim();
    if (name) {
      if (renaming.kind === "folder") host.onRenameLayoutFolder(renaming.id, name);
      else if (renaming.kind === "layout") host.onRenameLayout(renaming.id, name);
      else host.onRenameMasterLayout(renaming.id, name);
    }
    setRenaming(null);
  };
  const cancelRename = () => setRenaming(null);
  const renamingRow = (id: string, kind: RenameKind) =>
    renaming?.id === id && renaming.kind === kind;

  // ── Anlegen (zwei getrennte Buttons je Abschnitt) ─────────────────────────
  const addFolder = () => {
    const id = host.onAddLayoutFolder(activeFolderId ?? undefined);
    if (activeFolderId) expandFolder(activeFolderId);
    beginRename(id, "folder", t("layouts.folder.defaultName"));
  };
  const addMasterFolder = () => {
    const id = host.onAddMasterFolder(activeMasterFolderId ?? undefined);
    if (activeMasterFolderId) expandFolder(activeMasterFolderId);
    beginRename(id, "folder", t("layouts.folder.defaultName"));
  };
  const createLayoutFromDialog = (start: NewLayoutStart) => {
    const id = host.onCreateLayout({
      folderId: activeFolderId ?? undefined,
      masterId: start.masterId,
      paper: start.paper,
      orientation: start.orientation,
      customWidthMm: start.customWidthMm,
      customHeightMm: start.customHeightMm,
    });
    if (activeFolderId) expandFolder(activeFolderId);
    setDialog(null);
    beginRename(id, "layout", t("layouts.defaultName"));
  };
  const createMasterFromDialog = (start: LayoutSizeStart) => {
    const id = host.onCreateMasterLayout({
      folderId: activeMasterFolderId ?? undefined,
      paper: start.paper,
      orientation: start.orientation,
      customWidthMm: start.customWidthMm,
      customHeightMm: start.customHeightMm,
    });
    if (activeMasterFolderId) expandFolder(activeMasterFolderId);
    setDialog(null);
    beginRename(id, "master", t("layouts.defaultMasterName"));
  };

  // ── Baum-Zeilen ─────────────────────────────────────────────────────────
  const LayoutRow = (layout: Layout, depth: number) => (
    <div
      key={layout.id}
      className="nav-row"
      title={t("layouts.openHint", { name: layout.name })}
      draggable={!renamingRow(layout.id, "layout")}
      onDragStart={(e) => {
        e.stopPropagation();
        setDragItem({ kind: "layout", id: layout.id });
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragEnd={endDrag}
      onClick={() =>
        renamingRow(layout.id, "layout") ? undefined : host.onOpenLayout(layout.id)
      }
      onDoubleClick={() => host.onOpenLayout(layout.id)}
      style={{ display: "flex", alignItems: "center", gap: 4, paddingLeft: 10 + depth * 14 }}
    >
      {renamingRow(layout.id, "layout") ? (
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
          <LayoutSheetIcon />
          {layout.name}
        </span>
      )}
      <span style={{ fontSize: 9, color: "var(--muted)" }}>
        {(layout.customWidthMm && layout.customHeightMm
          ? `${Math.round(layout.customWidthMm)}×${Math.round(layout.customHeightMm)}`
          : layout.paper.toUpperCase())}{" "}
        · {layout.viewports.length}
      </span>
      <button
        className="nav-add"
        style={{ padding: "1px 5px" }}
        title={t("layouts.rename")}
        onClick={(e) => {
          e.stopPropagation();
          beginRename(layout.id, "layout", layout.name);
        }}
      >
        ✎
      </button>
      <button
        className="nav-add"
        style={{ padding: "1px 5px" }}
        title={t("layouts.delete")}
        onClick={(e) => {
          e.stopPropagation();
          host.onDeleteLayout(layout.id);
        }}
      >
        ✕
      </button>
    </div>
  );

  const FolderRowTree = (node: FolderNode, depth: number): React.ReactNode => {
    const { folder } = node;
    const expanded = isExpanded(folder.id);
    const active = activeFolderId === folder.id;
    const empty = node.layouts.length === 0 && node.subfolders.length === 0;
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
            title={t("layouts.folder.export")}
            onClick={(e) => {
              e.stopPropagation();
              host.onExportFolderPdf(folder.id);
            }}
          >
            ⭳
          </button>
          <button
            className="nav-add"
            style={{ padding: "1px 5px" }}
            title={t("layouts.folder.rename")}
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
            title={t("layouts.folder.delete")}
            onClick={(e) => {
              e.stopPropagation();
              if (activeFolderId === folder.id) setActiveFolderId(null);
              host.onDeleteLayoutFolder(folder.id);
            }}
          >
            ✕
          </button>
        </div>
        {expanded && (
          <>
            {node.subfolders.map((sub) => FolderRowTree(sub, depth + 1))}
            {node.layouts.map((l) => LayoutRow(l, depth + 1))}
            {empty && (
              <div
                style={{
                  padding: "2px 10px 4px",
                  paddingLeft: 10 + (depth + 1) * 14,
                  fontSize: 11,
                  color: "var(--muted)",
                }}
              >
                {t("layouts.folder.empty")}
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  // ── Master-Baum-Zeilen (eigener Baum; kein Drag&Drop, kein PDF-Export) ─────
  const renderMasterRow = (m: MasterLayout, depth: number) => (
    <MasterRow
      key={m.id}
      master={m}
      depth={depth}
      renaming={renamingRow(m.id, "master")}
      renameDraft={renameDraft}
      setRenameDraft={setRenameDraft}
      startRename={(e) => {
        e.stopPropagation();
        beginRename(m.id, "master", m.name);
      }}
      commitRename={commitRename}
      cancelRename={cancelRename}
    />
  );

  const MasterFolderRowTree = (node: MasterFolderNode, depth: number): React.ReactNode => {
    const { folder } = node;
    const expanded = isExpanded(folder.id);
    const active = activeMasterFolderId === folder.id;
    const empty = node.masters.length === 0 && node.subfolders.length === 0;
    return (
      <div key={folder.id}>
        <div
          className={`nav-row${active ? " active" : ""}`}
          title={folder.name}
          onClick={() => setActiveMasterFolderId(active ? null : folder.id)}
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
            title={t("layouts.folder.rename")}
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
            title={t("layouts.folder.delete")}
            onClick={(e) => {
              e.stopPropagation();
              if (activeMasterFolderId === folder.id) setActiveMasterFolderId(null);
              host.onDeleteMasterFolder(folder.id);
            }}
          >
            ✕
          </button>
        </div>
        {expanded && (
          <>
            {node.subfolders.map((sub) => MasterFolderRowTree(sub, depth + 1))}
            {node.masters.map((m) => renderMasterRow(m, depth + 1))}
            {empty && (
              <div
                style={{
                  padding: "2px 10px 4px",
                  paddingLeft: 10 + (depth + 1) * 14,
                  fontSize: 11,
                  color: "var(--muted)",
                }}
              >
                {t("layouts.folder.empty")}
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  const treeEmpty = tree.rootFolders.length === 0 && tree.rootLayouts.length === 0;
  const masterTreeEmpty =
    masterTree.rootFolders.length === 0 && masterTree.rootMasters.length === 0;

  return (
    <section className="nav-group">
      <header className="nav-group-head">
        <span className="nav-group-title">{t("layouts.title")}</span>
        <span className="nav-group-actions">
          <button
            className="nav-add"
            style={{ display: "inline-flex", padding: "1px 5px" }}
            title={t("layouts.add.folder")}
            onClick={addFolder}
          >
            <FolderPlusIcon />
          </button>
          <button
            className="nav-add"
            style={{ display: "inline-flex", padding: "1px 5px" }}
            title={t("layouts.add.layout")}
            onClick={() => setDialog("layout")}
          >
            <PlusIcon />
          </button>
        </span>
      </header>

      {treeEmpty ? (
        <div style={{ padding: "8px 10px", fontSize: 12, color: "var(--muted)" }}>
          {t("layouts.tree.empty")}
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
          {tree.rootLayouts.map((l) => LayoutRow(l, 0))}
        </div>
      )}

      {/* Master-Sektion — eigener Ordner-Baum (Master-Ordner, kind:"master"). */}
      <header className="nav-group-head" style={{ marginTop: 6 }}>
        <span className="nav-group-title">{t("layouts.masters")}</span>
        <span className="nav-group-actions">
          <button
            className="nav-add"
            style={{ display: "inline-flex", padding: "1px 5px" }}
            title={t("layouts.add.folder")}
            onClick={addMasterFolder}
          >
            <FolderPlusIcon />
          </button>
          <button
            className="nav-add"
            style={{ display: "inline-flex", padding: "1px 5px" }}
            title={t("layouts.add.master")}
            onClick={() => setDialog("master")}
          >
            <PlusIcon />
          </button>
        </span>
      </header>
      {masterTreeEmpty ? (
        <div style={{ padding: "4px 10px 8px", fontSize: 12, color: "var(--muted)" }}>
          {t("layouts.noMasters")}
        </div>
      ) : (
        <div className="nav-list">
          {masterTree.rootFolders.map((node) => MasterFolderRowTree(node, 0))}
          {masterTree.rootMasters.map((m) => renderMasterRow(m, 0))}
        </div>
      )}

      {dialog === "layout" && (
        <NewLayoutDialog
          masters={masters}
          onCreate={createLayoutFromDialog}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "master" && (
        <NewMasterLayoutDialog
          onCreate={createMasterFromDialog}
          onClose={() => setDialog(null)}
        />
      )}
    </section>
  );
}

/** Tab-Symbol „Layouts" — gestapelte Blätter. */
export function LayoutsTabIcon() {
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
      <rect x="4.5" y="2.5" width="9" height="11" rx="1" />
      <path d="M2.5 4.5v9h8" />
    </svg>
  );
}
