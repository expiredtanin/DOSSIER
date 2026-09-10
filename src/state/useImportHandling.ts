// Bündelt die Import-Handler, die NICHT schon in useProjectFileActions()
// stecken (Projektdatei-Öffnen + DXF/DWG-Ausführung liegen dort): Bild/PDF
// einfügen (Werkzeug „image") und die App-weite Drag&Drop-Verdrahtung für
// DXF/DWG-Dateien (ruft `openImportForFile` aus useProjectFileActions auf).
// Nur aus App.tsx herausgezogen, um die Funktion zu entlasten — reine
// Verlagerung, keine Verhaltensänderung.
//
// Extrahiert aus App.tsx. Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { DragEvent } from "react";
import { useRef } from "react";
import { addImageDrawing2d } from "./projectSlice";
import type { NotifyKind } from "./notifySlice";
import { defaultImageSizeM, readImageFile } from "../io/imageAsset";
import { rasterizePdfPages } from "../io/pdfImport";
import { t } from "../i18n";
import type { Project, Vec2 } from "../model/types";

/**
 * „Bild einfügen" (Werkzeug „image"): kein Klick-Platzieren (Datei-Auswahl ist
 * async) — jedes gewählte Bild (oder jede gerasterte PDF-Seite) landet mittig
 * am Modell-Nullpunkt, leicht kaskadiert bei mehreren, sofort selektiert
 * (Griffe/Objekt-Info stehen direkt zum Verschieben/Skalieren bereit).
 */
export function useImageImportHandling(opts: {
  project: Project;
  activeLevelId: string;
  activeCategoryCode: string;
  setProject: (next: Project | ((p: Project) => Project)) => void;
  notify: (message: string, kind?: NotifyKind) => void;
  setSelectedDrawingId: (id: string | null) => void;
  setSelectedWallIds: (ids: string[]) => void;
  setSelectedCeilingIds: (ids: string[]) => void;
  setSelectedOpeningIds: (ids: string[]) => void;
  setSelectedStairIds: (ids: string[]) => void;
  setSelectedRoomIds: (ids: string[]) => void;
  setSelectedExtrudedSolidIds: (ids: string[]) => void;
  setSelectedColumnIds: (ids: string[]) => void;
  setSelectedRoofIds: (ids: string[]) => void;
  setSelectedContextObjectIds: (ids: string[]) => void;
  setSelectedSectionLineIds: (ids: string[]) => void;
}): {
  insertImageDrawings: (assets: { src: string; naturalWidth: number; naturalHeight: number }[]) => void;
  onImageOrPdfFileChosen: (file: File) => void;
} {
  const {
    project,
    activeLevelId,
    activeCategoryCode,
    setProject,
    notify,
    setSelectedDrawingId,
    setSelectedWallIds,
    setSelectedCeilingIds,
    setSelectedOpeningIds,
    setSelectedStairIds,
    setSelectedRoomIds,
    setSelectedExtrudedSolidIds,
    setSelectedColumnIds,
    setSelectedRoofIds,
    setSelectedContextObjectIds,
    setSelectedSectionLineIds,
  } = opts;

  const insertImageDrawings = (
    assets: { src: string; naturalWidth: number; naturalHeight: number }[],
  ) => {
    let cur = project;
    let lastId: string | null = null;
    assets.forEach((a, i) => {
      const { widthM, heightM } = defaultImageSizeM(a.naturalWidth, a.naturalHeight);
      const cascade = i * 0.3;
      const at: Vec2 = { x: -widthM / 2 + cascade, y: -heightM / 2 - cascade };
      const r = addImageDrawing2d(cur, activeLevelId, activeCategoryCode, a.src, at, widthM, heightM);
      cur = r.project;
      lastId = r.id;
    });
    setProject(cur);
    if (lastId) {
      setSelectedDrawingId(lastId);
      setSelectedWallIds([]);
      setSelectedCeilingIds([]);
      setSelectedOpeningIds([]);
      setSelectedStairIds([]);
      setSelectedRoomIds([]);
      setSelectedExtrudedSolidIds([]);
      setSelectedColumnIds([]);
      setSelectedRoofIds([]);
      setSelectedContextObjectIds([]);
      setSelectedSectionLineIds([]);
    }
  };

  const onImageOrPdfFileChosen = (file: File) => {
    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    if (isPdf) {
      void rasterizePdfPages(file)
        .then((pages) => {
          if (pages.length === 0) {
            notify(t("image.pdfEmpty"), "error");
            return;
          }
          insertImageDrawings(pages);
        })
        .catch(() => notify(t("image.pdfError"), "error"));
    } else {
      void readImageFile(file)
        .then((a) => insertImageDrawings([a]))
        .catch(() => notify(t("image.readError"), "error"));
    }
  };

  return { insertImageDrawings, onImageOrPdfFileChosen };
}

/**
 * App-weites Drag & Drop einer DXF/DWG-Datei: dragover muss preventDefault
 * rufen, sonst lässt der Browser nicht fallen. dragenter/leave wird ausgezählt
 * (Kind-Elemente lösen sonst Flackern aus). Ruft `openImportForFile` aus
 * useProjectFileActions auf (dieselbe Logik wie der Datei-Dialog).
 */
export function useFileDropImport(
  setDropActive: (active: boolean) => void,
  openImportForFile: (file: File) => void,
): {
  onAppDragEnter: (e: DragEvent) => void;
  onAppDragOver: (e: DragEvent) => void;
  onAppDragLeave: (e: DragEvent) => void;
  onAppDrop: (e: DragEvent) => void;
} {
  const dragDepthRef = useRef(0);
  const hasFiles = (e: DragEvent) =>
    Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const onAppDragEnter = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setDropActive(true);
  };
  const onAppDragOver = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onAppDragLeave = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDropActive(false);
  };
  const onAppDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepthRef.current = 0;
    setDropActive(false);
    const f = e.dataTransfer.files?.[0];
    if (f) openImportForFile(f);
  };
  return { onAppDragEnter, onAppDragOver, onAppDragLeave, onAppDrop };
}
