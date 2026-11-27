// [333] Blätter-Leiste im Layout (wie die Seitenpalette in InDesign): alle Blätter der Mappe als kleine Vorschau — Papier im
// richtigen Seitenverhältnis, darauf die Rahmen der Ansichten und Tabellen —, Name und Plannummer darunter. Klick öffnet
// das Blatt, Ziehen ordnet um (Zeigerereignisse statt HTML5-Drag&Drop: läuft auch im WKWebView), Rechtsklick/„…“ bietet
// Duplizieren und Löschen (mit Rückfrage). Die Vorschau ist schematisch (keine Plan-Erzeugung je Blatt: bleibt bei 30
// Blättern sofort).

import { useRef, useState } from "react";
import type { Project } from "../model/types";
import { effectiveSheetSizeMm, findMaster } from "../model/layoutModel";
import { t } from "../i18n";
import { ContextMenu } from "./ContextMenu";
import { ConfirmDialog } from "./ConfirmDialog";

const THUMB_W = 96;
/** Ab so vielen Pixeln Bewegung gilt ein Klick als Ziehen. */
const DRAG_THRESHOLD = 5;

interface Props {
  project: Project;
  activeId: string;
  onOpen: (id: string) => void;
  onMove?: (id: string, slot: number) => void;
  onDuplicate?: (id: string) => void;
  onDelete?: (id: string) => void;
}

export function SheetStrip({ project, activeId, onOpen, onMove, onDuplicate, onDelete }: Props) {
  const layouts = project.layouts ?? [];
  const navRef = useRef<HTMLElement>(null);
  const press = useRef<{ id: string; x: number; y: number; dragging: boolean } | null>(null);
  const suppressClick = useRef(false);
  const [drag, setDrag] = useState<{ id: string; slot: number } | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  // Einfüge-Stelle (0…n) aus der Zeigerhöhe: vor dem ersten Blatt, dessen Mitte unter dem Zeiger liegt.
  const slotAt = (clientY: number): number => {
    const items = Array.from(navRef.current?.querySelectorAll<HTMLElement>(".sheet-strip-item") ?? []);
    for (let i = 0; i < items.length; i++) {
      const r = items[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return items.length;
  };
  const canMove = !!onMove && layouts.length > 1;
  const canMenu = !!onDuplicate || !!onDelete;
  const deletingLayout = layouts.find((l) => l.id === deleting);

  return (
    <nav className="sheet-strip" aria-label={t("layouts.strip")} data-sheet-strip ref={navRef}>
      {layouts.map((l, i) => {
        const size = effectiveSheetSizeMm(findMaster(project, l) ?? l);
        const h = (THUMB_W * size.h) / Math.max(size.w, 1);
        const label = l.planNumber || String(i + 1);
        const dropBefore = drag?.slot === i && drag.id !== l.id;
        const dropAfter = drag?.slot === layouts.length && i === layouts.length - 1;
        const open = () => l.id !== activeId && onOpen(l.id);
        return (
          <div
            key={l.id}
            role="button"
            tabIndex={0}
            data-sheet-id={l.id}
            className={`sheet-strip-item${l.id === activeId ? " active" : ""}${drag?.id === l.id ? " dragging" : ""}${dropBefore ? " drop-before" : ""}${dropAfter ? " drop-after" : ""}`}
            title={l.name}
            aria-current={l.id === activeId ? "page" : undefined}
            onClick={() => {
              if (suppressClick.current) {
                suppressClick.current = false;
                return;
              }
              open();
            }}
            onKeyDown={(e) => {
              if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                e.preventDefault();
                open();
              }
            }}
            onContextMenu={(e) => {
              if (!canMenu) return;
              e.preventDefault();
              setMenu({ id: l.id, x: e.clientX, y: e.clientY });
            }}
            onPointerDown={(e) => {
              if (!canMove || e.button !== 0 || (e.target as HTMLElement).closest(".sheet-strip-more")) return;
              press.current = { id: l.id, x: e.clientX, y: e.clientY, dragging: false };
              e.currentTarget.setPointerCapture?.(e.pointerId);
            }}
            onPointerMove={(e) => {
              const pr = press.current;
              if (!pr || pr.id !== l.id) return;
              if (!pr.dragging && Math.hypot(e.clientX - pr.x, e.clientY - pr.y) < DRAG_THRESHOLD) return;
              pr.dragging = true;
              setDrag({ id: l.id, slot: slotAt(e.clientY) });
            }}
            onPointerUp={(e) => {
              const pr = press.current;
              press.current = null;
              e.currentTarget.releasePointerCapture?.(e.pointerId);
              if (!pr || pr.id !== l.id || !pr.dragging) return;
              // Das Click-Ereignis nach dem Loslassen nicht als „Blatt öffnen“ werten.
              suppressClick.current = true;
              setTimeout(() => (suppressClick.current = false), 0);
              const slot = slotAt(e.clientY);
              setDrag(null);
              onMove?.(l.id, slot);
            }}
            onPointerCancel={() => {
              press.current = null;
              setDrag(null);
            }}
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
            {canMenu && (
              <button
                type="button"
                className="sheet-strip-more"
                aria-label={t("layouts.stripMore")}
                title={t("layouts.stripMore")}
                onClick={(e) => {
                  e.stopPropagation();
                  const r = e.currentTarget.getBoundingClientRect();
                  setMenu({ id: l.id, x: r.left, y: r.bottom });
                }}
              >
                …
              </button>
            )}
          </div>
        );
      })}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            ...(onDuplicate ? [{ label: t("layouts.duplicate"), onClick: () => onDuplicate(menu.id) }] : []),
            ...(onDelete ? [{ label: t("layouts.delete"), danger: true, onClick: () => setDeleting(menu.id) }] : []),
          ]}
        />
      )}
      {deletingLayout && onDelete && (
        <ConfirmDialog
          title={t("layouts.delete")}
          message={t("layouts.deleteSheetMessage", { name: deletingLayout.name })}
          confirmLabel={t("layouts.delete")}
          danger
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            setDeleting(null);
            onDelete(deletingLayout.id);
          }}
        />
      )}
    </nav>
  );
}
