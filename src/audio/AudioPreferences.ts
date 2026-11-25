/**
 * Opt-in local audio preferences (D-034, user-approved). The ONLY module allowed to use localStorage.
 *
 * Stored (only after the user ticks "Ses cihazı tercihlerimi hatırla"): selected input/output device
 * ids, master volume, three processing toggles. NOT stored: device names or inventory, UID, session
 * or participant data, chat, mic/speaker on-off state, approvals, IP addresses. Nothing leaves the
 * browser. Corrupt or unexpected data is ignored. "Kaydedilenleri sil" removes everything.
 */
import type { ProcessingSettings } from "./MicrophoneController";

export const PREFERENCES_KEY = "psstamigo.audio.v1";

export interface AudioPrefs {
  inputId: string | null;
  outputId: string | null;
  masterVolume: number;
  processing: ProcessingSettings;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const MAX_ID = 256;

function validId(v: unknown): v is string | null {
  return v === null || (typeof v === "string" && v.length > 0 && v.length <= MAX_ID);
}

/** Strict schema check: anything unexpected ⇒ null (ignored). */
export function parsePrefs(raw: string | null): AudioPrefs | null {
  if (!raw || raw.length > 2_048) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(",");
  if (keys !== "inputId,masterVolume,outputId,processing") return null;
  const p = o["processing"];
  if (typeof p !== "object" || p === null || Array.isArray(p)) return null;
  const pp = p as Record<string, unknown>;
  if (Object.keys(pp).sort().join(",") !== "autoGainControl,echoCancellation,noiseSuppression") return null;
  if (![pp["echoCancellation"], pp["noiseSuppression"], pp["autoGainControl"]].every((x) => typeof x === "boolean")) return null;
  const vol = o["masterVolume"];
  if (typeof vol !== "number" || !Number.isFinite(vol) || vol < 0 || vol > 1) return null;
  if (!validId(o["inputId"]) || !validId(o["outputId"])) return null;
  return {
    inputId: o["inputId"] as string | null,
    outputId: o["outputId"] as string | null,
    masterVolume: vol,
    processing: {
      echoCancellation: pp["echoCancellation"] as boolean,
      noiseSuppression: pp["noiseSuppression"] as boolean,
      autoGainControl: pp["autoGainControl"] as boolean,
    },
  };
}

export class AudioPreferences {
  private readonly storage: StorageLike | null;

  constructor(storage: () => StorageLike | null = defaultStorage) {
    let s: StorageLike | null = null;
    try {
      s = storage();
    } catch {
      s = null; // storage blocked (private mode, policy): preferences simply are not remembered
    }
    this.storage = s;
  }

  get available(): boolean {
    return this.storage !== null;
  }

  /** Saved preferences, or null when not opted in / invalid. */
  load(): AudioPrefs | null {
    try {
      return parsePrefs(this.storage?.getItem(PREFERENCES_KEY) ?? null);
    } catch {
      return null;
    }
  }

  /** Opt-in is implied by the presence of saved data. */
  isRemembering(): boolean {
    return this.load() !== null;
  }

  save(prefs: AudioPrefs): boolean {
    try {
      this.storage?.setItem(PREFERENCES_KEY, JSON.stringify(prefs));
      return this.storage !== null;
    } catch {
      return false;
    }
  }

  clear(): void {
    try {
      this.storage?.removeItem(PREFERENCES_KEY);
    } catch {
      /* ignore */
    }
  }
}

function defaultStorage(): StorageLike | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}
