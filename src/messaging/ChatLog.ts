/** Ephemeral, in-memory chat history (FR-015). Never persisted, never sent to new joiners. */
import { LIMITS } from "../core/config";

export interface ChatEntry {
  readonly id: number;
  readonly fromSelf: boolean;
  readonly senderName: string;
  readonly text: string;
  /** Local display time (ms since epoch); never taken from the remote peer. */
  readonly at: number;
}

export class ChatLog {
  private entries: ChatEntry[] = [];
  private nextId = 1;

  constructor(private readonly now: () => number = () => Date.now()) {}

  add(fromSelf: boolean, senderName: string, text: string): ChatEntry {
    const entry: ChatEntry = { id: this.nextId++, fromSelf, senderName, text, at: this.now() };
    this.entries.push(entry);
    if (this.entries.length > LIMITS.chatHistory) this.entries.splice(0, this.entries.length - LIMITS.chatHistory);
    return entry;
  }

  list(): readonly ChatEntry[] {
    return this.entries;
  }

  clear(): void {
    this.entries = [];
  }
}
