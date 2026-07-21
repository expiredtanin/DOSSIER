// Transienter UI-State der Kontextmenüs/Inline-Editoren — bleibt lokal (kein
// Store-Slice: keine Undo/Redo-Relevanz). Bündelt nur die useState-
// Deklarationen; die Reset-Effekte (Geschoss-/Ansichtswechsel) bleiben in
// App(), da sie zusammen mit globalem Auswahl-State aus dem Store laufen.
//
// Extrahiert aus App.tsx. Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { useState } from "react";
import type { EditorState, MenuState } from "./contextMenu";

export function useContextMenuState() {
  // Eigenschaften-Zwischenablage des Ebenen-Kontextmenüs (Farbe + Linienstärke).
  const [layerClipboard, setLayerClipboard] = useState<{
    color: string;
    lw: number;
  } | null>(null);
  // Offenes Kontextmenü (genau eines) — Quelle bestimmt die Einträge.
  const [menu, setMenu] = useState<MenuState>(null);
  // Offener Inline-Editor (Ebene bzw. Geschoss) — aus einem Menüpunkt geöffnet.
  const [editor, setEditor] = useState<EditorState>(null);
  // Welcher Ebenen-Code aktuell im nativen Ebeneneinstellungs-Fenster offen
  // ist (Tauri) — Pendant zu `editor?.kind === "layer"` im Browser-Fallback.
  const [nativeLayerSettingsCode, setNativeLayerSettingsCode] = useState<string | null>(
    null,
  );
  // Offener Raum-Stempel-Editor (Rich-Text) — per Doppelklick/Button geöffnet.
  const [stampEditorRoomId, setStampEditorRoomId] = useState<string | null>(null);
  // Text-Inhalt-Editor: Id des per Doppelklick bearbeiteten Text-2D-Elements.
  const [editTextId, setEditTextId] = useState<string | null>(null);

  return {
    layerClipboard,
    setLayerClipboard,
    menu,
    setMenu,
    editor,
    setEditor,
    nativeLayerSettingsCode,
    setNativeLayerSettingsCode,
    stampEditorRoomId,
    setStampEditorRoomId,
    editTextId,
    setEditTextId,
  };
}
