/** Basic connection diagnostics (FR-017, spike level). Read-only, local only. */
import type { SessionSnapshot } from "../session/SessionController";
import type { SignalingState } from "../signaling/types";

type Row = readonly [string, string];

export async function collectDiagnostics(
  signaling: SignalingState,
  session: SessionSnapshot,
  getPc: (peerId: string) => RTCPeerConnection | null,
): Promise<Row[]> {
  const rows: Row[] = [["Sinyal", signaling], ["Görüşme", session.phase]];
  for (const p of session.participants) {
    const pc = getPc(p.peerId);
    const label = p.name || p.peerId;
    if (!pc) {
      rows.push([label, `ses: ${p.media}`]);
      continue;
    }
    rows.push([`${label} · bağlantı`, `${pc.connectionState} / ICE ${pc.iceConnectionState}`]);
    try {
      const stats = await pc.getStats();
      let pairId: string | undefined;
      stats.forEach((r: { type: string; selectedCandidatePairId?: string }) => {
        if (r.type === "transport" && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
      });
      stats.forEach((r: Record<string, unknown>) => {
        if (r["type"] === "candidate-pair" && (r["id"] === pairId || (!pairId && r["nominated"] && r["state"] === "succeeded"))) {
          const rtt = r["currentRoundTripTime"];
          if (typeof rtt === "number") rows.push([`${label} · RTT`, `${Math.round(rtt * 1000)} ms`]);
          const local = stats.get(String(r["localCandidateId"])) as Record<string, unknown> | undefined;
          const remote = stats.get(String(r["remoteCandidateId"])) as Record<string, unknown> | undefined;
          if (local && remote) {
            rows.push([`${label} · yol`, `${String(local["candidateType"])} ↔ ${String(remote["candidateType"])} (${String(local["protocol"])})`]);
          }
        }
        if (r["type"] === "inbound-rtp" && r["kind"] === "audio") {
          const jitter = r["jitter"];
          if (typeof jitter === "number") rows.push([`${label} · jitter`, `${Math.round(jitter * 1000)} ms`]);
          const lost = Number(r["packetsLost"] ?? 0);
          const recv = Number(r["packetsReceived"] ?? 0);
          const pct = recv + lost > 0 ? ((lost / (recv + lost)) * 100).toFixed(1) : "0.0";
          rows.push([`${label} · paket kaybı`, `${pct}% (${lost}/${recv + lost})`]);
        }
      });
    } catch {
      rows.push([`${label} · istatistik`, "alınamadı"]);
    }
  }
  return rows;
}
