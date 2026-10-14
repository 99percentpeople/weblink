import { describe, expect, it } from "vitest";
import { parseRoomInvitation } from "@/libs/application/room-invitation";

describe("room invitation parameters", () => {
  it("leaves the configured room alone without an invitation", () => {
    expect(parseRoomInvitation({})).toBeNull();
  });

  it("preserves the decoded room and password", () => {
    expect(
      parseRoomInvitation({
        id: "room & 中文",
        pwd: "password+#?",
      }),
    ).toEqual({
      roomId: "room & 中文",
      password: "password+#?",
    });
  });

  it("clears the previous password when the invitation has none", () => {
    expect(
      parseRoomInvitation({ id: "public-room" }),
    ).toEqual({
      roomId: "public-room",
      password: null,
    });
  });

  it("keeps the room when a legacy link only changes its password", () => {
    expect(
      parseRoomInvitation({ pwd: "updated-password" }),
    ).toEqual({
      password: "updated-password",
    });
  });

  it("opens empty invitations for editing instead of treating them as automatic joins", () => {
    expect(
      parseRoomInvitation({ id: "", pwd: "" }),
    ).toEqual({
      roomId: "",
      password: null,
    });
  });

  it("uses the first value of repeated parameters", () => {
    expect(
      parseRoomInvitation({
        id: ["first", "second"],
        pwd: ["first-password", "second-password"],
      }),
    ).toEqual({
      roomId: "first",
      password: "first-password",
    });
  });
});
