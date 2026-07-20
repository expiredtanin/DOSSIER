// Inhalts-Panel „Elemente" — BIM-Baum Geschoss → Bauteilklasse → Element
// (ROADMAP §11 „Element-Übersicht", Phase 1).
//
// Datenquelle: `scheduleRows()` (export/exportSchedule.ts) — dieselbe
// Auswertung wie die Bauteilliste (CSV-Export), hier aber live zu einem
// klick-/zoombaren Baum gruppiert statt exportiert. Legacy-„Tür"-Datensätze
// (project.doors) werden ausgeblendet: dafür existiert aktuell KEIN
// Auswahl-Kanal (nichts legt sie mehr an, siehe evalDoor-Kommentar) — echte
// Türen laufen als Öffnung (`Opening.kind === "door"`) und erscheinen hier
// als Bauteilklasse „Öffnung".
//
// Klick selektiert das Element (leert alle anderen Auswahl-Kanäle, wechselt
// bei Bedarf das Geschoss); Shift-Klick oder Doppelklick selektiert UND passt
// die Plan-Ansicht ein. Auf-/zuklappbare Geschoss- und Klassen-Knoten, ein
// Textfilter oben durchsucht Name/Typ/Klasse.
//
// Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md).

import { useMemo, useState } from "react";
import { usePanelHost } from "./host";
import type { ScheduleKind, ScheduleRow } from "./host";
import { scheduleRows } from "../export/exportSchedule";
import { t } from "../i18n";

/** Bauteilklassen, die im Baum erscheinen (Reihenfolge = Anzeigereihenfolge). */
const CLASS_ORDER: Exclude<ScheduleKind, "Tür">[] = [
  "Wand",
  "Decke",
  "Dach",
  "Stütze",
  "Fenster",
  "Öffnung",
  "Treppe",
  "Extrusion",
];

/** i18n-Key des Klassen-Labels je Bauteilklasse. */
const CLASS_LABEL_KEY: Record<Exclude<ScheduleKind, "Tür">, string> = {
  Wand: "elements.kind.wall",
  Decke: "elements.kind.ceiling",
  Dach: "elements.kind.roof",
  Stütze: "elements.kind.column",
  Fenster: "elements.kind.window",
  Öffnung: "elements.kind.opening",
  Treppe: "elements.kind.stair",
  Extrusion: "elements.kind.extrusion",
};

/** Kurzform einer ID für die Anzeige (voller Wert bleibt im Tooltip). */
function shortId(id: string): string {
  return id.length <= 14 ? id : `${id.slice(0, 4)}…${id.slice(-6)}`;
}

/** Ein Geschoss-Knoten des Baums (auch für Elemente ohne bekanntes Geschoss). */
interface FloorGroup {
  /** Gruppierungsschlüssel: die Geschoss-ID, oder ein Namens-Fallback. */
  key: string;
  /** Anzeigename (Geschoss-Name bzw. bereits aufgelöster Fallback aus row.floor). */
  name: string;
  rows: ScheduleRow[];
}

/** Gruppiert Zeilen nach Geschoss, in der Reihenfolge der Zeichnungsebenen (oben→unten). */
function buildFloorGroups(
  rows: ScheduleRow[],
  levels: { id: string; name: string }[],
): FloorGroup[] {
  const byKey = new Map<string, ScheduleRow[]>();
  for (const r of rows) {
    const key = r.floorId ?? `name:${r.floor}`;
    const list = byKey.get(key);
    if (list) list.push(r);
    else byKey.set(key, [r]);
  }
  // Oberstes Geschoss zuoberst, wie im Zeichnungsebenen-Panel.
  const levelsTopDown = [...levels].reverse();
  const groups: FloorGroup[] = [];
  const used = new Set<string>();
  for (const lvl of levelsTopDown) {
    const list = byKey.get(lvl.id);
    if (list && list.length) {
      groups.push({ key: lvl.id, name: lvl.name, rows: list });
      used.add(lvl.id);
    }
  }
  // Rest (Elemente ohne bekannte Zeichnungsebene, z. B. verwaiste Referenz).
  for (const [key, list] of byKey) {
    if (used.has(key)) continue;
    groups.push({ key, name: list[0].floor, rows: list });
  }
  return groups;
}

/** Ob eine Zeile zum Suchtext passt (Name/Typ/Klasse, case-insensitive). */
function matchesQuery(row: ScheduleRow, classLabel: string, query: string): boolean {
  const haystack = `${row.typeName} ${classLabel} ${row.id}`.toLowerCase();
  return haystack.includes(query);
}

export function ElementTreePanel() {
  const host = usePanelHost();
  const [query, setQuery] = useState("");
  const [collapsedFloors, setCollapsedFloors] = useState<Set<string>>(new Set());
  const [collapsedClasses, setCollapsedClasses] = useState<Set<string>>(new Set());

  const allRows = useMemo(
    () => scheduleRows(host.project).filter((r) => r.kind !== "Tür"),
    [host.project],
  );

  const q = query.trim().toLowerCase();
  const searching = q.length > 0;

  const visibleRows = useMemo(() => {
    if (!searching) return allRows;
    return allRows.filter((r) =>
      matchesQuery(r, t(CLASS_LABEL_KEY[r.kind as Exclude<ScheduleKind, "Tür">]), q),
    );
  }, [allRows, q, searching]);

  const floorGroups = useMemo(
    () => buildFloorGroups(visibleRows, host.project.drawingLevels),
    [visibleRows, host.project.drawingLevels],
  );

  const toggleFloor = (key: string) =>
    setCollapsedFloors((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const toggleClass = (key: string) =>
    setCollapsedClasses((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const onRowSelect = (row: ScheduleRow, zoom: boolean) => {
    host.onSelectScheduleRow(row.kind, row.id, row.floorId, { zoom });
  };

  if (allRows.length === 0) {
    return (
      <section className="nav-group">
        <header className="nav-group-head">
          <span className="nav-group-title">{t("elements.title")}</span>
        </header>
        <div style={{ padding: "10px 10px", fontSize: 12, color: "var(--muted)" }}>
          {t("elements.empty")}
        </div>
      </section>
    );
  }

  return (
    <section className="nav-group">
      <header className="nav-group-head">
        <span className="nav-group-title">{t("elements.title")}</span>
      </header>

      <div style={{ padding: "0 6px 6px" }}>
        <input
          type="text"
          value={query}
          placeholder={t("elements.search")}
          onChange={(e) => setQuery(e.target.value)}
          style={{
            width: "100%",
            boxSizing: "border-box",
            background: "var(--input)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            color: "var(--label)",
            fontFamily: "inherit",
            fontSize: 11,
            padding: "4px 8px",
          }}
        />
      </div>

      {floorGroups.length === 0 ? (
        <div style={{ padding: "10px 10px", fontSize: 12, color: "var(--muted)" }}>
          {t("elements.noMatch")}
        </div>
      ) : (
        floorGroups.map((floor) => {
          const floorOpen = searching || !collapsedFloors.has(floor.key);
          return (
            <div className="level-cat" key={floor.key}>
              <header
                className="level-cat-head"
                onClick={() => toggleFloor(floor.key)}
              >
                <span
                  className={`level-cat-chevron${floorOpen ? " open" : ""}`}
                  aria-hidden="true"
                >
                  ▸
                </span>
                <span className="level-cat-title">{floor.name}</span>
                <span style={{ fontSize: 10, color: "var(--muted)" }}>
                  {floor.rows.length}
                </span>
              </header>

              {floorOpen && (
                <div className="nav-list">
                  {CLASS_ORDER.map((kind) => {
                    const rowsOfKind = floor.rows.filter((r) => r.kind === kind);
                    if (rowsOfKind.length === 0) return null;
                    const classKey = `${floor.key}::${kind}`;
                    const classOpen = searching || !collapsedClasses.has(classKey);
                    return (
                      <div key={classKey}>
                        <header
                          className="level-cat-head"
                          style={{ paddingLeft: 20, minHeight: 20 }}
                          onClick={() => toggleClass(classKey)}
                        >
                          <span
                            className={`level-cat-chevron${classOpen ? " open" : ""}`}
                            aria-hidden="true"
                          >
                            ▸
                          </span>
                          <span className="level-cat-title" style={{ fontSize: 9 }}>
                            {t(CLASS_LABEL_KEY[kind])}
                          </span>
                          <span style={{ fontSize: 10, color: "var(--muted)" }}>
                            {rowsOfKind.length}
                          </span>
                        </header>

                        {classOpen && (
                          <div className="nav-list">
                            {rowsOfKind.map((row) => (
                              <div
                                key={row.id}
                                className="nav-row"
                                style={{ paddingLeft: 34 }}
                                title={row.id}
                                onClick={(e) => onRowSelect(row, e.shiftKey)}
                                onDoubleClick={() => onRowSelect(row, true)}
                              >
                                <span className="nav-label">{row.typeName}</span>
                                <span className="nav-elev">{shortId(row.id)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })
      )}
    </section>
  );
}

/** Tab-Symbol „Elemente" — kleiner Baum (Ast + drei Blätter). */
export function ElementsTabIcon() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <line x1="3" y1="2.5" x2="3" y2="13.5" />
      <line x1="3" y1="5" x2="8" y2="5" />
      <line x1="3" y1="8" x2="8" y2="8" />
      <line x1="3" y1="11" x2="8" y2="11" />
      <circle cx="11" cy="5" r="1.6" />
      <circle cx="11" cy="8" r="1.6" />
      <circle cx="11" cy="11" r="1.6" />
    </svg>
  );
}
