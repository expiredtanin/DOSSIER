// Dock-Panel „Objekte" ([253]) — Palette der Standard-Objektbibliothek 2D: Gruppen (Sanitär, Küche, Tische, …)
// mit Vorschau-Symbol je Objekt. Klick wählt das Objekt und startet den Befehl `libobj` (Einfügepunkt klicken,
// R = drehen, M = spiegeln). Der Katalog kommt aus dem Rust-Kern; die Vorschau zeichnet der Kern (grob).

import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import type { TranslationKey } from "../i18n";
import { usePanelHostAction } from "./host";
import { setActiveLibObject } from "../commands/cmds/libobj";
import { createPaletteDrag, currentPlanDropTarget } from "../state/planDropTarget";
import {
  libCatalog,
  libDefaultParams,
  libGeometry,
  libGeometryToPolys,
  libGroups,
  polysBounds,
  type LibObjectDef,
} from "../model/furnitureLib";

const SIZE = 44;

/** Vorschau: Linien des Objekts (grob) als kleines SVG, Plan-y nach oben. */
function Preview({ def }: { def: LibObjectDef }) {
  const polys = useMemo(
    () => libGeometryToPolys(libGeometry(def.id, libDefaultParams(def), "grob", 1), (p) => ({ x: p.x, y: -p.y })),
    [def],
  );
  const b = polysBounds(polys);
  if (!b) return <svg width={SIZE} height={SIZE} aria-hidden="true" />;
  const w = Math.max(b.maxX - b.minX, 1e-3);
  const h = Math.max(b.maxY - b.minY, 1e-3);
  const pad = 3;
  const k = (SIZE - 2 * pad) / Math.max(w, h);
  const tx = (x: number) => pad + (x - b.minX) * k + ((SIZE - 2 * pad) - w * k) / 2;
  const ty = (y: number) => pad + (y - b.minY) * k + ((SIZE - 2 * pad) - h * k) / 2;
  return (
    <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} fill="none" stroke="currentColor" strokeWidth={1} strokeLinejoin="round" aria-hidden="true" focusable="false">
      {polys.map((pl, i) => {
        const d = pl.pts.map((p, j) => `${j ? "L" : "M"}${tx(p.x).toFixed(2)} ${ty(p.y).toFixed(2)}`).join(" ") + (pl.closed ? "Z" : "");
        return <path key={i} d={d} />;
      })}
    </svg>
  );
}

const OPEN_KEY = "cad.objlib.open";

/** Gemerkter Zustand der Gruppen (offen/zu) je Gruppen-Schlüssel; leer, wenn nichts gespeichert ist. */
function loadOpen(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(OPEN_KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    return v && typeof v === "object" ? (v as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

export function ObjectLibraryPanel() {
  const [open, setOpen] = useState<Record<string, boolean>>(loadOpen);
  const setGroupOpen = (g: string, v: boolean) =>
    setOpen((o) => {
      const next = { ...o, [g]: v };
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify(next));
      } catch {
        /* Speicher gesperrt: der Zustand gilt nur für diese Sitzung */
      }
      return next;
    });
  const onRunCommand = usePanelHostAction("onRunCommand");
  const catalog = useMemo(() => libCatalog(), []);
  const groups = useMemo(() => libGroups(), []);

  const place = (def: LibObjectDef) => {
    setActiveLibObject(def.id, libDefaultParams(def));
    onRunCommand("libobj");
  };

  // Ziehen in den Plan: Zeigerdruck startet den Befehl wie ein Klick; Bewegen über der Zeichenfläche führt die
  // Vorschau nach, Loslassen dort setzt den Punkt, Loslassen daneben oder Esc bricht ab. Ohne Ziehen bleibt es ein Klick.
  const drag = useRef(createPaletteDrag(currentPlanDropTarget)).current;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") drag.abort();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drag]);
  const mods = (e: React.PointerEvent) => ({ shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey });

  if (catalog.objects.length === 0) {
    return <div style={{ padding: 10, fontSize: 12, color: "var(--muted)" }}>{t("lib.empty")}</div>;
  }
  return (
    <div className="objlib-panel" style={{ overflowY: "auto", padding: "6px 8px" }}>
      <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>{t("lib.hint")}</div>
      {groups.map((g) => (
        <details key={g} open={open[g] ?? g === groups[0]} onToggle={(e) => { const v = e.currentTarget.open; if (v !== (open[g] ?? g === groups[0])) setGroupOpen(g, v); }} style={{ marginBottom: 4 }}>
          <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 600, padding: "3px 0" }}>{t(`lib.g.${g}` as TranslationKey)}</summary>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))", gap: 4, padding: "4px 0" }}>
            {catalog.objects
              .filter((o) => o.group === g)
              .map((o) => {
                const name = t(`lib.o.${o.id.replace(/^lib:/, "")}` as TranslationKey);
                return (
                  <button
                    key={o.id}
                    type="button"
                    title={name.replace(/\u00AD/g, "")}
                    aria-label={name.replace(/\u00AD/g, "")}
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      place(o);
                      if (e.pointerType === "touch") return; // Touch scrollt das Panel: nur Klick
                      try {
                        e.currentTarget.setPointerCapture(e.pointerId);
                      } catch {
                        /* ohne Capture: Ziehen entfällt, der Klick-Weg bleibt */
                      }
                      drag.down(e.clientX, e.clientY);
                    }}
                    onPointerMove={(e) => drag.move(e.clientX, e.clientY, mods(e))}
                    onPointerUp={(e) => {
                      drag.up(e.clientX, e.clientY, mods(e));
                      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
                    }}
                    onPointerCancel={() => drag.abort()}
                    // Tastatur (Enter/Leertaste, detail 0): Zeigerdruck hat den Befehl schon gestartet.
                    onClick={(e) => { if (e.detail === 0) place(o); }}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 2,
                      padding: "4px 2px",
                      border: "1px solid var(--border)",
                      borderRadius: 4,
                      background: "var(--field-bg)",
                      color: "var(--ink)",
                      cursor: "pointer",
                      font: "inherit",
                    }}
                  >
                    <Preview def={o} />
                    <span style={{ fontSize: 10, lineHeight: 1.15, textAlign: "center", overflowWrap: "break-word", hyphens: "manual" }}>{name}</span>
                  </button>
                );
              })}
          </div>
        </details>
      ))}
    </div>
  );
}

/** Tab-Symbol: Stuhl in der Draufsicht. */
export function ObjectLibraryTabIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <rect x="3" y="3" width="10" height="10" rx="1" />
      <path d="M3 6h10" />
    </svg>
  );
}
