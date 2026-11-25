/**
 * Audio device discovery and capability detection (AUD-001, AUD-002, AUD-009).
 *
 * - Lists only "audioinput" and "audiooutput"; video devices are dropped immediately and never stored.
 * - Never calls getUserMedia itself: before permission the browser may expose only default devices
 *   without labels; missing labels are shown as numbered placeholders, never invented names.
 * - Reacts to "devicechange" (no polling); a manual refresh is available. Stale enumeration results
 *   (an older refresh finishing after a newer one) are ignored.
 */
import { Emitter } from "../core/emitter";

export interface AudioDevice {
  id: string;
  /** Browser label, or "" when the browser does not expose it yet. */
  label: string;
  kind: "audioinput" | "audiooutput";
}

export interface DeviceSnapshot {
  inputs: AudioDevice[];
  outputs: AudioDevice[];
  /** True if at least one device label is visible (usually after microphone permission). */
  labelsAvailable: boolean;
  /** HTMLMediaElement.setSinkId is available (output selection possible). */
  outputSelectable: boolean;
  /** devicechange events are available (otherwise refresh by hand). */
  changeEvents: boolean;
  error: string | null;
}

export interface AudioDevicesDeps {
  enumerate(): Promise<Array<Pick<MediaDeviceInfo, "deviceId" | "kind" | "label">>>;
  /** Subscribes to device changes; returns unsubscribe, or null if unsupported. */
  onDeviceChange(cb: () => void): (() => void) | null;
  outputSelectable: boolean;
}

/** Ids of browser-provided virtual entries that mean "system default" (shown as our own default option). */
const VIRTUAL_DEFAULTS = new Set(["", "default"]);

export class AudioDevices {
  private state: DeviceSnapshot;
  private generation = 0;
  private unsubscribe: (() => void) | null = null;
  private readonly events = new Emitter<{ change: DeviceSnapshot }>();

  constructor(private readonly deps: AudioDevicesDeps) {
    this.state = {
      inputs: [],
      outputs: [],
      labelsAvailable: false,
      outputSelectable: deps.outputSelectable,
      changeEvents: false,
      error: null,
    };
  }

  onChange(cb: (s: DeviceSnapshot) => void): () => void {
    return this.events.on("change", cb);
  }

  snapshot(): DeviceSnapshot {
    return this.state;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.deps.onDeviceChange(() => void this.refresh());
    this.state = { ...this.state, changeEvents: this.unsubscribe !== null };
    void this.refresh();
  }

  async refresh(): Promise<void> {
    const gen = ++this.generation;
    let list: Array<Pick<MediaDeviceInfo, "deviceId" | "kind" | "label">>;
    try {
      list = await this.deps.enumerate();
    } catch {
      if (gen !== this.generation) return;
      this.state = { ...this.state, error: "Ses cihazları listelenemedi." };
      this.events.emit("change", this.state);
      return;
    }
    if (gen !== this.generation) return; // a newer refresh superseded this one
    const pickKind = (kind: AudioDevice["kind"]): AudioDevice[] =>
      list
        .filter((d) => d.kind === kind && !VIRTUAL_DEFAULTS.has(d.deviceId))
        .map((d) => ({ id: d.deviceId, label: d.label, kind }));
    const inputs = pickKind("audioinput");
    const outputs = pickKind("audiooutput");
    this.state = {
      ...this.state,
      inputs,
      outputs,
      labelsAvailable: list.some((d) => (d.kind === "audioinput" || d.kind === "audiooutput") && d.label !== ""),
      error: null,
    };
    this.events.emit("change", this.state);
  }

  has(kind: AudioDevice["kind"], id: string): boolean {
    const list = kind === "audioinput" ? this.state.inputs : this.state.outputs;
    return list.some((d) => d.id === id);
  }

  dispose(): void {
    this.generation++;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.events.clear();
  }
}

/** Display label: the real label, or a numbered placeholder (never an invented device name). */
export function deviceLabel(d: AudioDevice, index: number): string {
  if (d.label) return d.label;
  return d.kind === "audioinput" ? `Mikrofon ${index + 1} (adı izin sonrası görünür)` : `Ses çıkışı ${index + 1} (adı izin sonrası görünür)`;
}
