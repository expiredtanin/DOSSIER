// Gruppe „Kameras" im Ausschnitte-Panel ([213]): die gespeicherten Kameras des Projekts als Liste. Klick wählt die
// Kamera (Objekt-Info, Symbol im Grundriss), Doppelklick bzw. „↗" setzt die 3D-Ansicht exakt, „+" legt aus der
// aktuellen 3D-Ansicht eine neue an, „✕" löscht. Die Kameras selbst sind Modell-Elemente (`Project.cameras`).

import { removeItems } from "../core";
import { t } from "../i18n";
import { createCameraFromView, openCamera } from "../state/cameraActions";
import { getState, useStore } from "../state/appStore";
import { fromIds } from "../state/selection";

export function CamerasGroup() {
  const cameras = useStore((s) => s.project.cameras);
  const levels = useStore((s) => s.project.drawingLevels);
  const selected = useStore((s) => s.selection.cameras);
  const list = cameras ?? [];
  return (
    <section className="nav-group" data-testid="cameras-group">
      <header className="nav-group-head">
        <span className="nav-group-title">{t("camera.title")}</span>
        <span className="nav-group-actions">
          <button className="nav-add" style={{ display: "inline-flex", padding: "1px 5px" }} title={t("camera.createFromView")} data-testid="camera-create" onClick={() => createCameraFromView()}>
            +
          </button>
        </span>
      </header>
      {list.length === 0 ? (
        <div style={{ padding: "10px 10px", fontSize: 12, color: "var(--muted)" }}>{t("camera.empty")}</div>
      ) : (
        <div className="nav-list">
          {list.map((c) => (
            <div
              key={c.id}
              className={`nav-row${selected.includes(c.id) ? " active" : ""}`}
              data-testid={`camera-row-${c.id}`}
              title={t("camera.rowHint")}
              onClick={() => getState().setSelection(fromIds("cameras", [c.id]))}
              onDoubleClick={() => void openCamera(c.id)}
              style={{ display: "flex", alignItems: "center", gap: 4, paddingLeft: 10 }}
            >
              <span className="nav-label" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {c.name}
                <span style={{ color: "var(--muted)", marginLeft: 6 }}>{levels.find((l) => l.id === c.floorId)?.name ?? ""}</span>
              </span>
              <button
                className="nav-add"
                style={{ padding: "1px 5px" }}
                title={t("camera.open")}
                data-testid={`camera-open-${c.id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void openCamera(c.id);
                }}
              >
                ↗
              </button>
              <button
                className="nav-add"
                style={{ padding: "1px 5px" }}
                title={t("camera.delete")}
                disabled={!!c.locked}
                onClick={(e) => {
                  e.stopPropagation();
                  getState().applyChange((p) => removeItems(p, "cameras", [c.id]));
                  getState().setSelection(fromIds("cameras", []));
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
