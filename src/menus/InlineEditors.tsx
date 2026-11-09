// Inline-Editoren aus dem Kontextmenü ([121] aus App.tsx herausgelöst): Ebene (Name, Farbe/Stift,
// Strichstärke, Schraffur) und Zeichnungsebene (Name, Höhen, Ansichtsbereich). Wirken live auf den
// Store; das Projekt lesen sie selbst (nur solange offen abonniert).
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { ComponentProps } from "react";
import { t } from "../i18n";
import { activePenSet, resolvePenColor, resolvePenWeight } from "../model/penSets";
import { findCategory, formatElevation } from "../model/layers";
import type { DrawingLevel, LayerCategory } from "../model/types";
import { getState, useStore } from "../state/appStore";
import { EditorField } from "../ui/EditorField";
import { HatchSwatch } from "../ui/hatchPreview";
import { PenColorField } from "../ui/PenColorField";
import { InlineEditor } from "../views/InlineEditor";

export function LayerInlineEditor({
  editor,
  onClose,
  patchCategory,
  onSaveColor,
}: {
  editor: { code: string; x: number; y: number };
  onClose: () => void;
  patchCategory: (code: string, patch: Partial<LayerCategory>) => void;
  onSaveColor: ComponentProps<typeof PenColorField>["onSaveColor"];
}) {
  const project = useStore((s) => s.project);
  const cat = findCategory(project.layers, editor.code);
  if (!cat) return null;
  return (
    <InlineEditor
      x={editor.x}
      y={editor.y}
      title={t("editor.layerTitle", { code: cat.code })}
      onClose={onClose}
    >
      <EditorField label={t("editor.name")}>
        <input
          type="text"
          value={cat.name}
          autoFocus
          onChange={(e) =>
            patchCategory(cat.code, { name: e.target.value })
          }
        />
      </EditorField>
      <EditorField label={t("editor.color")}>
        <PenColorField
          color={cat.colorPenId ? resolvePenColor(project, cat.colorPenId) : cat.color}
          penId={cat.colorPenId}
          pens={project.pens ?? []}
          activeStyles={activePenSet(project)?.pens}
          customPalettes={project.customPalettes}
          builtinBanks={project.builtinPaletteBanks}
          onSaveColor={onSaveColor}
          showWeight
          onColorChange={(color) => patchCategory(cat.code, { color, colorPenId: undefined })}
          onPenChange={(colorPenId) =>
            patchCategory(cat.code, {
              colorPenId,
              ...(colorPenId
                ? { color: resolvePenColor(project, colorPenId), lw: resolvePenWeight(project, colorPenId) }
                : {}),
            })
          }
        />
      </EditorField>
      <EditorField label={t("editor.lineWeight")}>
        <span className="editor-num">
          <input
            type="number"
            step={0.01}
            min={0.01}
            value={cat.lw}
            disabled={!!cat.colorPenId}
            onChange={(e) =>
              patchCategory(cat.code, { lw: Number(e.target.value) })
            }
          />
          <span className="editor-unit">{t("editor.unit.mm")}</span>
        </span>
      </EditorField>
      <EditorField label={t("editor.hatch")}>
        <span className="editor-hatch">
          <select
            value={cat.hatch ?? ""}
            onChange={(e) =>
              patchCategory(cat.code, {
                hatch: e.target.value || undefined,
              })
            }
          >
            <option value="">{t("resources.viewHatch.none")}</option>
            {project.hatches.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
          {cat.hatch &&
            (() => {
              const h = project.hatches.find((ht) => ht.id === cat.hatch);
              return h ? <HatchSwatch hatch={h} size={26} /> : null;
            })()}
        </span>
      </EditorField>
    </InlineEditor>
  );
}

/** Bezugsgeschoss ±0.00: das erste Geschoss mit `zeroLevel`, sonst das erste Geschoss. */
function isZeroLevel(levels: readonly DrawingLevel[], id: string): boolean {
  const floors = levels.filter((z) => z.kind === "floor");
  return (floors.find((z) => z.zeroLevel) ?? floors[0])?.id === id;
}

/**
 * [131] Höhe eines Geschosses direkt setzen: Über ±0.00 wird die Geschosshöhe des Geschosses darunter angepasst,
 * unter ±0.00 die eigene (Abstand zum Geschoss darüber). Liefert die Änderung oder `null` bei Unsinn
 * (gleiche Höhe, nicht positiv, Bezugsgeschoss).
 */
export function elevationFix(levels: readonly DrawingLevel[], id: string, z: number): { id: string; floorHeight: number } | null {
  if (!Number.isFinite(z)) return null;
  const floors = levels.filter((l) => l.kind === "floor").slice().sort((a, b) => (a.baseElevation ?? 0) - (b.baseElevation ?? 0));
  const i = floors.findIndex((l) => l.id === id);
  if (i < 0 || isZeroLevel(levels, id)) return null;
  const cur = floors[i].baseElevation ?? 0;
  if (Math.abs(z - cur) < 1e-9) return null;
  const round = (v: number) => Math.round(v * 1e6) / 1e6;
  if (cur > 0) {
    const below = floors[i - 1];
    const h = round(z - (below?.baseElevation ?? 0));
    return below && h > 0 ? { id: below.id, floorHeight: h } : null;
  }
  const above = floors[i + 1];
  const h = round((above?.baseElevation ?? 0) - z);
  return above && h > 0 ? { id, floorHeight: h } : null;
}

export function LevelInlineEditor({
  editor,
  onClose,
  patchLevel,
}: {
  editor: { id: string; x: number; y: number };
  onClose: () => void;
  patchLevel: (id: string, patch: Partial<DrawingLevel>) => void;
}) {
  // Nur die Zeichnungsebenen abonnieren ([121]).
  const drawingLevels = useStore((s) => s.project.drawingLevels);
  const level = drawingLevels.find((z) => z.id === editor.id);
  if (!level) return null;
  const isFloor = level.kind === "floor";
  return (
    <InlineEditor
      x={editor.x}
      y={editor.y}
      title={level.name}
      onClose={onClose}
    >
      <EditorField label={t("editor.name")}>
        <input
          type="text"
          value={level.name}
          autoFocus
          onChange={(e) => patchLevel(level.id, { name: e.target.value })}
        />
      </EditorField>
      {isFloor && (
        <>
          {/* [131] OK fertig Boden relativ zu ±0.00 (aus dem Stapel); ein Geschoss ist der Bezug. */}
          <EditorField label={t("editor.levelElevation")}>
            <span className="editor-num">
              {isZeroLevel(drawingLevels, level.id) ? (
                <span data-testid="level-elevation">{formatElevation(level.baseElevation ?? 0)}</span>
              ) : (
                <input
                  key={`${level.id}:${level.baseElevation ?? 0}`}
                  type="number"
                  step={0.05}
                  data-testid="level-elevation-input"
                  title={t("editor.levelElevation.hint")}
                  defaultValue={Math.round((level.baseElevation ?? 0) * 1000) / 1000}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    e.stopPropagation();
                    const fix = elevationFix(drawingLevels, level.id, Number((e.target as HTMLInputElement).value));
                    if (fix) patchLevel(fix.id, { floorHeight: fix.floorHeight });
                  }}
                  onBlur={(e) => {
                    const fix = elevationFix(drawingLevels, level.id, Number(e.target.value));
                    if (fix) patchLevel(fix.id, { floorHeight: fix.floorHeight });
                  }}
                />
              )}
              <span className="editor-unit">{t("editor.unit.m")}</span>
            </span>
          </EditorField>
          <EditorField label={t("editor.zeroLevel")}>
            <input
              type="checkbox"
              data-testid="level-zero"
              title={t("editor.zeroLevel.hint")}
              checked={isZeroLevel(drawingLevels, level.id)}
              disabled={isZeroLevel(drawingLevels, level.id)}
              onChange={(e) => {
                if (!e.target.checked) return;
                const prev = drawingLevels.find((z) => z.kind === "floor" && z.zeroLevel && z.id !== level.id);
                // Ein Undo-Schritt: altes Kennzeichen weg, neues setzen; der Kern stapelt neu.
                if (prev) getState().groupChanges(() => {
                  patchLevel(prev.id, { zeroLevel: undefined });
                  patchLevel(level.id, { zeroLevel: true });
                });
                else patchLevel(level.id, { zeroLevel: true });
              }}
            />
          </EditorField>
          <EditorField label={t("editor.floorHeight")}>
            <span className="editor-num">
              <input
                type="number"
                step={0.05}
                min={0}
                value={level.floorHeight ?? 0}
                onChange={(e) =>
                  patchLevel(level.id, {
                    floorHeight: Number(e.target.value),
                  })
                }
              />
              <span className="editor-unit">{t("editor.unit.m")}</span>
            </span>
          </EditorField>
          <EditorField label={t("editor.cutHeight")}>
            <span className="editor-num">
              <input
                type="number"
                step={0.05}
                min={0}
                value={level.cutHeight ?? 0}
                onChange={(e) =>
                  patchLevel(level.id, {
                    cutHeight: Number(e.target.value),
                  })
                }
              />
              <span className="editor-unit">{t("editor.unit.m")}</span>
            </span>
          </EditorField>
          {/* Ansichtsbereich ([36]): leer = unbegrenzt (Darstellung wie bisher). */}
          {(["viewTop", "viewBottom", "viewDepth"] as const).map((k) => (
            <EditorField key={k} label={t(`editor.${k}`)}>
              <span className="editor-num">
                <input
                  type="number"
                  step={0.1}
                  min={k === "viewDepth" ? 0 : undefined}
                  data-testid={`level-${k}`}
                  value={level[k] ?? ""}
                  placeholder="∞"
                  onChange={(e) =>
                    patchLevel(level.id, {
                      [k]: e.target.value === "" ? undefined : Number(e.target.value),
                    })
                  }
                />
                <span className="editor-unit">{t("editor.unit.m")}</span>
              </span>
            </EditorField>
          ))}
        </>
      )}
      {/* Deckenspiegel ([100]): Geschoss, dessen Untersicht gezeigt wird. */}
      {level.kind === "ceiling" && (
        <EditorField label={t("editor.ceilingOf")}>
          <select
            data-testid="level-ceiling-of"
            value={level.ceilingOfId ?? ""}
            onChange={(e) => patchLevel(level.id, { ceilingOfId: e.target.value || undefined })}
          >
            {drawingLevels
              .filter((z) => z.kind === "floor" && !z.layoutId)
              .map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
          </select>
        </EditorField>
      )}
      {/* Sichttiefe ([36]) für Schnitt/Ansicht: leer = unbegrenzt (Darstellung wie bisher). */}
      {(level.kind === "section" || level.kind === "elevation") && (
        <EditorField label={t("editor.sectionDepth")}>
          <span className="editor-num" title={t("editor.sectionDepth.hint")}>
            <input
              type="number"
              step={0.5}
              min={0}
              data-testid="level-depth"
              value={level.depth ?? ""}
              placeholder="∞"
              onChange={(e) => {
                const v = Number(e.target.value);
                patchLevel(level.id, { depth: e.target.value === "" || !(v > 0) ? undefined : v });
              }}
            />
            <span className="editor-unit">{t("editor.unit.m")}</span>
          </span>
        </EditorField>
      )}
      {!isFloor && (
        <div className="editor-note">
          {level.kind === "drawing" || level.kind === "ceiling"
            ? t("editor.noHeightDrawing")
            : t("editor.noHeightSection")}
        </div>
      )}
    </InlineEditor>
  );
}
