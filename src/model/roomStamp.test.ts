import { describe, it, expect } from "vitest";
import {
  defaultRoomStamp,
  roomStampToDoc,
  roomStampExtraLines,
  roomDisplayName,
} from "./roomStamp";
import type { Room } from "./types";

function makeRoom(over: Partial<Room> = {}): Room {
  return {
    id: "r1",
    type: "room",
    floorId: "f1",
    categoryCode: "45",
    siaCategory: "HNF",
    name: "Wohnen",
    boundary: [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 3 },
      { x: 0, y: 3 },
    ],
    color: "#123456",
    ...over,
  };
}

describe("defaultRoomStamp", () => {
  it("leitet Name/Flags aus dem Raum ab", () => {
    const stamp = defaultRoomStamp(makeRoom());
    expect(stamp.name).toBe("Wohnen");
    expect(stamp.showFloorArea).toBe(true);
    expect(stamp.showUsage).toBe(true);
    expect(stamp.number).toBeUndefined();
  });
});

describe("roomStampToDoc", () => {
  it("eine Zeile ohne nameLine2", () => {
    const doc = roomStampToDoc({ name: "Bad", showFloorArea: true, showUsage: true });
    expect(doc.paragraphs).toHaveLength(1);
  });

  it("zwei Zeilen mit nameLine2", () => {
    const doc = roomStampToDoc({
      name: "Bad",
      nameLine2: "WC",
      showFloorArea: true,
      showUsage: true,
    });
    expect(doc.paragraphs).toHaveLength(2);
  });

  it("Nummer als Präfix-Run in Zeile 1", () => {
    const doc = roomStampToDoc({
      number: "1.01",
      name: "Bad",
      showFloorArea: true,
      showUsage: true,
    });
    expect(doc.paragraphs[0].runs).toHaveLength(2);
    expect(doc.paragraphs[0].runs[0].text).toBe("1.01 ");
    expect(doc.paragraphs[0].runs[1].text).toBe("Bad");
  });
});

describe("roomStampExtraLines", () => {
  it("beachtet Flags und Präfix", () => {
    const lines = roomStampExtraLines(
      { name: "Bad", showFloorArea: true, showUsage: true, floorAreaPrefix: "BF " },
      { netArea: 12.345, siaCategory: "HNF", siaLabel: "Hauptnutzfläche" },
    );
    expect(lines[0].text).toBe("BF 12.35 m²");
    expect(lines[1].text).toBe("HNF · Hauptnutzfläche");
  });

  it("blendet Zeilen aus, wenn Flags falsch", () => {
    const lines = roomStampExtraLines(
      { name: "Bad", showFloorArea: false, showUsage: false },
      { netArea: 12.345, siaCategory: "HNF", siaLabel: "Hauptnutzfläche" },
    );
    expect(lines).toHaveLength(0);
  });
});

describe("roomDisplayName", () => {
  it("faellt auf room.name zurück ohne Stempel", () => {
    expect(roomDisplayName(makeRoom())).toBe("Wohnen");
  });

  it("zieht name + nameLine2 zusammen", () => {
    const room = makeRoom({
      stamp: { name: "Bad", nameLine2: "WC", showFloorArea: true, showUsage: true },
    });
    expect(roomDisplayName(room)).toBe("Bad WC");
  });

  it("nutzt nur name ohne nameLine2", () => {
    const room = makeRoom({
      stamp: { name: "Küche", showFloorArea: true, showUsage: true },
    });
    expect(roomDisplayName(room)).toBe("Küche");
  });
});
