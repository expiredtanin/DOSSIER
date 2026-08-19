// Raum-Domäne des Grundriss-Generators (SIA-416-Flächen): eine (unsichtbare,
// nur klickbare) Füllfläche + dünne neutrale Umrisslinie + ein Raum-Stempel
// (Name, Fläche, SIA-Kürzel) am Anker.

import type { Room } from "../../model/types";
import { evaluateRoom, siaLabel } from "../../geometry/roomArea";
import { docFromText } from "../../text/richText";
import { roomStampExtraLines, roomStampToDoc } from "../../model/roomStamp";
import { LAYER_DETAIL_FACTOR, LAYER_LINE_MM, NO_HATCH, type DetailLevel, type Primitive } from "./shared";

/**
 * Deckkraft (0..255) der Raum-Füllung → 2-stelliges Hex-Suffix. Transluzente
 * Farbfüllung entfällt — Plandarstellung schwarz/grau; Farbe bleibt späteren
 * Schema-Ebenen vorbehalten. Alpha 0 = unsichtbar; das Polygon bleibt als
 * `roomId`-Primitiv erhalten (Auswahl per Punkt-in-Polygon in PlanView, NICHT
 * über die native Pointer-Trefferfläche der Füllung — die volle Fläche bleibt
 * damit trotz Alpha 0 klickbar).
 */
const ROOM_FILL_ALPHA = "00";
/** Basis-Schriftgrösse des Raum-Stempels in Punkt (pt). */
const ROOM_STAMP_PT = 10;

/** Farbe mit Alpha-Suffix versehen (nur, wenn `color` ein 6-stelliges Hex ist). */
function withAlpha(color: string, alphaHex: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? `${color}${alphaHex}` : color;
}

/**
 * Raum (SIA-416-Fläche) im Grundriss: eine (unsichtbare, nur klickbare) Füll-
 * fläche über dem lichten Umriss + eine dünne neutrale Umrisslinie (beide
 * `roomId`-getaggt für die Auswahl) + ein Raum-Stempel (Text) am Anker
 * (Centroid oder `stampAnchor`) mit Name, Fläche „24.30 m²" und SIA-Kürzel.
 * Keine Farbwäsche — Plandarstellung schwarz/grau, Farbe bleibt späteren
 * Schema-Ebenen vorbehalten. Der Stempel entfällt beim Detailgrad „grob";
 * Fläche/Umfang/Schwerpunkt werden aus `boundary` abgeleitet (nie gespeichert).
 * Wird UNTER der Wand-Poché gezeichnet.
 */
export function addRoomArea(
  out: Primitive[],
  room: Room,
  greyed: boolean,
  detail: DetailLevel,
): void {
  const pts = room.boundary;
  if (pts.length < 3) return;
  const res = evaluateRoom(pts, room.siaCategory);
  const stroke = room.color;

  // Unsichtbare Füllfläche (Alpha 0): keine Farbwäsche im Plan, das Polygon
  // bleibt aber als `roomId`-Primitiv für die Punkt-in-Polygon-Auswahl erhalten.
  out.push({
    kind: "polygon",
    pts,
    fill: withAlpha(room.color, ROOM_FILL_ALPHA),
    stroke,
    strokeWidthMm: LAYER_LINE_MM * LAYER_DETAIL_FACTOR[detail],
    hatch: NO_HATCH,
    greyed,
    roomId: room.id,
  });

  // Raum-Stempel: frei editierbarer Rich-Text (Name/Notizen) + LIVE-Flächenzeile
  // + SIA-Kürzel. Anker fix (stampAnchor, sonst Centroid). Nur ab Detailgrad
  // „mittel". Die Flächenzeile aktualisiert sich unabhängig vom editierten Text.
  if (detail !== "grob") {
    const at = room.stampAnchor ?? res.centroid;
    // Strukturierter Stempel (Feldmodell) hat Vorrang; sonst Alt-Pfad (Rich-Text
    // bzw. Raum-Name als einfacher Text).
    const doc = room.stamp
      ? roomStampToDoc(room.stamp)
      : room.stampDoc ?? docFromText(room.name);
    const extraLines = room.stamp
      ? roomStampExtraLines(room.stamp, {
          netArea: res.netArea,
          siaCategory: room.siaCategory,
          siaLabel: siaLabel(room.siaCategory),
        })
      : [
          { text: `${res.netArea.toFixed(2)} m²`, align: "center" as const },
          {
            text: `${room.siaCategory} · ${siaLabel(room.siaCategory)}`,
            align: "center" as const,
          },
        ];
    out.push({
      kind: "text",
      at,
      doc,
      extraLines,
      basePt: ROOM_STAMP_PT,
      color: stroke,
      roomId: room.id,
      greyed,
    });
  }
}
