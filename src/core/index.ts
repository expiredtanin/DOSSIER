// Fassade des Kerns für die Hülle (Phase A der Kern/UI-Trennung, docs/core-ui-split.md).
// Dünne Durchreichung, Namen 1:1; die Hülle importiert Plan-/Geometrie-Funktionen nur noch von hier.
// Erzeugt mit scripts/core-facade.py — neue Einträge von Hand ergänzen.

export {
  arcFromStartEndDirection,
  arcFromStartEndRadius,
  arcThroughPoints,
  bulgeArc,
  bulgeArcPoints,
  bulgeBetweenAngles,
  bulgeFromSagittaPoint,
  bulgePointAt,
  bulgeThroughPoint,
  hasRealBulge,
  pointOnCircle,
} from "../geometry/bulge";

export {
  ceilingArea,
  normalizeOutline,
  outlineBBox,
  pointInOutline,
} from "../geometry/ceiling";

export {
  columnFootprint,
} from "../geometry/column";

export {
  ellipsePts,
  sampleBezierChain,
  sampleCatmullRom,
  sampleUniformBSpline,
} from "../geometry/curves";

export {
  type DrawingIndex,
  buildDrawingIndex,
  drawingsNear,
  drawingsWithinDistance,
  isIndexable,
  nearestInDrawings,
  pointSegDist as pointSegDist__geometry_drawingIndex,
} from "../geometry/drawingIndex";

export {
  mvGeom,
  reversesOrientation,
  scaleFactor,
  scaleGeom,
} from "../geometry/geomTransform";

export {
  type Chamfer,
  type Fillet,
  type TangentTarget,
  breakCurve,
  chamferCorner,
  extendBulgeSegment,
  extendSegment,
  filletCorner,
  joinChainsWithBulge,
  nearestOnPolyline,
  offsetPolyline,
  offsetPolylineWithBulge,
  offsetSegment,
  pointSegmentDistance,
  polylineEdges,
  removeSegment,
  removeSegmentWithBulge,
  splitAtIntersections,
  splitClosedByChord,
  splitPolylineAtParam,
  tangentCircleCenters,
  trimPolylineWithBulge,
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

export {
  openingGapQuad,
  openingVerticalExtent,
} from "../geometry/opening";

export {
  nearestPolylineTarget,
  toleranceFor,
} from "../geometry/polylinePoint";

export {
  type PolylineVertexType,
  canSetVertexType,
  vertexTypeOf,
  withVertexType,
} from "../geometry/polylineVertexType";

export {
  revisionCloudPts,
} from "../geometry/revisionCloud";

export {
  roofBBox,
  roofBaseElevation,
  roofGeometry,
} from "../geometry/roof";

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
  roomFromPointInside,
} from "../geometry/roomBoundary";

export {
  IDEAL_TREAD,
  MIN_STEPS,
  defaultStepCount,
  stairBBox,
  stairGeometry,
  stairOutline,
} from "../geometry/stair";

export {
  extrudedSolidSpec,
  transformSolid,
} from "../plan/extrudedSolidSpec";

export {
  type CategoryDisplayResolver,
  type HatchRender,
  type Plan,
  type PlanImage,
  type UnderlayGroup,
  generatePlan,
  generateSectionPlan,
  generateVisibleLevelsPlan,
  materializeGreyed,
  materializeUnderlay,
} from "../plan/generatePlan";

export {
  addDrawing2D,
} from "../plan/generatePlan/drawing2d";

export {
  END_MARK_DEFAULT_SIZE_MM,
} from "../plan/generatePlan/endMarks";

export {
  NO_HATCH,
  type Primitive,
  resolveBackground,
  resolveForeground,
  resolveHatchId,
  resolveStrokeWeight,
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
} from "../plan/planUnderlay";

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
  marqueeHit,
  marqueeHitCeilings,
  marqueeHitDrawings,
  marqueeHitRooms,
  marqueeHitStairs,
  meetScale,
  mmToPx,
  pointInPolygon,
  pointSegDistPx,
  printStrokeVb,
  scaleFromView,
  toScreen,
  viewForCamera,
  viewForScale,
  visibleEdgeRuns,
} from "../plan/planView/geometry";

export {
  type OwnerField,
  type OwnerIndex,
  buildOwnerIndex,
  ownedBy,
} from "../plan/planView/ownerIndex";

export {
  buildSegmentIndex,
  nearestSegment,
  pointSegDist as pointSegDist__plan_planView_segmentIndex,
  segmentsNear,
} from "../plan/planView/segmentIndex";

export {
  marqueeHitUnderlay,
} from "../plan/planView/underlayAccess";

export {
  sectionOpeningPrimitives,
} from "../plan/sectionOpenings";

export {
  generateElevationPlan,
} from "../plan/toElevation";

export {
  planToRenderScene,
} from "../plan/toRenderScene";

export {
  type SectionOutput,
  computeSection,
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
