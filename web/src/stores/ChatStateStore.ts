import { type ConversationChatState } from '../app-types';
import { deriveConversationReplyState } from '../app-helpers';

const EMPTY_CHAT_STATE: ConversationChatState = {
  messages: [],
  pendingMessages: [],
  turns: [],
  approvals: [],
};

type Listener = () => void;

/**
 * External store for per-conversation chat state.
 * Enables selective subscriptions via useSyncExternalStore:
 * - Components needing only the active JID's state won't re-render
 *   when a background conversation updates.
 * - busyByJid is maintained incrementally instead of O(n) on every change.
 */
export class ChatStateStore {
  private map: Record<string, ConversationChatState> = {};
  private busy: Record<string, boolean> = {};
  private stateListeners = new Set<Listener>();
  private busyListeners = new Set<Listener>();

  getSnapshot(): Record<string, ConversationChatState> {
    return this.map;
  }

  getJidState(jid: string): ConversationChatState {
    return this.map[jid] || EMPTY_CHAT_STATE;
  }

  getBusySnapshot(): Record<string, boolean> {
    return this.busy;
  }

  update(
    jid: string | null | undefined,
    updater: (state: ConversationChatState) => ConversationChatState,
  ): void {
    if (!jid) return;
    const current = this.map[jid] || EMPTY_CHAT_STATE;
    const next = updater(current);
    if (next === current) return;

    this.map = { ...this.map, [jid]: next };

    const wasBusy = this.busy[jid] ?? false;
    const isBusy = deriveConversationReplyState(next).busy;
    if (wasBusy !== isBusy) {
      this.busy = { ...this.busy, [jid]: isBusy };
      this.notifyBusy();
    }

    this.notifyState();
  }

  reset(): void {
    this.map = {};
    this.busy = {};
    this.notifyState();
    this.notifyBusy();
  }

  subscribe = (listener: Listener): (() => void) => {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  };

  subscribeBusy = (listener: Listener): (() => void) => {
    this.busyListeners.add(listener);
    return () => this.busyListeners.delete(listener);
  };

  private notifyState(): void {
    this.stateListeners.forEach((l) => l());
  }

  private notifyBusy(): void {
    this.busyListeners.forEach((l) => l());
  }
}

export { EMPTY_CHAT_STATE };
