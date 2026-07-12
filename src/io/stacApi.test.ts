// Tests für die reinen (netzwerkfreien) Bausteine der gemeinsamen STAC-API-
// Anbindung: Asset-Auswahl (Prioritäts-/Tile-Filter). Die Netzwerk-Funktionen
// (`stacQuery`/`downloadAssetText`) bleiben ungetestet, analog zu
// `swissTopo.ts::fetchBuildings`/`geocode` (kein Fetch-Mocking im Repo).

import { describe, it, expect } from "vitest";
import { pickAsset } from "./stacApi";
import type { StacItem } from "./stacApi";

const DXF_PRIORITY = [".dxf", ".dwg", ".obj", ".ifc", ".dxf.zip", ".dwg.zip", ".obj.zip", ".ifc.zip"];

describe("pickAsset", () => {
  it("bevorzugt die erste Endung der Prioritätsliste (z. B. DXF vor OBJ/IFC/ZIP)", () => {
    const item: StacItem = {
      id: "t_1150-23",
      assets: [
        { href: "https://x/t_1150-23_.ifc" },
        { href: "https://x/t_1150-23_.obj" },
        { href: "https://x/t_1150-23_.dxf" },
        { href: "https://x/t_1150-23_.dxf.zip" },
      ],
    };
    expect(pickAsset(item, DXF_PRIORITY)?.href).toBe("https://x/t_1150-23_.dxf");
  });

  it("fällt auf ZIP zurück, wenn keine rohe Datei vorhanden ist", () => {
    const item: StacItem = {
      id: "t_1150-23",
      assets: [
        { href: "https://x/t_1150-23_.ifc.zip" },
        { href: "https://x/t_1150-23_.dxf.zip" },
      ],
    };
    expect(pickAsset(item, DXF_PRIORITY)?.href).toBe("https://x/t_1150-23_.dxf.zip");
  });

  it("filtert auf Per-Tile-Assets (Tile-Coord-Marker im Dateinamen)", () => {
    const item: StacItem = {
      id: "t",
      assets: [
        { href: "https://x/gesamte_schweiz.dxf" }, // kein Tile-Marker -> Fallback-Kandidat
        { href: "https://x/t_1150-23_.dxf" },
      ],
    };
    expect(pickAsset(item, DXF_PRIORITY)?.href).toBe("https://x/t_1150-23_.dxf");
  });

  it("liefert null bei leerer Asset-Liste", () => {
    expect(pickAsset({ id: "t", assets: [] }, DXF_PRIORITY)).toBeNull();
  });

  it("respektiert eine andere Prioritätsliste (z. B. XYZ vor TIF)", () => {
    const item: StacItem = {
      id: "t_1150-23",
      assets: [
        { href: "https://x/t_1150-23_0.5_2056.tif" },
        { href: "https://x/t_1150-23_0.5_2056.xyz.zip" },
      ],
    };
    expect(pickAsset(item, [".xyz", ".xyz.zip", ".tif"])?.href).toBe(
      "https://x/t_1150-23_0.5_2056.xyz.zip",
    );
  });
});
