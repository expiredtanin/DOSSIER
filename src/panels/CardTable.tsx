// Gemeinsame Tabelle für breite Berichte im Dock (Fenster-/Türliste, Raumbuch …).
//
//  • Breites Dock: normale Tabelle, bei Bedarf waagrecht scrollbar (Umhüllung `.area-scroll`, setzt der Aufrufer).
//  • Schmale Dock-Spalte (Container-Query in styles.css, ≤ 460 px): jede Zeile wird zur Karte — erste Zelle als
//    Titel, die übrigen als Raster „Kopf über Wert“. Der Kopf steht in `data-label` der Zelle; diese Komponente
//    setzt ihn aus der Kopfzeile, damit die Zellen nichts davon wissen müssen. Leere Zellen entfallen in der Karte.
//  • Es ändert sich nur die Darstellung: Zellen, Eingaben, CSV und PDF bleiben dieselben.

import { useLayoutEffect, useRef, type ReactNode } from "react";

export function CardTable({ className = "", children, testId }: { className?: string; children: ReactNode; testId?: string }) {
  const ref = useRef<HTMLTableElement>(null);
  // Nach jedem Rendern: Spaltenköpfe in die Zellen der jeweiligen Spalte kopieren (Zellen mit colSpan überspringen).
  useLayoutEffect(() => {
    const table = ref.current;
    if (!table) return;
    const heads = Array.from(table.tHead?.rows[0]?.cells ?? []).map((th) => th.textContent?.trim() ?? "");
    for (const body of Array.from(table.tBodies)) {
      for (const row of Array.from(body.rows)) {
        Array.from(row.cells).forEach((cell, i) => {
          const label = i > 0 && cell.colSpan === 1 ? heads[i] : "";
          if (label) {
            if (cell.dataset.label !== label) cell.dataset.label = label;
            // Längere Textzellen (Typname, Räume, Oberflächen) belegen in der Karte mehrere Rasterspalten.
            const len = cell.querySelector("input,select,button") ? 0 : (cell.textContent ?? "").length;
            const span = len > 22 ? "3" : len > 9 || cell.querySelector("select") ? "2" : "";
            if (span) cell.dataset.span = span;
            else delete cell.dataset.span;
          } else if (cell.dataset.label !== undefined) delete cell.dataset.label;
        });
      }
    }
  });
  return (
    <table ref={ref} className={`area-table wide ${className}`.trim()} data-testid={testId}>
      {children}
    </table>
  );
}
