// Generischer Rumpf für formular-basierte Typ-Bibliotheken (Tür-/Fenster-/
// Treppentypen): Liste links (Name je Zeile, „+ Neu" im Fuß), Editor rechts
// (Umbenennen-Feld + Löschen-Knopf im Kopf, darunter die typspezifischen
// Felder aus `renderFields`). Handler sind optional (nur gesetzt, wenn die
// einbettende App sie bereitstellt) — Aufrufe laufen daher über `?.()`.
//
// Gemeinsam genutzt von {@link DoorStylesTab}, {@link WindowStylesTab} und
// {@link StairStylesTab} (siehe die jeweiligen Dateien).

import { useState } from "react";
import { t } from "../../i18n";
import { DeleteButton } from "./fields";

// Bezugsfläche des Schichteinzugs — von aussen oder innen gemessen. Für Tür UND
// Fenster genutzt (gleiche Semantik).
export const INSET_FACE_OPTIONS: { value: "aussen" | "innen"; labelKey: string }[] = [
  { value: "aussen", labelKey: "resources.insetFace.aussen" },
  { value: "innen", labelKey: "resources.insetFace.innen" },
];

export function TypeLibraryTab<T extends { id: string; name: string }>({
  types,
  hintKey,
  emptyKey,
  placeholderKey,
  deleteKeyPrefix,
  onAdd,
  onPatch,
  onDelete,
  renderFields,
}: {
  types: T[];
  hintKey: string;
  emptyKey: string;
  placeholderKey: string;
  deleteKeyPrefix: string;
  onAdd?: () => void;
  onPatch?: (id: string, patch: Partial<T>) => void;
  onDelete?: (id: string) => void;
  renderFields: (item: T, onPatch: (patch: Partial<T>) => void) => React.ReactNode;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = types.find((x) => x.id === selectedId) ?? types[0];

  return (
    <div className="res-tab">
      <div className="res-hint">{t(hintKey)}</div>
      <div className="res-md">
        <div className="res-md-list">
          {types.map((item) => (
            <button
              key={item.id}
              className={`res-md-row${selected?.id === item.id ? " active" : ""}`}
              onClick={() => setSelectedId(item.id)}
            >
              <span className="res-md-row-name">{item.name}</span>
            </button>
          ))}
          {types.length === 0 && (
            <div className="res-md-empty">{t(emptyKey)}</div>
          )}
          <div className="res-md-listfoot">
            <button className="res-add" onClick={() => onAdd?.()}>
              <span className="res-add-plus">+</span> {t("resources.add")}
            </button>
          </div>
        </div>
        <div className="res-md-detail">
          {selected ? (
            <div className="res-md-detail-inner" key={selected.id}>
              <div className="res-md-head">
                <input
                  className="res-input res-md-rename"
                  value={selected.name}
                  placeholder={t(placeholderKey)}
                  onChange={(e) =>
                    onPatch?.(selected.id, { name: e.target.value } as Partial<T>)
                  }
                />
                <DeleteButton
                  onClick={() => onDelete?.(selected.id)}
                  title={t(deleteKeyPrefix, { name: selected.name })}
                />
              </div>
              <div className="res-fields">
                {renderFields(selected, (patch) => onPatch?.(selected.id, patch))}
              </div>
            </div>
          ) : (
            <div className="res-md-empty">{t(emptyKey)}</div>
          )}
        </div>
      </div>
    </div>
  );
}
