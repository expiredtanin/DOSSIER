// Fassade des Kerns für die Hülle (Phase A der Kern/UI-Trennung, docs/core-ui-split.md).
// Dünne Durchreichung, Namen 1:1; die Hülle importiert Plan-/Geometrie-Funktionen nur noch von hier.
// Erzeugt mit scripts/core-facade.py — neue Einträge von Hand ergänzen.

export {
  bulgeArc,
  bulgeArcPoints,
  bulgePolylinePoints,
  bulgeFromSagittaPoint,
  bulgePointAt,
  hasRealBulge,
  pointOnCircle,
} from "../geometry/bulge";

export {
  columnFootprint,
} from "../geometry/column";

export {
  sampleBezierChain,
  sampleCatmullRom,
  sampleUniformBSpline,
} from "../geometry/curves";

export {
  type DrawingIndex,
  buildDrawingIndex,
  drawingsWithinDistance,
  nearestInDrawings,
  pointSegDist as pointSegDist__geometry_drawingIndex,
} from "../geometry/drawingIndex";

export {
  type ModelSnapCand,
  type ModelSnapResult,
  holdModelSnap,
  queryModelSnap,
} from "../geometry/modelSnap";

export {
  vecEqual,
} from "../geometry/kernel2d";

export {
  LINE_PRESETS,
  type LinePresetKey,
  type LineSegment,
  type LineSegmentType,
  dashHasDot,
  dashToSegments,
  presetOfDash,
  segmentsToDash,
} from "../geometry/lineSegments";

export * as polygonBool from "../geometry/polygonBool";

export {
  nearestPolylineTarget,
  toleranceFor,
} from "../geometry/polylinePoint";

export {
  type PolylineVertexType,
  canSetVertexType,
  vertexTypeOf,
} from "../geometry/polylineVertexType";

export {
  roofBaseElevation,
  roofGeometry,
} from "../geometry/roof";

export {
  removeRoofHole,
  setRoofEdge,
} from "../geometry/roofEdges";
export type { EdgeSpec, RoofEdge } from "../geometry/roofEdges";

export {
  SIA_CATEGORIES,
  balance,
  centroid,
  evaluateRoom,
  polygonArea,
  roomsToCsv,
  siaLabelFull,
} from "../geometry/roomArea";

export {
  type WallSegment,
} from "../geometry/roomBoundary";

export {
  IDEAL_TREAD,
  MIN_STEPS,
} from "../geometry/stair";

export {
  extrudedSolidSpec,
} from "../plan/extrudedSolidSpec";

export {
  type CategoryDisplayResolver,
  type HatchRender,
  type Plan,
  type PlanImage,
  type UnderlayGroup,
  generatePlan,
  generateVisibleLevelsPlan,
  materializeGreyed,
  materializeUnderlay,
} from "../plan/generatePlan";

export {
  drawingPrimitives,
} from "../plan/generatePlan";

export {
  NO_HATCH,
  type Primitive,
} from "../plan/generatePlan/shared";

export {
  GpuChunkCache,
} from "../plan/glPlan/glPlanChunks";

export {
  compilePrimitivesToGpu,
} from "../plan/glPlan/glPlanCompile";

export {
  DASH_MM_TO_M,
  buildRandomHatchRuns,
  motifPoints,
  zigzagPoints,
} from "../plan/glPlan/glPlanHatch";

export {
  type BufferGl,
  type GpuGeometry,
  type ViewBox as ViewBox__plan_glPlan_glPlanTypes,
} from "../plan/glPlan/glPlanTypes";

export {
  levelMarkerPrimitives,
  levelMarksEnabled,
} from "../plan/levelMarkers";

export {
  NativeTextSync,
  isGpuText,
} from "../plan/nativeText";

export {
  type PickKind,
  categoryNameForPick,
} from "../plan/pickLabels";

export {
  DRAWING_PICK_TOLERANCE,
  type PickContextMesh,
  type PickDrawingSeg,
  type PickOpening,
  type PickRoof,
  type PickSlab,
  type PickStair,
  type PickWall,
  type Vec3,
} from "../plan/pickTypes";

export {
  crossKindOverlayAllowed,
  planUnderlayPrimitives,
} from "../plan/generatePlan";

export {
  type Bounds,
  expandRegion,
  indexedInRegion,
  regionContains,
} from "../plan/planView/cullPrimitives";

export {
  HAIRLINE_PX,
  type ModelRect,
  PAD,
  PX_PER_M,
  type ViewBox as ViewBox__plan_planView_geometry,
  clamp,
  fitBoxFor,
  meetScale,
  mmToPx,
  pointInPolygon,
  printStrokeVb,
  scaleFromView,
  toScreen,
  viewForCamera,
  viewForScale,
  visibleEdgeRuns,
} from "../plan/planView/geometry";

export {
  type ClientMap,
  type OwnerField,
  PlanPickIndex,
} from "../plan/planView/planPick";

export {
  planCount,
  planPrimAt,
  planTextEntries,
  planWithExtra,
  type TextEntryPrim,
} from "../plan/planLazy";

export {
  marqueeHitUnderlay,
} from "../plan/planView/underlayAccess";

export {
  type ElevationOptions,
  generateElevationPlan,
} from "../plan/toElevation";

export {
  planSceneBin,
  planToRenderScene,
} from "../plan/toRenderScene";

export {
  type SectionOutput,
  computeSection,
  generateSectionPlan,
  sameSectionInputs,
  sameSectionLine,
  sectionPlaneFromLevel,
  sectionUAxisModel,
} from "../plan/toSection";

export {
  TRUCK_MESH_READY_EVENT,
  draftWorldLines,
  emitDrawingLineVerts,
  pickGeometry,
  projectToModel3d,
  selectionHighlightLines,
  wallMaterialColorMaps,
} from "../plan/toWalls3d";

export * from "./extra";
