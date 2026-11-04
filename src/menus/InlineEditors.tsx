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

export function LevelInlineEditor({
  editor,
  onClose,
  patchLevel,
}: {
  editor: { id: string; x: number; y: number };
  onClose: () => void;
  patchLevel: (id: string, patch: Partial<DrawingLevel>) => void;
}) {
  const project = useStore((s) => s.project);
  const level = project.drawingLevels.find((z) => z.id === editor.id);
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
              <span data-testid="level-elevation">{formatElevation(level.baseElevation ?? 0)}</span>
              <span className="editor-unit">{t("editor.unit.m")}</span>
            </span>
          </EditorField>
          <EditorField label={t("editor.zeroLevel")}>
            <input
              type="checkbox"
              data-testid="level-zero"
              title={t("editor.zeroLevel.hint")}
              checked={isZeroLevel(project.drawingLevels, level.id)}
              disabled={isZeroLevel(project.drawingLevels, level.id)}
              onChange={(e) => {
                if (!e.target.checked) return;
                const prev = project.drawingLevels.find((z) => z.kind === "floor" && z.zeroLevel && z.id !== level.id);
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
      {!isFloor && (
        <div className="editor-note">
          {level.kind === "drawing"
            ? t("editor.noHeightDrawing")
            : t("editor.noHeightSection")}
        </div>
      )}
    </InlineEditor>
  );
}
