/**
 * DOM view. Renders state snapshots; never touches PeerJS or WebRTC lifecycle.
 * All remote-provided strings are rendered with textContent (no HTML injection).
 */
import type { MicSnapshot } from "../audio/MicrophoneController";
import type { SpeakerSnapshot } from "../audio/SpeakerController";
import type { SessionSnapshot } from "../session/SessionController";
import type { SignalingState } from "../signaling/types";

export interface ViewActions {
  copyUid(): void;
  setDisplayName(name: string): void;
  connect(target: string): void;
  cancelRequest(): void;
  accept(id: number): void;
  reject(id: number): void;
  toggleMic(): void;
  toggleSpeaker(): void;
  leave(): void;
  sendChat(text: string): boolean;
  diagnosticsToggled(open: boolean): void;
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

const SIGNAL_TEXT: Record<SignalingState, string> = {
  connecting: "Sinyal: bağlanıyor…",
  online: "Sinyal: çevrimiçi",
  offline: "Sinyal: bağlantı yok",
  failed: "Sinyal: başarısız",
};

const MEDIA_TEXT = {
  connecting: "ses kuruluyor…",
  connected: "ses bağlı",
  interrupted: "ses kesintide…",
  failed: "ses yok",
} as const;

export class View {
  private readonly signal = el<HTMLParagraphElement>("signal-status");
  private readonly uid = el<HTMLElement>("my-uid");
  private readonly copyBtn = el<HTMLButtonElement>("copy-uid");
  private readonly nameInput = el<HTMLInputElement>("display-name");
  private readonly connectForm = el<HTMLFormElement>("connect-form");
  private readonly targetInput = el<HTMLInputElement>("target-uid");
  private readonly connectBtn = el<HTMLButtonElement>("connect-btn");
  private readonly cancelBtn = el<HTMLButtonElement>("cancel-btn");
  private readonly notice = el<HTMLParagraphElement>("notice");
  private readonly requests = el<HTMLDivElement>("requests");
  private readonly sessionStatus = el<HTMLParagraphElement>("session-status");
  private readonly participants = el<HTMLUListElement>("participants");
  private readonly micBtn = el<HTMLButtonElement>("mic-btn");
  private readonly micLabel = el<HTMLSpanElement>("mic-label");
  private readonly micMeter = el<HTMLDivElement>("mic-meter");
  private readonly speakerBtn = el<HTMLButtonElement>("speaker-btn");
  private readonly speakerLabel = el<HTMLSpanElement>("speaker-label");
  private readonly speakerMeter = el<HTMLDivElement>("speaker-meter");
  private readonly leaveBtn = el<HTMLButtonElement>("leave-btn");
  private readonly audioError = el<HTMLParagraphElement>("audio-error");
  private readonly chatLog = el<HTMLOListElement>("chat-log");
  private readonly chatForm = el<HTMLFormElement>("chat-form");
  private readonly chatInput = el<HTMLInputElement>("chat-input");
  private readonly chatSend = el<HTMLButtonElement>("chat-send");
  private readonly diagnostics = el<HTMLDetailsElement>("diagnostics");
  private readonly diagList = el<HTMLDListElement>("diag-list");

  private signalingState: SignalingState = "connecting";
  private session: SessionSnapshot | null = null;
  private renderedChatIds = new Set<number>();
  private readonly participantMeters = new Map<string, { row: HTMLLIElement; meter: HTMLDivElement }>();
  private readonly cleanups: Array<() => void> = [];

  constructor(version: string, private readonly actions: ViewActions) {
    el<HTMLSpanElement>("app-version").textContent = `v${version}`;
    this.listen(this.copyBtn, "click", () => actions.copyUid());
    this.listen(this.nameInput, "input", () => actions.setDisplayName(this.nameInput.value));
    this.listen(this.connectForm, "submit", (e) => {
      e.preventDefault();
      actions.connect(this.targetInput.value);
    });
    this.listen(this.cancelBtn, "click", () => actions.cancelRequest());
    this.listen(this.micBtn, "click", () => actions.toggleMic());
    this.listen(this.speakerBtn, "click", () => actions.toggleSpeaker());
    this.listen(this.leaveBtn, "click", () => actions.leave());
    this.listen(this.chatForm, "submit", (e) => {
      e.preventDefault();
      if (actions.sendChat(this.chatInput.value)) this.chatInput.value = "";
    });
    this.listen(this.diagnostics, "toggle", () => actions.diagnosticsToggled(this.diagnostics.open));
  }

  private listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (e: HTMLElementEventMap[K]) => void,
  ): void {
    target.addEventListener(type, handler as EventListener);
    this.cleanups.push(() => target.removeEventListener(type, handler as EventListener));
  }

  renderSignaling(state: SignalingState, uid: string | null): void {
    this.signalingState = state;
    this.signal.textContent = SIGNAL_TEXT[state];
    this.signal.dataset["state"] = state;
    this.uid.textContent = uid ?? "—";
    this.copyBtn.disabled = uid === null;
    this.updateConnectControls();
  }

  renderSession(s: SessionSnapshot): void {
    this.session = s;
    this.updateConnectControls();

    // Notice
    if (s.notice) {
      this.notice.hidden = false;
      this.notice.className = `notice ${s.notice.kind}`;
      this.notice.textContent = s.notice.text;
    } else {
      this.notice.hidden = true;
      this.notice.textContent = "";
    }

    // Incoming requests
    this.requests.replaceChildren(
      ...s.incoming.map((r) => {
        const box = document.createElement("div");
        box.className = "request";
        box.dataset["testid"] = "incoming-request";
        const p = document.createElement("p");
        const strong = document.createElement("strong");
        strong.textContent = r.name || "(adsız)";
        const code = document.createElement("code");
        code.textContent = r.peerId;
        p.append(strong, " seninle sesli görüşmek istiyor: ", code);
        const accept = document.createElement("button");
        accept.type = "button";
        accept.className = "primary";
        accept.textContent = "Kabul et";
        accept.addEventListener("click", () => this.actions.accept(r.id));
        const reject = document.createElement("button");
        reject.type = "button";
        reject.textContent = "Reddet";
        reject.addEventListener("click", () => this.actions.reject(r.id));
        box.append(p, accept, reject);
        return box;
      }),
    );

    // Session status & participants
    const active = s.phase === "active";
    this.sessionStatus.textContent =
      s.phase === "requesting"
        ? `İstek gönderildi, ${s.target ?? ""} yanıtı bekleniyor…`
        : active
          ? `Aktif görüşme · ${s.participants.length + 1} kişi`
          : "Aktif görüşme yok.";

    const seen = new Set<string>();
    for (const p of s.participants) {
      seen.add(p.peerId);
      let entry = this.participantMeters.get(p.peerId);
      if (!entry) {
        const row = document.createElement("li");
        row.className = "participant";
        row.dataset["testid"] = "participant";
        const name = document.createElement("span");
        name.className = "name";
        const media = document.createElement("span");
        media.className = "media";
        const meter = createMeter(true);
        row.append(meter, name, media);
        this.participants.append(row);
        entry = { row, meter };
        this.participantMeters.set(p.peerId, entry);
      }
      const [, nameEl, mediaEl] = entry.row.children as unknown as [HTMLElement, HTMLElement, HTMLElement];
      nameEl.textContent = p.name ? `${p.name} (${p.peerId})` : p.peerId;
      mediaEl.textContent = MEDIA_TEXT[p.media];
      mediaEl.dataset["status"] = p.media;
    }
    for (const [peerId, entry] of this.participantMeters) {
      if (!seen.has(peerId)) {
        entry.row.remove();
        this.participantMeters.delete(peerId);
      }
    }

    this.micBtn.disabled = !active;
    this.speakerBtn.disabled = !active;
    this.leaveBtn.disabled = !active;
    this.chatInput.disabled = !active;
    this.chatSend.disabled = !active;

    // Chat (incremental append; cleared when the session ends)
    if (s.chat.length === 0 && this.renderedChatIds.size > 0) {
      this.chatLog.replaceChildren();
      this.renderedChatIds = new Set();
    }
    for (const entry of s.chat) {
      if (this.renderedChatIds.has(entry.id)) continue;
      this.renderedChatIds.add(entry.id);
      const li = document.createElement("li");
      li.className = entry.fromSelf ? "self" : "remote";
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = new Date(entry.at).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
      const who = document.createElement("strong");
      who.className = "who";
      who.textContent = `${entry.senderName}: `;
      const text = document.createElement("span");
      text.textContent = entry.text;
      li.append(meta, who, text);
      this.chatLog.append(li);
    }
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }

  renderMic(m: MicSnapshot): void {
    const on = m.state === "on";
    this.micBtn.setAttribute("aria-pressed", String(on));
    this.micBtn.dataset["state"] = m.state;
    this.micLabel.textContent =
      m.state === "on" ? "Mikrofon açık" : m.state === "starting" ? "Mikrofon açılıyor…" : "Mikrofon kapalı";
    if (!on) setMeter(this.micMeter, 0);
    this.renderAudioError(m.error);
  }

  renderSpeaker(s: SpeakerSnapshot): void {
    this.speakerBtn.setAttribute("aria-pressed", String(s.enabled));
    this.speakerLabel.textContent = s.enabled ? "Hoparlör açık" : "Hoparlör kapalı";
    if (!s.enabled) {
      setMeter(this.speakerMeter, 0);
      for (const { meter, row } of this.participantMeters.values()) {
        setMeter(meter, 0);
        row.dataset["speaking"] = "false";
      }
    }
    if (s.error) this.renderAudioError(s.error);
  }

  private renderAudioError(text: string | null): void {
    this.audioError.hidden = text === null;
    this.audioError.textContent = text ?? "";
  }

  setMicLevel(level: number): void {
    setMeter(this.micMeter, level);
  }

  setSpeakerLevel(level: number): void {
    setMeter(this.speakerMeter, level);
  }

  setParticipantLevel(peerId: string, level: number, speaking: boolean): void {
    const entry = this.participantMeters.get(peerId);
    if (!entry) return;
    setMeter(entry.meter, level);
    entry.row.dataset["speaking"] = String(speaking);
  }

  renderDiagnostics(rows: ReadonlyArray<readonly [string, string]>): void {
    this.diagList.replaceChildren(
      ...rows.flatMap(([k, v]) => {
        const dt = document.createElement("dt");
        dt.textContent = k;
        const dd = document.createElement("dd");
        dd.textContent = v;
        return [dt, dd];
      }),
    );
  }

  flashCopied(ok: boolean): void {
    const original = "Kopyala";
    this.copyBtn.textContent = ok ? "Kopyalandı ✓" : "Kopyalanamadı";
    setTimeout(() => (this.copyBtn.textContent = original), 1500);
  }

  private updateConnectControls(): void {
    const phase = this.session?.phase ?? "idle";
    this.connectBtn.disabled = this.signalingState !== "online" || phase !== "idle";
    this.targetInput.disabled = phase !== "idle";
    this.cancelBtn.hidden = phase !== "requesting";
  }

  dispose(): void {
    for (const c of this.cleanups) c();
    this.cleanups.length = 0;
  }
}

function createMeter(small: boolean): HTMLDivElement {
  const meter = document.createElement("div");
  meter.className = small ? "meter small" : "meter";
  meter.setAttribute("aria-hidden", "true");
  for (let i = 1; i <= 5; i++) {
    const bar = document.createElement("i");
    bar.style.setProperty("--i", String(i));
    meter.append(bar);
  }
  return meter;
}

function setMeter(meter: HTMLElement, level: number): void {
  const lit = Math.round(Math.min(1, Math.max(0, level)) * 5);
  const bars = meter.children;
  for (let i = 0; i < bars.length; i++) bars[i]?.classList.toggle("lit", i < lit);
  meter.dataset["level"] = String(lit);
}
