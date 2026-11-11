// Abschnitt „Achsraster" der Objekt-Info ([189], früher im Attribute-Panel): Blasen, Verlängerung, Achsnamen,
// 3D-Anzeige und Geschoss-Gültigkeit eines gewählten Rasters.

import { Fragment, type ReactNode } from "react";
import { t } from "../../i18n";
import type { Drawing2D } from "../../model/types";
import type { usePanelHost } from "../host";

type GridGeom = Extract<Drawing2D["geom"], { shape: "grid" }>;
type Bubble = "start" | "end" | "both";

const numProps = { className: "objinfo-text", style: { width: 72 }, type: "number" } as const;

export function GridSection({ drawing, host }: { drawing: Drawing2D; host: ReturnType<typeof usePanelHost> }) {
  if (drawing.geom.shape !== "grid") return null;
  const geom: GridGeom = drawing.geom;
  const fmtAxis = (v: number) => (Math.round(v * 100) / 100).toString();
  const here = geom.levels?.includes(drawing.levelId) && geom.levels.length === 1;
  const set = (patch: Parameters<typeof host.onSetGridProps>[1]) => host.onSetGridProps(drawing.id, patch);
  const row = (label: string, control: ReactNode, testId?: string) => (
    <div className="objinfo-field" data-testid={testId}>
      <span className="objinfo-flabel">{label}</span>
      {control}
    </div>
  );
  return (
    <>
      <div className="objinfo-sep" />
      <div className="objinfo-section-label">{t("attr.grid.section")}</div>
      {row(
        t("attr.grid.bubbles"),
        <select value={geom.bubbles ?? "both"} onChange={(e) => set({ bubbles: e.target.value as Bubble })}>
          <option value="both">{t("attr.grid.bubbles.both")}</option>
          <option value="start">{t("attr.grid.bubbles.start")}</option>
          <option value="end">{t("attr.grid.bubbles.end")}</option>
        </select>,
      )}
      {row(
        t("attr.grid.extend"),
        <input
          {...numProps}
          step={0.1}
          min={0}
          value={geom.extend ?? 1.5}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v >= 0) set({ extend: v });
          }}
        />,
      )}
      {row(
        t("attr.grid.bubbleMm"),
        <input
          {...numProps}
          step={0.5}
          min={2}
          value={geom.bubbleMm ?? 5}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v >= 2) set({ bubbleMm: v });
          }}
        />,
      )}
      {row(
        t("attr.grid.show3d"),
        <input type="checkbox" checked={geom.show3d === true} onChange={(e) => set({ show3d: e.target.checked })} />,
      )}
      {(["a", "b"] as const).map((list) =>
        geom[list].map((ax, i) => (
          <Fragment key={`${list}${i}`}>
            {row(
              t(geom.radial ? (list === "a" ? "attr.grid.ray" : "attr.grid.ring") : "attr.grid.axis", { pos: fmtAxis(ax.pos) }),
              <span style={{ display: "flex", gap: 4 }}>
                <input
                  className="objinfo-text"
                  style={{ width: 56 }}
                  type="text"
                  aria-label={t("attr.grid.axisLabel")}
                  value={ax.label}
                  onChange={(e) => set({ [list]: geom[list].map((x, k) => (k === i ? { ...x, label: e.target.value } : x)) })}
                />
                <select
                  aria-label={t("attr.grid.axisBubble")}
                  value={ax.bubble ?? ""}
                  onChange={(e) => {
                    const v = e.target.value as "" | Bubble;
                    set({
                      [list]: geom[list].map((x, k) => {
                        if (k !== i) return x;
                        const { bubble: _old, ...rest } = x;
                        return v ? { ...rest, bubble: v } : rest;
                      }),
                    });
                  }}
                >
                  <option value="">{t("attr.grid.axisBubble.grid")}</option>
                  <option value="both">{t("attr.grid.bubbles.both")}</option>
                  <option value="start">{t("attr.grid.bubbles.start")}</option>
                  <option value="end">{t("attr.grid.bubbles.end")}</option>
                </select>
              </span>,
              "grid-axis-row",
            )}
          </Fragment>
        )),
      )}
      {row(
        t("attr.grid.levels"),
        <select
          value={here ? "here" : "all"}
          onChange={(e) => set({ levels: e.target.value === "here" ? [drawing.levelId] : undefined })}
        >
          <option value="all">{t("attr.grid.levels.all")}</option>
          <option value="here">{t("attr.grid.levels.here")}</option>
        </select>,
      )}
    </>
  );
}
