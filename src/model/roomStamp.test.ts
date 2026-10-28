import { describe, it, expect } from "vitest";
import { defaultRoomStamp, roomDisplayName } from "./roomStamp";
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
