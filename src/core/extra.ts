// Von Hand gepflegter Teil der Fassade: Kern-Einstiege, die nicht (nur) die Hülle braucht — Datei-
// Format, Exporte, WASM-Quelle. Genutzt von `dossier-cli` (src/cli), das NUR `src/core` importiert.

export { parseProjectFile, serializeProject, PROJECT_FORMAT_VERSION } from "../io/projectFormat";
export { exportIfcSpf } from "../export/exportIfc";
export { buildPlanDxf } from "../export/exportDxf";
export { buildPlanDwg } from "../export/exportDxf";
export { buildPlanDxfBinary } from "../export/exportDxf";
export { loadFileio } from "../engine/fileioWasm";
export { readIfcFlat } from "../io/ifcImport";
export { parseBcf, writeBcf, bcfInfo } from "../io/bcf";
export { projectGeoOrigin } from "../model/geoRebase";
export { ensureContextCategories } from "../model/contextCategories";
export { projectToWorldCoords } from "../model/geoRebase";
export { exportScheduleCsv } from "../export/exportSchedule";
export { exportObj, exportMtl, exportStl, exportGlb, exportGltf } from "../export/exportMesh";
export { exportProjectStep } from "../export/exportStep";
// [271][272] Ansicht eines Exports/Renderings (Umbaufilter, Etappe, Variantenkombination der aktiven Ebene).
export { levelExportView, hasExportView, exportViewText, exportViewFields, exportViewLabels } from "../export/exportView";
export type { ExportView } from "../export/exportView";
export { planToSvgString } from "../export/planToSvgString";
export { setWasmBytesProvider } from "../engine/wasmSource";
export { initCore } from "../engine/coreWasm";
export { applyOps, validateProject, validateOps } from "./ops";
export { projectWarnings } from "./ops";
export type { CoreOp } from "./ops";
export type { Project, DrawingLevel, ViewTemplate } from "../model/types";
export { computeKennzahlen, checkRoomProgram, solidVolume } from "../analysis/kennzahlen";
export type { Kennzahlen, ProgramCheck } from "../analysis/kennzahlen";
export { compareRoomProgram, layoutRoomProgram, DEFAULT_PROGRAM_TOLERANCE } from "../analysis/roomProgram";
export { buildProgramSheet, addProgramSheet, addProgramSheetOps, groupColor, defaultSheetLabels } from "../analysis/roomProgramSheet";
export type { ProgramSheet, SheetLabels } from "../analysis/roomProgramSheet";
export type { RoomProgramCompare, RoomProgramLayout, CompareRow, CompareSum, Light, LayoutItem, LayoutGroup } from "../analysis/roomProgram";
export { readSheetFile, suggestMapping, mapRows, importedRows, applyRoomProgram, roomProgramOps, cellNumber, cellText, detectHeaderRow, parseKind, PROGRAM_FIELDS } from "../io/roomProgramImport";
export type { SheetData, SheetCell, Mapping, ColumnMap, ProgramField, ImportLine, ImportMode, SkipReason } from "../io/roomProgramImport";
export { buildProgramReport } from "../export/programReport";
export { openingSchedule, buildOpeningReport, roomsText, externalText, swingText } from "../export/openingSchedule";
export type { OpeningScheduleRow } from "../export/openingSchedule";
export { revealColumns, revealArea } from "../export/openingSchedule";
export type { RevealArea } from "../export/openingSchedule";
export { elementSchedule, uValueOf, uValueText, buildElementReport } from "../export/elementSchedule";
export type { ElementScheduleRow, UValueResult, ElementKind } from "../export/elementSchedule";
export { roomBook, buildRoomBookReport, usageLabel, hasSlope, ROOM_USAGES } from "../export/roomBook";
export type { RoomBook, RoomBookRow, FinishQty, WallSide } from "../export/roomBook";
export { sheetTables, createTable, drawTablesPdf, tableCatalog, tableLabels, tableSourceLabel, TABLE_SOURCES } from "../export/sheetTable";
export type { TableOut, TablePrim, TableColumn } from "../export/sheetTable";
export { computeAreaTable, computeIvhb } from "../analysis/areaTable";
export { computeUnitSchedule, unitScheduleCsv, nextUnitName, newUnitId, UNIT_USAGES } from "../analysis/unitSchedule";
export type { UnitSchedule, UnitRow, UnitTypeSum, UnitLevelSum, UnitAreas } from "../analysis/unitSchedule";
export type { AreaTable, AreaRow, Ivhb, IvhbOptions, AgfBasis } from "../analysis/areaTable";
export { computeSiteProof } from "../analysis/siteProof";
export type { SiteProof, ProofRow, ProofBasis } from "../analysis/siteProof";
export { exportProjectName, competitionIdentity, isAnonymous, competitionKeyword, identityLeaks, NEUTRAL_DATE, NEUTRAL_ISO } from "../export/competitionIdentity";
export type { CompetitionIdentity } from "../export/competitionIdentity";
export { anonymityFindings } from "../export/competitionCheck";
export type { AnonymityFinding, AnonymityKind } from "../export/competitionCheck";
export { isAreaReportEmpty, hasUnits, buildAreaReport, areaReportToCsv, parseAreaReportCsv, areaReportToSvg, buildAreaReportPdf } from "../export/areaReport";
export { setPdfFontLoader } from "../export/pdfFonts";
export type { AreaReport, AreaReportOptions } from "../export/areaReport";
export { sunPosition, shadowPolygons, shadowOfPrism, projectLatLon } from "../analysis/sun";
export type { SunPosition } from "../analysis/sun";
export { checkSiteRules, allowedArea, multiPolygonArea, buildingFootprint, modelTop } from "../analysis/siteRules";
export { siteEnvelope3d } from "../analysis/siteRules";
export { excavationQuantities, type ExcavationQuantity } from "../analysis/excavation";
export type { SiteCheck } from "../analysis/siteRules";
export { sampleProject } from "../model/sampleProject";
export { parseDxf } from "../io/dxfParser";
export { ProjectDocument, sharedDocument } from "./document";
export { withDocument } from "./document";
export { emptyProject } from "../model/sampleProject";
export { buildComplexSampleProject } from "../model/sampleProjectComplex";
export { buildWettbewerbSampleProject } from "../model/sampleProjectWettbewerb";
export { buildBigSampleProject } from "../model/sampleProjectBig";
export { buildContextCadastreDxf, buildContextContoursDxf, buildContextBuildingsObj } from "../model/sampleContext";
export { readPointCloud, readPointCloudFlat, isPointCloudFile, DEFAULT_MAX_POINTS } from "../io/pointCloud";
export type { PointCloudData, PointCloudOptions, PointCloudReport } from "../io/pointCloud";
export { readPdfVector, pdfImport, pdfPageInfo, isPdfFile, PDF_SCALES } from "../io/pdfVector";
export type { PdfVectorPage, PdfVectorPath, PdfVectorText } from "../io/pdfVector";
export { readMesh, readMeshFlat, formatMeshReport, isMeshFile, MESH_UNITS, MESH_UNIT_SCALE } from "../io/meshImport";
export type { MeshImportReport, MeshUnit, MeshUp, MeshPlacement } from "../io/meshImport";
export { addedItems } from "./opsBuild";
export { addItems, fieldOps, findItem, itemsOf, opsMutation, patchItem, patchItems, removeItems, replaceItem, replaceWithMany, setField, setFieldIfChanged } from "./opsBuild";
export { cmdMutation } from "./document";
export type { EntityCollection, EntityOf, ProjectMutation } from "./opsBuild";
export { EMPTY_MEMBERSHIP, containingGroupId, expandToGroups, isInsideActiveGroup, transitiveMembership } from "../model/groups";
export type { GroupMembership, MemberKind } from "../model/groups";
export { arcApex, drawingVertices, gripPt, openEdges, polylineEdgeGrips, ringEdges } from "../geometry/grips";
export { verticalExtents } from "../geometry/grips";
export { cameraGripPoints, beamGripPoints } from "../geometry/grips";
export type { VerticalExtent } from "../geometry/grips";
export type { GripRequest, RingKind } from "../geometry/grips";
export { edgeArcToggle, type ArcRingKind } from "../geometry/grips";
export { clampInside, coincidentGripPoints, excavationGripPoints, gripArcWallRadius, gripArcWallResize, gripArcWallTarget, gripAxisLock, gripEdgeTarget, gripPolar, gripPolarPoint, openingGripPoint, openingSheetSlide, openingTypedPosition, contourMarks, sheetHeightDrag, snapSheetHeight, stairMoveHandle, stairParamPoints, wallGripPoints } from "../geometry/gripDrag";
export type { EdgeDrive, GripLocks, SheetHeightKind } from "../geometry/gripDrag";
export { openingPreviewProject, openingPreviewSvgs } from "../plan/openingPreview";
export type { OpeningPreviewSvgs } from "../plan/openingPreview";
export { surfaceOpeningInfo, surfaceOpeningGrips, surfaceOpeningGripPatch } from "../plan/surfaceOpening";
export type { SurfaceOpeningInfo } from "../plan/surfaceOpening";
export { AI_TOOLS, AI_BRIDGE_DEFAULT_PORT, aiText, aiToolDef, hmacHex, randomHex, sameMac } from "./aiToolDefs";
export type { AiToolDef, AiToolResult, AiBridgeMsg } from "./aiToolDefs";
export { callAiTool } from "./aiTools";
export type { AiHost } from "./aiTools";
export { PRESENTATION_SCALES, POSTER_EXTRAS_DEFAULT, posterExtrasDefault, POSTER_SITUATION_SCALE, PRESENTATION_DEFAULT_SCALE, levelHasContent, PRESENTATION_TEMPLATE_ID, presentationDefaults, presentationSheetOps, planPresentationSheet, fittingPresentationScale, finerPresentationScale } from "../plan/presentationSheet";
export type { PresentationOptions, PosterExtras, PosterTableKind, PresentationPlan, PresentationLabels } from "../plan/presentationSheet";
export { buildLayoutSvg, presentationSheetLabels } from "../export/layoutSvg";
export { lineEndsOf, lineEndsCode, lineEndsFromCode, lineEndsSvgAttrs, planLineEndsProps, MITER_LIMIT as LINE_MITER_LIMIT } from "../model/lineEnds";
export type { LineEnds } from "../model/lineEnds";
export type { LineCap, LineJoin } from "../model/types";
export { standardOverrideRules } from "../model/standards";
export { standardModelViews } from "../model/standards";
export { recognizeMutation, recognizeReport, recognizeSourceLevels } from "../io/recognizeDrawing";
export type { RecognizeOptions, RecognizeReport, RecognizeUnclear } from "../io/recognizeDrawing";
export { meshGripIndices, growRect, nearestMeshVertex, meshTolerance } from "../geometry/meshPick";
export type { MeshRect } from "../geometry/meshPick";
// [211] Rendering mit Blender/Cycles: Export-Paket, Prozess-Ablauf (Gastgeber: Tauri/Electron/Node)
export {
  buildRenderPackage, runBlenderRender, runBlenderSave, runBlenderOpen, blendOpenArgs, BLEND_FILE, parseBlenderLine, blenderArgs, glbMaterials, renderSun, defaultRenderTime, paperPixels,
  projectRenderCameras, findRenderCamera,
  BlenderMissingError, RenderCancelled, RENDER_SIZE_PRESETS, RENDER_QUALITY_PRESETS, RENDER_VIEW_PRESETS, BLENDER_CANDIDATES, BLENDER_DOWNLOAD_URL,
} from "../export/blenderRender";
export type { BlenderHost, RenderPackage, RenderOptions, RenderScene, RenderCamera, RenderCameraSpec, RenderViewPreset, RenderMaterial, RenderRole, RenderCameraChoice, TextureLoader, BlenderEvent, RenderResult, RenderRunOptions, RenderMode, BlendResult } from "../export/blenderRender";
// [215] Rendering mit dem mitgelieferten Cycles: Szene aus dem Kern (cyclesScene), Prozess-Ablauf, EXR/PNG
export { buildCyclesPackage, cyclesSceneInfo, runCyclesRender, parseCyclesLine, cyclesArgs, readExr, encodePng, exrToPng, CyclesMissingError, CyclesCancelled } from "../export/cyclesRender";
export type { CyclesHost, CyclesPackage, CyclesSceneInfo, CyclesSceneOptions, CyclesRunOptions, CyclesResult, CyclesEvent, Codec, ExrImage } from "../export/cyclesRender";
// [209] Kostenschätzung grob (Kern kosten.rs): Rechnung, Beispielwerte, Bericht (CSV/PDF wie der Flächen-Nachweis)
export { computeCostEstimate, defaultCostEstimate, formatChf } from "../analysis/costEstimate";
export type { CostResult, CostRow, CostQuantities, CostEstimate, CostGroup, CostMethod, CostBasis } from "../analysis/costEstimate";
export { buildCostReport, costGroupLabel, costUnitLabel } from "../export/costReport";
// [271] Umbau: Status je Bauteil, Etappen, Umbaufilter (Regeln im Kern `renovation.rs`)
export {
  BUILTIN_RENOVATION_FILTERS, RENOVATION_STATUSES, RENOVATION_COLLECTIONS, renovationFilterList, renovationStatus, renovationPhases,
  renovationForNew, setRenovationOps, renovatableIds, commonRenovation, setPhasesOps, newPhaseId,
  renovationFilterShows, renovationStyleOf, idsByRenovationStatus, renovationCounts, phaseUsage,
  resolvedRenovationStyles, patchRenovationStyles, setRenovationStylesOps, setPhaseStylesOps,
} from "../model/renovation";
export type { RenovationFilterEntry, RenovationCollection } from "../model/renovation";
export type { RenovationStyleView, RenovationStyleSet, ResolvedRenovationStyles } from "../model/renovation";
// [274] Sanierung je Schicht: Typ-Paar Bestand → Sanierungstyp
export {
  wallBuildUp, buildUpKey, parseBuildUpKey, setBuildUpOps, commonBuildUp, renovateAllOfTypeOps, createRenovationTypeOps, setTypePairOps,
  renovationPair, renovationPairs,
  renovationTypes, hostTypeId, RENOVATION_HOSTS,
} from "../model/renovation";
export type { RenovationBuildUp, RenovationPair, RenovationPairLayer, RenovationStripPiece, RenovationPairsInfo } from "../model/renovation";
export type { RenovationHost, LayeredType } from "../model/renovation";
export { buildUmbauSampleProject } from "../model/sampleProjectUmbau";
// [272] Varianten: Sätze, Kombinationen, Zuweisen/Kopieren/Übernehmen (Regeln im Kern `design_options.rs`, Sichtbarkeit `renovation.rs`)
export {
  DESIGN_OPTION_COLLECTIONS, designOptionSets, primaryOption, resolveCombination, levelCombination, combinationLabel, combinationSuffix, combinationSpec,
  parseCombination, showsInCombination, designOptionLabel, designOptionSelection, designOptionIds, commonDesignOption, parseTarget, designOptionTargets,
  assignDesignOptionOps, copyToDesignOptionOps, acceptDesignOptionOps, deleteDesignOptionOps, nextOptionName, addDesignOptionSetOps, addDesignOptionOps,
  renameDesignOptionSetOps, renameDesignOptionOps, setPrimaryOptionOps, setLevelCombinationOps, compareDesignOptions, compareDesignOptionsCsv, projectWithCombination,
  designOptionCombinations, combinationChoice, storedChoice, levelCombinationState, combinationNameFor, assignCombinationOps, viewportCombinationPatch, nextCombinationName, addCombinationOps,
  renameCombinationOps, setCombinationChoiceOps, deleteCombinationOps,
} from "../model/designOptions";
export type { Combination, CombinationState, DesignOptionCompareRow, DesignOptionCollection } from "../model/designOptions";
// [272] Nachtrag: Auge/Stift, grau einfärben und sperren wie im Archicad-Manager
export { DESIGN_OPTION_GHOST_FILL, DESIGN_OPTION_GHOST_LINE, designOptionEditArg, visibleOption, eyeClick, penClick, designOptionLocked, unlockedSelection } from "../model/designOptions";
export type { DesignOptionEditArg, DesignOptionTarget } from "../model/designOptions";
export { buildVariantenSampleProject } from "../model/sampleProjectVarianten";
