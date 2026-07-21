// Kleiner schwebender Editor (dunkel, wie das Kontextmenü) am Anker. Schließt
// über Außenklick / Esc. Rein darstellend: die Felder rufen die übergebenen
// Patch-Handler, die live auf den State wirken (kein Bestätigen nötig).
//
// Extrahiert aus App.tsx. Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import React, { useEffect, useRef, useState } from "react";
import { t } from "../i18n";

export function InlineEditor({
  x,
  y,
  title,
  onClose,
  children,
}: {
  x: number;
  y: number;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // An die Viewport-Ränder klemmen (wie das Kontextmenü).
  const [pos, setPos] = useState({ x, y });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let nx = x;
    let ny = y;
    if (nx + r.width > window.innerWidth - 4) nx = window.innerWidth - r.width - 4;
    if (ny + r.height > window.innerHeight - 4)
      ny = window.innerHeight - r.height - 4;
    setPos({ x: Math.max(4, nx), y: Math.max(4, ny) });
  }, [x, y]);
  // Schließen bei Außenklick / Esc.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="ctx-editor"
      style={{ left: pos.x, top: pos.y }}
      role="dialog"
      aria-label={title}
    >
      <div className="ctx-editor-head">
        <span className="ctx-editor-title">{title}</span>
        <button
          className="ctx-editor-close"
          onClick={onClose}
          aria-label={t("editor.close")}
        >
          ×
        </button>
      </div>
      <div className="ctx-editor-body">{children}</div>
    </div>
  );
}
