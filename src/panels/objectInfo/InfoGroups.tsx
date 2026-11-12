// [189] Die einklappbaren Bauteil-/BIM-Abschnitte der Objekt-Info (früher im Attribute-Panel): welche es für die
// Auswahl gibt, bestimmt `groups.ts`; hier werden sie gerendert. Gerufen von `ObjectInfoPanel`.

import type { ReactNode } from "react";
import type { Drawing2D } from "../../model/types";
import type { SelectionInfo } from "../../state/selectionInfo";
import type { usePanelHost } from "../host";
import { SurfacePatternPlacement } from "../SurfacePatternPlacement";
import { CeilingSection } from "./CeilingSection";
import { GridSection } from "./GridSection";
import { InfoGroup } from "./InfoGroup";
import { NewComponentSection } from "./NewComponentSection";
import { OpeningEditorSection } from "./OpeningEditor";
import { OpeningSection } from "./OpeningSections";
import { DetailRefSection, DimRefsSection, DimTextSection } from "./RefSections";
import { RoofSection } from "./RoofSections";
import { RoomSection } from "./RoomSection";
import { RoomStampSection } from "./RoomStampSection";
import { SectionLineSection } from "./SectionLineSection";
import { ColumnSection, ExtrudedSolidSection } from "./SolidSections";
import { StairSection } from "./StairSection";
import { WallSection } from "./WallSection";
import { infoGroups, type InfoGroupId } from "./groups";

type Host = ReturnType<typeof usePanelHost>;

function groupIds(sel: SelectionInfo | null, drawing: Drawing2D | undefined, host: Host): InfoGroupId[] {
  return infoGroups({
    sel,
    isGrid: drawing?.geom.shape === "grid",
    sectionLine: !!host.sectionLine,
    newComponentTool: host.activeTool === "wall" || host.activeTool === "ceiling",
  });
}

/** Ob für diese Auswahl mindestens ein Abschnitt erscheint. */
export function hasInfoGroups(sel: SelectionInfo | null, drawing: Drawing2D | undefined, host: Host): boolean {
  return groupIds(sel, drawing, host).length > 0;
}

export function InfoGroups({ sel, drawing, host }: { sel: SelectionInfo | null; drawing: Drawing2D | undefined; host: Host }) {
  const body = (id: InfoGroupId): ReactNode => {
    switch (id) {
      case "newComponent": return <NewComponentSection host={host} />;
      case "sectionLine": return host.sectionLine ? <SectionLineSection level={host.sectionLine} host={host} /> : null;
      case "wall": return sel?.wall ? <WallSection wall={sel.wall} host={host} /> : null;
      case "ceiling": return sel?.ceiling ? <CeilingSection ceiling={sel.ceiling} host={host} /> : null;
      case "roof": return sel?.roof ? <RoofSection roof={sel.roof} host={host} /> : null;
      case "surfacePattern": return sel ? <SurfacePatternPlacement kind={sel.wall ? "wall" : "roof"} id={sel.id} host={host} /> : null;
      case "opening": return sel?.opening ? <OpeningSection opening={sel.opening} host={host} /> : null;
      case "openingEditor": return sel?.opening ? <OpeningEditorSection openingId={sel.opening.id} host={host} /> : null;
      case "stair": return sel?.stair ? <StairSection stair={sel.stair} host={host} /> : null;
      case "room": return sel?.room ? <RoomSection room={sel.room} roomId={sel.id} host={host} /> : null;
      case "roomStamp": return sel?.room ? <RoomStampSection roomId={sel.id} /> : null;
      case "extrudedSolid": return sel?.extrudedSolid ? <ExtrudedSolidSection solid={sel.extrudedSolid} host={host} /> : null;
      case "column": return sel?.column ? <ColumnSection column={sel.column} host={host} /> : null;
      case "detailRef": return sel?.detailRef ? <DetailRefSection detailRef={sel.detailRef} drawingId={sel.id} host={host} /> : null;
      case "dimRefs": return sel?.dimRefs ? <DimRefsSection refs={sel.dimRefs} drawingId={sel.id} host={host} /> : null;
      case "dimText": return sel ? <DimTextSection drawingId={sel.id} host={host} /> : null;
      case "grid": return drawing ? <GridSection drawing={drawing} host={host} /> : null;
    }
  };
  return (
    <>
      {groupIds(sel, drawing, host).map((id) => (
        <InfoGroup key={id} id={id}>{body(id)}</InfoGroup>
      ))}
    </>
  );
}
