// Ansichtsschraffur am Element ([94]): Drehung und Versatz des Oberflächenmusters je Wand bzw. Dach
// (das Muster selbst gehört zum Bauteil der sichtbaren Schicht). Nur sichtbar, wenn ein Bauteil des
// Elements ein Muster trägt.

import { t } from "../i18n";
import type { usePanelHost } from "./host";

export function SurfacePatternPlacement({
  kind,
  id,
  host,
}: {
  kind: "wall" | "roof";
  id: string;
  host: ReturnType<typeof usePanelHost>;
}) {
  const p = host.project;
  const el = kind === "wall" ? p.walls.find((w) => w.id === id) : p.roofs?.find((r) => r.id === id);
  if (!el || !host.onSetSurfacePatternPlacement) return null;
  const typeId = kind === "wall" ? (el as { wallTypeId?: string }).wallTypeId : (el as { roofTypeId?: string }).roofTypeId;
  const types = kind === "wall" ? p.wallTypes : p.roofTypes ?? [];
  const layers = types.find((tp) => tp.id === typeId)?.layers ?? [];
  const hasPattern = layers.some((l) => p.components.find((c) => c.id === l.componentId)?.surfacePattern);
  if (!hasPattern) return null;
  const angle = el.surfacePatternAngle ?? 0;
  const off = el.surfacePatternOffset ?? { x: 0, y: 0 };
  const set = host.onSetSurfacePatternPlacement;
  const field = (key: Parameters<typeof t>[0], value: number, step: number, apply: (v: number) => void) => (
    <div className="objinfo-field">
      <span className="objinfo-flabel">{t(key)}</span>
      <input
        type="number"
        className="objinfo-text"
        step={step}
        value={Number(value.toFixed(3))}
        title={t(key)}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) apply(v);
        }}
      />
    </div>
  );
  return (
    <>
      <div className="objinfo-sep" />
      <div className="objinfo-section-label">{t("objinfo.surfacePattern")}</div>
      {field("objinfo.surfacePattern.angle", angle, 1, (v) => set({ surfacePatternAngle: v || undefined }))}
      {field("objinfo.surfacePattern.offsetX", off.x, 0.01, (x) => set({ surfacePatternOffset: { x, y: off.y } }))}
      {field("objinfo.surfacePattern.offsetY", off.y, 0.01, (y) => set({ surfacePatternOffset: { x: off.x, y } }))}
    </>
  );
}
