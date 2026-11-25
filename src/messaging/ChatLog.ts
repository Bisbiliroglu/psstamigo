/**
 * Ephemeral, in-memory chat history (FR-015, GR-007). Never persisted, never sent to new joiners.
 * System entries (join/leave notices) live in the same session-scoped memory.
 */
import { LIMITS } from "../core/config";

export interface ChatEntry {
  readonly id: number;
  readonly kind: "chat" | "system";
  readonly fromSelf: boolean;
  /** UID of the sender as identified by the authorized link (null for self and system entries). */
  readonly senderUid: string | null;
  readonly senderName: string;
  readonly text: string;
  /** Local display time (ms since epoch); never taken from the remote peer. */
  readonly at: number;
}

export class ChatLog {
  private entries: ChatEntry[] = [];
  private nextId = 1;

  constructor(private readonly now: () => number = () => Date.now()) {}

  add(fromSelf: boolean, senderName: string, text: string, senderUid: string | null = null): ChatEntry {
    return this.push({ kind: "chat", fromSelf, senderUid, senderName, text });
  }

  addSystem(text: string): ChatEntry {
    return this.push({ kind: "system", fromSelf: false, senderUid: null, senderName: "", text });
  }

  private push(entry: Omit<ChatEntry, "id" | "at">): ChatEntry {
    const full: ChatEntry = { ...entry, id: this.nextId++, at: this.now() };
    this.entries.push(full);
    if (this.entries.length > LIMITS.chatHistory) this.entries.splice(0, this.entries.length - LIMITS.chatHistory);
    return full;
  }

  list(): readonly ChatEntry[] {
    return this.entries;
  }

  clear(): void {
    this.entries = [];
  }
}
