/** Regression tests for the fail-closed media offer audit (PA-015 review finding B1). */
import { describe, expect, it } from "vitest";
import { auditOffer } from "../../src/signaling/sdpPolicy";

const AUDIO_OFFER = [
  "v=0",
  "o=- 1 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "a=rtpmap:111 opus/48000/2",
  "",
].join("\r\n");

const DATA_SECTION = "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=sctp-port:5000\r\n";

const withVideo = AUDIO_OFFER + "m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000\r\n";

describe("auditOffer", () => {
  it("accepts exactly one audio m-section", () => {
    expect(auditOffer({ type: "offer", sdp: AUDIO_OFFER })).toBe("audio-only");
    // PeerJS 1.5.5 media connections carry one internal data channel (observed in the real offer).
    expect(auditOffer({ type: "offer", sdp: AUDIO_OFFER + DATA_SECTION })).toBe("audio-only");
    expect(auditOffer({ type: "offer", sdp: AUDIO_OFFER.replace(/\r\n/g, "\n") })).toBe("audio-only");
  });

  it("detects video anywhere in the offer", () => {
    expect(auditOffer({ type: "offer", sdp: withVideo })).toBe("video");
    const videoFirst = AUDIO_OFFER.replace("m=audio", "m=video 9 UDP/TLS/RTP/SAVPF 96\r\nm=audio");
    expect(auditOffer({ type: "offer", sdp: videoFirst })).toBe("video");
  });

  it.each([
    ["undefined (internal field missing)", undefined],
    ["null", null],
    ["string instead of object", AUDIO_OFFER],
    ["missing sdp", { type: "offer" }],
    ["empty sdp", { type: "offer", sdp: "" }],
    ["non-string sdp", { type: "offer", sdp: 42 }],
  ])("reports unreadable offers: %s", (_label, input) => {
    expect(auditOffer(input)).toBe("unreadable");
  });

  it.each([
    ["wrong type", { type: "answer", sdp: AUDIO_OFFER }],
    ["no m-section", { type: "offer", sdp: "v=0\r\ns=-\r\n" }],
    ["two audio m-sections", { type: "offer", sdp: AUDIO_OFFER + "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" }],
    ["two data channel m-sections", { type: "offer", sdp: AUDIO_OFFER + DATA_SECTION + DATA_SECTION }],
    ["data channel without audio", { type: "offer", sdp: "v=0\r\ns=-\r\n" + DATA_SECTION }],
    ["non-datachannel application section", { type: "offer", sdp: AUDIO_OFFER + "m=application 9 UDP/BFCP *\r\n" }],
    ["unknown m-section", { type: "offer", sdp: AUDIO_OFFER.replace("m=audio", "m=text") }],
    ["garbage", { type: "offer", sdp: "<html>not sdp</html>" }],
    ["oversized", { type: "offer", sdp: AUDIO_OFFER + "a=x\r\n".repeat(20_000) }],
  ])("reports invalid offers: %s", (_label, input) => {
    expect(auditOffer(input)).toBe("invalid");
  });
});
