// [333] Blätter-Leiste im Layout (wie die Seitenpalette in InDesign): alle Blätter der Mappe als kleine Vorschau — Papier im
// richtigen Seitenverhältnis, darauf die Rahmen der Ansichten und Tabellen —, Name und Plannummer darunter. Klick öffnet
// das Blatt. Die Vorschau ist schematisch (keine Plan-Erzeugung je Blatt: bleibt bei 30 Blättern sofort).

import type { Project } from "../model/types";
import { effectiveSheetSizeMm, findMaster } from "../model/layoutModel";
import { t } from "../i18n";

const THUMB_W = 96;

export function SheetStrip({ project, activeId, onOpen }: { project: Project; activeId: string; onOpen: (id: string) => void }) {
  const layouts = project.layouts ?? [];
  return (
    <nav className="sheet-strip" aria-label={t("layouts.strip")} data-sheet-strip>
      {layouts.map((l, i) => {
        const size = effectiveSheetSizeMm(findMaster(project, l) ?? l);
        const h = (THUMB_W * size.h) / Math.max(size.w, 1);
        const label = l.planNumber || String(i + 1);
        return (
          <button
            key={l.id}
            type="button"
            className={`sheet-strip-item${l.id === activeId ? " active" : ""}`}
            title={l.name}
            aria-current={l.id === activeId ? "page" : undefined}
            onClick={() => l.id !== activeId && onOpen(l.id)}
          >
            <svg width={THUMB_W} height={h} viewBox={`0 0 ${size.w} ${size.h}`} aria-hidden="true">
              <rect x={0} y={0} width={size.w} height={size.h} fill="#ffffff" />
              {l.viewports.map((v) => (
                <rect key={v.id} x={v.xMm} y={v.yMm} width={v.widthMm} height={v.heightMm} className="sheet-strip-vp" />
              ))}
              {(l.tables ?? []).map((tb) => (
                <rect key={tb.id} x={tb.xMm} y={tb.yMm} width={tb.widthMm} height={tb.heightMm ?? 20} className="sheet-strip-tb" />
              ))}
            </svg>
            <span className="sheet-strip-label">
              <span className="sheet-strip-no">{label}</span>
              <span className="sheet-strip-name">{l.name}</span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}
