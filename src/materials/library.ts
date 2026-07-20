// Auto-generated built-in material library (ambientCG, CC0 1.0).
// Static asset paths under /public; loadable directly via three.js TextureLoader.
// Source data mirrors public/assets/materials/manifest.json.

export type MaterialMapKind =
  | 'color'
  | 'normal'
  | 'roughness'
  | 'metalness'
  | 'displacement'
  | 'ao';

export interface MaterialAsset {
  /** ambientCG asset id, e.g. 'Concrete048'. */
  id: string;
  /** Localized display name (German). */
  name: string;
  /** ambientCG category key, e.g. 'Concrete'. */
  category: string;
  /** Absolute public paths to the available texture maps. */
  maps: Partial<Record<MaterialMapKind, string>>;
}

export const MATERIAL_LIBRARY_SOURCE = "ambientCG (ambientcg.com)";
export const MATERIAL_LIBRARY_LICENSE = "CC0 1.0 Universal (Public Domain)";
export const MATERIAL_LIBRARY_RESOLUTION = "1K";

export const MATERIAL_LIBRARY: MaterialAsset[] = [
  {
    id: "Concrete048",
    name: "Beton",
    category: "Concrete",
    maps: {
      color: "/assets/materials/Concrete048/color.jpg",
      normal: "/assets/materials/Concrete048/normal.jpg",
      roughness: "/assets/materials/Concrete048/roughness.jpg",
      displacement: "/assets/materials/Concrete048/displacement.jpg",
      ao: "/assets/materials/Concrete048/ao.jpg",
    },
  },
  {
    id: "Plaster001",
    name: "Putz/Stuck",
    category: "Plaster",
    maps: {
      color: "/assets/materials/Plaster001/color.jpg",
      normal: "/assets/materials/Plaster001/normal.jpg",
      roughness: "/assets/materials/Plaster001/roughness.jpg",
      displacement: "/assets/materials/Plaster001/displacement.jpg",
    },
  },
  {
    id: "Wood095",
    name: "Holz-Diele",
    category: "Wood",
    maps: {
      color: "/assets/materials/Wood095/color.jpg",
      normal: "/assets/materials/Wood095/normal.jpg",
      roughness: "/assets/materials/Wood095/roughness.jpg",
      displacement: "/assets/materials/Wood095/displacement.jpg",
    },
  },
  {
    id: "WoodFloor051",
    name: "Holz-Parkett",
    category: "WoodFloor",
    maps: {
      color: "/assets/materials/WoodFloor051/color.jpg",
      normal: "/assets/materials/WoodFloor051/normal.jpg",
      roughness: "/assets/materials/WoodFloor051/roughness.jpg",
      displacement: "/assets/materials/WoodFloor051/displacement.jpg",
      ao: "/assets/materials/WoodFloor051/ao.jpg",
    },
  },
  {
    id: "Bricks104",
    name: "Backstein",
    category: "Bricks",
    maps: {
      color: "/assets/materials/Bricks104/color.jpg",
      normal: "/assets/materials/Bricks104/normal.jpg",
      roughness: "/assets/materials/Bricks104/roughness.jpg",
      displacement: "/assets/materials/Bricks104/displacement.jpg",
      ao: "/assets/materials/Bricks104/ao.jpg",
    },
  },
  {
    id: "RoofingTiles013A",
    name: "Dachziegel",
    category: "Roofing Tiles",
    maps: {
      color: "/assets/materials/RoofingTiles013A/color.jpg",
      normal: "/assets/materials/RoofingTiles013A/normal.jpg",
      roughness: "/assets/materials/RoofingTiles013A/roughness.jpg",
      displacement: "/assets/materials/RoofingTiles013A/displacement.jpg",
      ao: "/assets/materials/RoofingTiles013A/ao.jpg",
    },
  },
  {
    id: "Tiles141",
    name: "Bodenfliesen",
    category: "Tiles",
    maps: {
      color: "/assets/materials/Tiles141/color.jpg",
      normal: "/assets/materials/Tiles141/normal.jpg",
      roughness: "/assets/materials/Tiles141/roughness.jpg",
      displacement: "/assets/materials/Tiles141/displacement.jpg",
    },
  },
  {
    id: "Marble012",
    name: "Naturstein/Marmor",
    category: "Marble",
    maps: {
      color: "/assets/materials/Marble012/color.jpg",
      normal: "/assets/materials/Marble012/normal.jpg",
      roughness: "/assets/materials/Marble012/roughness.jpg",
      displacement: "/assets/materials/Marble012/displacement.jpg",
    },
  },
  {
    id: "PavingStones150",
    name: "Pflasterstein",
    category: "PavingStones",
    maps: {
      color: "/assets/materials/PavingStones150/color.jpg",
      normal: "/assets/materials/PavingStones150/normal.jpg",
      roughness: "/assets/materials/PavingStones150/roughness.jpg",
      displacement: "/assets/materials/PavingStones150/displacement.jpg",
      ao: "/assets/materials/PavingStones150/ao.jpg",
    },
  },
  {
    id: "Metal063",
    name: "Metall",
    category: "Metal",
    maps: {
      color: "/assets/materials/Metal063/color.jpg",
      normal: "/assets/materials/Metal063/normal.jpg",
      roughness: "/assets/materials/Metal063/roughness.jpg",
      metalness: "/assets/materials/Metal063/metalness.jpg",
      displacement: "/assets/materials/Metal063/displacement.jpg",
    },
  },
  {
    id: "Gravel043",
    name: "Kies/Schotter",
    category: "Gravel",
    maps: {
      color: "/assets/materials/Gravel043/color.jpg",
      normal: "/assets/materials/Gravel043/normal.jpg",
      roughness: "/assets/materials/Gravel043/roughness.jpg",
      displacement: "/assets/materials/Gravel043/displacement.jpg",
      ao: "/assets/materials/Gravel043/ao.jpg",
    },
  },
  {
    id: "Grass005",
    name: "Gras",
    category: "Grass",
    maps: {
      color: "/assets/materials/Grass005/color.jpg",
      normal: "/assets/materials/Grass005/normal.jpg",
      roughness: "/assets/materials/Grass005/roughness.jpg",
      displacement: "/assets/materials/Grass005/displacement.jpg",
      ao: "/assets/materials/Grass005/ao.jpg",
    },
  },
  {
    id: "Ground103",
    name: "Boden",
    category: "Ground",
    maps: {
      color: "/assets/materials/Ground103/color.jpg",
      normal: "/assets/materials/Ground103/normal.jpg",
      roughness: "/assets/materials/Ground103/roughness.jpg",
      displacement: "/assets/materials/Ground103/displacement.jpg",
      ao: "/assets/materials/Ground103/ao.jpg",
    },
  },
];

export default MATERIAL_LIBRARY;
