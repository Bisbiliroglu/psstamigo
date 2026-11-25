/**
 * Audio settings panel (PA-009). Renders state and forwards user actions only; it never calls
 * getUserMedia, touches senders, or manages playback itself.
 */
import { deviceLabel, type AudioDevice, type DeviceSnapshot } from "../audio/AudioDevices";
import type { DiagnosticsSnapshot } from "../audio/AudioDiagnostics";
import type { MicSnapshot, ProcessingKey } from "../audio/MicrophoneController";
import type { SpeakerSnapshot } from "../audio/SpeakerController";

export interface AudioSettingsActions {
  selectMic(id: string | null): void;
  selectOutput(id: string | null): void;
  grantLabels(): void;
  toggleMicTest(): void;
  speakerTest(): void;
  setMasterVolume(v: number): void;
  setProcessing(key: ProcessingKey, value: boolean): void;
  setRemember(on: boolean): void;
  clearPrefs(): void;
  refreshDevices(): void;
  panelToggled(open: boolean): void;
}

export interface AudioSettingsState {
  devices: DeviceSnapshot;
  mic: MicSnapshot;
  speaker: SpeakerSnapshot;
  diag: DiagnosticsSnapshot;
  inSession: boolean;
  remember: boolean;
  storageAvailable: boolean;
  /** Constraint names the browser reports as supported. */
  supported: ReadonlySet<string>;
  prefsNotice: string | null;
}

const DEFAULT_VALUE = "__default";
const KEYS: ProcessingKey[] = ["noiseSuppression", "echoCancellation", "autoGainControl"];

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

export class AudioSettingsView {
  private readonly panel = el<HTMLDetailsElement>("audio-settings");
  private readonly micSelect = el<HTMLSelectElement>("mic-device");
  private readonly micActive = el<HTMLParagraphElement>("mic-active");
  private readonly grantBtn = el<HTMLButtonElement>("grant-labels");
  private readonly micTestBtn = el<HTMLButtonElement>("mic-test");
  private readonly micTestMeter = el<HTMLDivElement>("mic-test-meter");
  private readonly micTestHint = el<HTMLParagraphElement>("mic-test-hint");
  private readonly micError = el<HTMLParagraphElement>("mic-device-error");
  private readonly outSelect = el<HTMLSelectElement>("out-device");
  private readonly outActive = el<HTMLParagraphElement>("out-active");
  private readonly speakerTestBtn = el<HTMLButtonElement>("speaker-test");
  private readonly master = el<HTMLInputElement>("master-volume");
  private readonly outError = el<HTMLParagraphElement>("out-device-error");
  private readonly remember = el<HTMLInputElement>("remember-prefs");
  private readonly clearBtn = el<HTMLButtonElement>("clear-prefs");

  constructor(actions: AudioSettingsActions) {
    const value = (s: HTMLSelectElement): string | null => (s.value === DEFAULT_VALUE ? null : s.value);
    this.micSelect.addEventListener("change", () => actions.selectMic(value(this.micSelect)));
    this.outSelect.addEventListener("change", () => actions.selectOutput(value(this.outSelect)));
    this.grantBtn.addEventListener("click", () => actions.grantLabels());
    this.micTestBtn.addEventListener("click", () => actions.toggleMicTest());
    this.speakerTestBtn.addEventListener("click", () => actions.speakerTest());
    this.master.addEventListener("input", () => actions.setMasterVolume(Number(this.master.value) / 100));
    for (const k of KEYS) {
      const box = el<HTMLInputElement>(`proc-${k}`);
      box.addEventListener("change", () => actions.setProcessing(k, box.checked));
    }
    this.remember.addEventListener("change", () => actions.setRemember(this.remember.checked));
    this.clearBtn.addEventListener("click", () => actions.clearPrefs());
    el<HTMLButtonElement>("refresh-devices").addEventListener("click", () => actions.refreshDevices());
    this.panel.addEventListener("toggle", () => actions.panelToggled(this.panel.open));
  }

  render(s: AudioSettingsState): void {
    const { devices, mic, speaker, diag } = s;

    // ---- microphone
    fillSelect(this.micSelect, devices.inputs, mic.selectedDeviceId, "Sistem varsayılanı");
    this.grantBtn.hidden = devices.labelsAvailable || mic.state === "on";
    const nameOf = (list: AudioDevice[], id: string | null): string => {
      if (id === null || id === "default" || id === "") return "Sistem varsayılanı";
      const i = list.findIndex((d) => d.id === id);
      return i >= 0 ? deviceLabel(list[i]!, i) : "listede olmayan bir cihaz";
    };
    this.micActive.textContent =
      mic.state === "on"
        ? `Aktif mikrofon: ${mic.activeDeviceId ? nameOf(devices.inputs, mic.activeDeviceId) : "tarayıcı bildirmedi"}`
        : mic.state === "starting"
          ? "Mikrofon açılıyor…"
          : `Mikrofon kapalı. Seçili: ${nameOf(devices.inputs, mic.selectedDeviceId)}${mic.selectedAvailable ? "" : " (şu an bağlı değil)"}`;
    if (mic.selectedDeviceId === null) this.micActive.textContent += " · Sistem varsayılanı, işletim sistemi değiştirirse başka bir cihaza geçebilir.";
    const testing = diag.micTest === "running" || diag.micTest === "starting";
    this.micTestBtn.textContent = testing ? "Testi durdur" : "Mikrofonu test et";
    // Never a second capture during a call (AUD-012): use the live meter there instead.
    this.micTestBtn.disabled = s.inSession && !testing;
    this.micTestHint.textContent = s.inSession
      ? "Görüşme sırasında test yapılmaz; mikrofonu açınca yanındaki seviye göstergesi gerçek sesini gösterir."
      : "Test 15 sn sürer; ses hiçbir yere gönderilmez, kaydedilmez ve sana geri çalınmaz.";
    if (!testing) setMeter(this.micTestMeter, 0);
    const micErr = diag.micTestError ?? s.prefsNotice ?? (mic.state === "error" ? mic.error : null);
    this.micError.hidden = micErr === null;
    this.micError.textContent = micErr ?? "";

    // ---- output
    fillSelect(this.outSelect, devices.outputs, speaker.outputDeviceId, "Sistem varsayılanı");
    this.outSelect.disabled = !devices.outputSelectable;
    this.outActive.textContent = !devices.outputSelectable
      ? "Bu tarayıcı ses çıkışı seçmeyi desteklemiyor; sistem varsayılanı kullanılır."
      : speaker.enabled
        ? speaker.routed
          ? `Konuşmalar şu çıkıştan çalıyor: ${nameOf(devices.outputs, speaker.outputDeviceId)}`
          : "Ses çıkışı yönlendiriliyor…"
        : `Hoparlör kapalı. Seçili: ${nameOf(devices.outputs, speaker.outputDeviceId)}${speaker.outputAvailable ? "" : " (şu an bağlı değil)"}`;
    if (devices.outputSelectable && speaker.outputDeviceId === null) this.outActive.textContent += " · Sistem varsayılanı, işletim sistemi değiştirirse başka bir cihaza geçebilir.";
    this.speakerTestBtn.disabled = diag.speakerTest === "playing";
    this.speakerTestBtn.textContent = diag.speakerTest === "playing" ? "Çalıyor…" : "Hoparlörü test et";
    if (document.activeElement !== this.master) this.master.value = String(Math.round(speaker.masterVolume * 100));
    const outErr = diag.speakerTestError ?? speaker.error;
    this.outError.hidden = outErr === null;
    this.outError.textContent = outErr ?? "";

    // ---- processing: requested vs applied (AUD-017…019)
    for (const k of KEYS) {
      const box = el<HTMLInputElement>(`proc-${k}`);
      const state = el<HTMLSpanElement>(`proc-${k}-state`);
      box.checked = mic.requested[k];
      if (!s.supported.has(k)) {
        box.disabled = true;
        state.textContent = "(bu tarayıcıda desteklenmiyor)";
      } else if (mic.state === "on" && mic.applied) {
        const applied = mic.applied[k];
        state.textContent =
          applied === undefined ? "(uygulanan değer bildirilmedi)" : applied === mic.requested[k] ? "(uygulandı)" : `(istenen: ${on(mic.requested[k])}, uygulanan: ${on(applied)})`;
      } else {
        state.textContent = "(mikrofon açılınca uygulanır)";
      }
    }

    // ---- preferences
    this.remember.disabled = !s.storageAvailable;
    this.remember.checked = s.remember;
    this.clearBtn.disabled = !s.remember;
  }

  setTestLevel(level: number): void {
    setMeter(this.micTestMeter, level);
  }

  get isOpen(): boolean {
    return this.panel.open;
  }
}

function on(v: boolean): string {
  return v ? "açık" : "kapalı";
}

function fillSelect(select: HTMLSelectElement, list: AudioDevice[], selected: string | null, defaultText: string): void {
  const options: Array<[string, string]> = [[DEFAULT_VALUE, defaultText], ...list.map((d, i): [string, string] => [d.id, deviceLabel(d, i)])];
  // Keep an unavailable explicit selection visible instead of silently showing another device.
  if (selected !== null && !list.some((d) => d.id === selected)) options.push([selected, "Kaydedilen/seçili cihaz (şu an bulunamadı)"]);
  const signature = options.map(([v, t]) => `${v}\u0000${t}`).join("\u0001");
  if (select.dataset["sig"] !== signature) {
    select.replaceChildren(
      ...options.map(([v, t]) => {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = t;
        return o;
      }),
    );
    select.dataset["sig"] = signature;
  }
  select.value = selected ?? DEFAULT_VALUE;
}

const BAR_WEIGHTS = [0.55, 0.8, 1, 0.8, 0.55];
function setMeter(meter: HTMLElement, level: number): void {
  const v = Math.min(1, Math.max(0, level));
  const bars = meter.children;
  for (let i = 0; i < bars.length; i++) {
    const h = v === 0 ? 0.15 : Math.min(1, Math.max(0.15, v * (BAR_WEIGHTS[i] ?? 1) * 1.6));
    (bars[i] as HTMLElement | undefined)?.style.setProperty("--h", h.toFixed(3));
  }
  meter.dataset["level"] = String(Math.round(v * 5));
}
