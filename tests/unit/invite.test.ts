/** FR-018 invite links. */
import { describe, expect, it } from "vitest";
import { buildInviteUrl, parseInviteHash } from "../../src/core/invite";

const UID = "psst-abcd-efgh-jkmn";
const LOC = { origin: "https://example.test", pathname: "/psstamigo/" };

describe("invite links", () => {
  it("puts the UID in the fragment (never sent to the server)", () => {
    const url = buildInviteUrl(UID, LOC);
    expect(url).toBe("https://example.test/psstamigo/#join=psst-abcd-efgh-jkmn");
    expect(new URL(url).search).toBe("");
    expect(parseInviteHash(new URL(url).hash)).toBe(UID);
  });

  it("normalizes and validates", () => {
    expect(parseInviteHash("#join=PSST-ABCD-EFGH-JKMN")).toBe(UID);
    expect(parseInviteHash("#join=psst-abcd")).toBeNull();
    expect(parseInviteHash("#join=<script>")).toBeNull();
    expect(parseInviteHash("#other=psst-abcd-efgh-jkmn")).toBeNull();
    expect(parseInviteHash("join=psst-abcd-efgh-jkmn")).toBeNull();
    expect(parseInviteHash("")).toBeNull();
    expect(parseInviteHash("#join=" + "a".repeat(500))).toBeNull();
  });
});
