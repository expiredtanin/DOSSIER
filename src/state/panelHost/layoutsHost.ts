// Panel-Host, Teil Layouts und Plansätze ([121], aus `usePanelHostBase` herausgelöst): Blätter und
// Masterlayouts anlegen, umbenennen, löschen, in Ordner legen, Ordner-PDF, Publikations-Sätze.

import { addItems, fieldOps, patchItem, patchItems, removeItems } from "../../core";
import { t } from "../../i18n";
import { createLayout, createLayoutFolder, createMasterLayout, deleteFolder as deleteLayoutFolder, deleteMasterFolder, moveLayoutToFolder, moveFolderToFolder, createSheetLevel } from "../../model/layoutModel";
import { folderPdfBytes } from "../../export/layoutPdf";
import { addPublishSetOps, deletePublishSetOps, patchPublishSetOps, publishSet } from "../publishActions";
import { openLayoutTab } from "../tabNavigation";
import { saveBinaryFile } from "../../native/saveFile";
import type { FlatHostOpts, HostPart } from "./types";

export function buildLayoutsHost(c: FlatHostOpts) {
  const { applyChange, project, setActiveLayoutId } = c;
  return {
    // ── Layouts / Masterlayouts (DOSSIER A3) ──────────────────────────────
    // Immutable CRUD über pure Helfer (panels/layoutModel.ts); das Blatt öffnet
    // als erstklassige Ansicht IM HAUPT-Viewport (activeLayoutId, Phase 2b).
    // Anlegen öffnet es direkt; Löschen schliesst es, falls es das offene trifft.
    onAddLayout: (name, paper, orientation) => {
      const lay = createLayout(`lay-${Date.now()}`, name, paper, orientation);
      // Jedes Blatt trägt seine Blatt-Ebene (2D-Zeichnung auf dem Blatt, s. layoutModel).
      applyChange([...addItems("layouts", [lay]), ...addItems("drawingLevels", [createSheetLevel(`sheet-${lay.id}`, lay)])]);
      openLayoutTab(lay.id);
      setActiveLayoutId(lay.id);
    },
    onRenameLayout: (id, name) => {
      applyChange((p) => patchItem(p, "layouts", id, { name }));
    },
    onDeleteLayout: (id) => {
      // Mit dem Layout gehen seine Blatt-Ebene und deren Zeichnungen (ein Undo-Schritt).
      applyChange((p) => {
        const levels = p.drawingLevels.filter((l) => l.layoutId === id).map((l) => l.id);
        const drawings = p.drawings2d.filter((d) => levels.includes(d.levelId)).map((d) => d.id);
        return [
          ...removeItems(p, "drawings2d", drawings),
          ...removeItems(p, "drawingLevels", levels),
          ...removeItems(p, "layouts", [id]),
        ];
      });
      setActiveLayoutId((cur) => (cur === id ? null : cur));
    },
    onOpenLayout: (id) => {
      openLayoutTab(id); // [182] Layout in eigenem Reiter
      setActiveLayoutId(id);
    },
    onAddMasterLayout: (name) => {
      const m = createMasterLayout(`mas-${Date.now()}`, name, "a4", "portrait");
      applyChange(addItems("masterLayouts", [m]));
    },
    onRenameMasterLayout: (id, name) => {
      applyChange((p) => patchItem(p, "masterLayouts", id, { name }));
    },
    onDeleteMasterLayout: (id) => {
      // Master löschen UND Bindungen der Layouts lösen (masterId → undefined).
      applyChange((p) => [
        ...removeItems(p, "masterLayouts", [id]),
        ...patchItems(p, "layouts", (l) => l.masterId === id, (l) => ({ ...l, masterId: undefined })),
      ]);
    },
    onPatchMasterLayout: (id, patch) => {
      applyChange((p) => patchItem(p, "masterLayouts", id, patch));
    },

    // ── Layouts-Baum (Ordner) + Erstell-Dialoge (DOSSIER A3) ────────────
    onAddLayoutFolder: (parentId) => {
      const id = `folder-${Date.now()}`;
      const folder = createLayoutFolder(id, t("layouts.folder.defaultName"), parentId);
      applyChange(addItems("layoutFolders", [folder]));
      return id;
    },
    onAddMasterFolder: (parentId) => {
      const id = `mfolder-${Date.now()}`;
      const folder = createLayoutFolder(
        id,
        t("layouts.folder.defaultName"),
        parentId,
        "master",
      );
      applyChange(addItems("layoutFolders", [folder]));
      return id;
    },
    onDeleteMasterFolder: (id) => {
      applyChange((p) => {
        const { folders, masters } = deleteMasterFolder(
          id,
          p.layoutFolders ?? [],
          p.masterLayouts ?? [],
        );
        return [...fieldOps(p, "layoutFolders", folders), ...fieldOps(p, "masterLayouts", masters)];
      });
    },
    onRenameLayoutFolder: (id, name) => {
      applyChange((p) => patchItem(p, "layoutFolders", id, { name }));
    },
    onDeleteLayoutFolder: (id) => {
      applyChange((p) => {
        const { folders, layouts } = deleteLayoutFolder(
          id,
          p.layoutFolders ?? [],
          p.layouts ?? [],
        );
        return [...fieldOps(p, "layoutFolders", folders), ...fieldOps(p, "layouts", layouts)];
      });
    },
    onCreateLayout: (opts) => {
      const id = `lay-${Date.now()}`;
      // Bei gebundenem Master erbt das Blatt dessen Papier/Ausrichtung/Grösse.
      const master = opts.masterId
        ? (project.masterLayouts ?? []).find((m) => m.id === opts.masterId)
        : undefined;
      const paper = master?.paper ?? opts.paper;
      const orientation = master?.orientation ?? opts.orientation;
      const customWidthMm = master ? master.customWidthMm : opts.customWidthMm;
      const customHeightMm = master ? master.customHeightMm : opts.customHeightMm;
      const lay = createLayout(id, t("layouts.defaultName"), paper, orientation);
      const full = {
        ...lay,
        ...(opts.masterId ? { masterId: opts.masterId } : {}),
        ...(opts.folderId ? { folderId: opts.folderId } : {}),
        ...(customWidthMm !== undefined && customHeightMm !== undefined
          ? { customWidthMm, customHeightMm }
          : {}),
      };
      applyChange([...addItems("layouts", [full]), ...addItems("drawingLevels", [createSheetLevel(`sheet-${id}`, full)])]);
      return id;
    },
    onCreateMasterLayout: (opts) => {
      const id = `mas-${Date.now()}`;
      const custom =
        opts.customWidthMm !== undefined && opts.customHeightMm !== undefined
          ? { widthMm: opts.customWidthMm, heightMm: opts.customHeightMm }
          : undefined;
      const m = createMasterLayout(
        id,
        t("layouts.defaultMasterName"),
        opts.paper,
        opts.orientation,
        custom,
      );
      const full = opts.folderId ? { ...m, folderId: opts.folderId } : m;
      applyChange(addItems("masterLayouts", [full]));
      return id;
    },
    onExportFolderPdf: (folderId) => {
      const folder = (project.layoutFolders ?? []).find((f) => f.id === folderId);
      const name = folder?.name?.trim() || "layouts";
      void folderPdfBytes(project, folderId).then((bytes) => {
        if (bytes) return saveBinaryFile(bytes, `${name}.pdf`, "application/pdf");
      });
    },
    onMoveLayoutToFolder: (layoutId, folderId) => {
      applyChange((p) => fieldOps(p, "layouts", moveLayoutToFolder(p.layouts ?? [], layoutId, folderId)));
    },
    onMoveFolderToFolder: (folderId, parentId) => {
      applyChange((p) =>
        fieldOps(p, "layoutFolders", moveFolderToFolder(p.layoutFolders ?? [], folderId, parentId)),
      );
    },
    onAddPublishSet: () => {
      const id = `pubset-${Date.now()}`;
      applyChange((p) => addPublishSetOps(p, id));
      return id;
    },
    onPatchPublishSet: (id, patch) => applyChange((p) => patchPublishSetOps(p, id, patch), `pubset-${id}`),
    onSetProjectNumber: (value) => applyChange((p) => fieldOps(p, "projectNumber", value.trim() ? value : undefined), "projectNumber"),
    onDeletePublishSet: (id) => applyChange((p) => deletePublishSetOps(p, id)),
    onPublishSet: (id) => {
      void publishSet(project, id).then((ops) => {
        if (ops && ops.length > 0) applyChange(ops);
      });
    },
  } satisfies HostPart;
}
