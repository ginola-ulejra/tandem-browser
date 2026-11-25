import type { ConfigManager } from '../config/manager';
import type { ChatMessage, PanelManager } from '../panel/manager';
import { createLogger } from '../utils/logger';
import { UlejraAccountError, type UlejraAccount } from './account';

const log = createLogger('UlejraAssistant');

/**
 * The Ulejra assistant in the built-in Wingman chat.
 *
 * When the user writes in the built-in chat (backend "tandem") and is signed in to Ulejra, the
 * conversation goes to the Ulejra server's desktop chat endpoint, which answers with the agent's
 * model and charges the user's shared balance. Replies are posted back into the same chat as
 * "Ulejra". Not signed in, the chat answers with a short hint where to sign in.
 *
 * Phase 3: text only, no browser tools yet.
 */

export const ULEJRA_AGENT_TYPE = 'ulejra';
/** Hints and errors: shown in the chat, never sent back to the model as conversation. */
export const ULEJRA_NOTICE_TYPE = 'ulejra-notice';
const ACTOR_LABEL = 'Ulejra';

const HISTORY_MESSAGES = 30;
const HISTORY_CHARS = 100_000;
const CHAT_TIMEOUT_MS = 90_000;
const SIGN_IN_HINT_EVERY_MS = 10 * 60_000;

interface ModelMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** A turn the server added while answering (tool calls and their results), sent back verbatim. */
type ServerTurn = Record<string, unknown>;

interface PendingApproval {
  toolCallId: string;
  name: string;
  title: string;
  details: Record<string, unknown>;
}

/** Approval rounds in one answer: each stops for the user's decisions, then continues. */
const MAX_APPROVAL_ROUNDS = 3;

/** The approval card text: the action, then what it will do, one line each. */
export function describeApproval(approval: PendingApproval): string {
  const lines = Object.entries(approval.details ?? {}).map(([key, value]) => {
    const label = key.replace(/_/g, ' ');
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return `${label}: ${text}`;
  });
  return [approval.title, ...lines].join('\n');
}

/**
 * The recent conversation with the Ulejra assistant, oldest first, starting with a user turn.
 * `answeredUpTo` maps a reply's message id to the last user message it answered, so a reply that
 * landed after the user wrote again sits before that newer message. Empty when the last turn is
 * already an answer: there is nothing left to answer.
 */
export function buildConversation(
  messages: ChatMessage[],
  answeredUpTo: ReadonlyMap<number, number> = new Map(),
): ModelMessage[] {
  const position = (msg: ChatMessage) => {
    const answered = answeredUpTo.get(msg.id);
    return answered === undefined ? msg.id : answered + 0.5;
  };
  const ordered = [...messages].sort((a, b) => position(a) - position(b));
  const turns: ModelMessage[] = [];
  let chars = 0;
  for (let i = ordered.length - 1; i >= 0 && turns.length < HISTORY_MESSAGES; i--) {
    const msg = ordered[i];
    let turn: ModelMessage | null = null;
    if (msg.from === 'user' && msg.text.trim()) {
      turn = { role: 'user', content: msg.text };
    } else if (msg.from === 'wingman' && msg.agentType === ULEJRA_AGENT_TYPE && msg.text.trim()) {
      turn = { role: 'assistant', content: msg.text };
    }
    if (!turn) continue;
    if (chars + turn.content.length > HISTORY_CHARS && turns.length > 0) break;
    chars += turn.content.length;
    turns.unshift(turn);
  }
  while (turns.length > 0 && turns[0].role !== 'user') {
    turns.shift();
  }
  if (turns.length > 0 && turns[turns.length - 1].role !== 'user') {
    return [];
  }
  return turns;
}

interface DesktopChatReply {
  message?: { content?: string } | null;
  finishReason?: string | null;
  added?: ServerTurn[];
  pendingApprovals?: PendingApproval[];
  error?: string;
}

export interface UlejraAssistantDeps {
  configManager: ConfigManager;
  panelManager: PanelManager;
  account: UlejraAccount;
  /** Subscribes to the emergency stop; returns an unsubscribe function. */
  onEmergencyStop?: (listener: () => void) => () => void;
  /** Shows an approval card and resolves with the user's decision (false on stop or timeout). */
  requestApproval?: (description: string, signal: AbortSignal) => Promise<boolean>;
  now?: () => number;
}

export class UlejraAssistant {
  private running = false;
  private again = false;
  private inFlight: AbortController | null = null;
  private lastSignInHint = 0;
  /** Reply message id → the last user message id it answered (this session). */
  private readonly answeredUpTo = new Map<number, number>();
  private readonly unsubscribers: Array<() => void> = [];
  private readonly now: () => number;

  constructor(private readonly deps: UlejraAssistantDeps) {
    this.now = deps.now ?? Date.now;
    this.unsubscribers.push(deps.panelManager.onChatMessage((msg) => this.onChatMessage(msg)));
    if (deps.onEmergencyStop) {
      this.unsubscribers.push(deps.onEmergencyStop(() => this.stop()));
    }
  }

  /** Stops the request in flight; the chat shows that it stopped. */
  stop(): void {
    if (this.inFlight) {
      this.again = false;
      this.inFlight.abort();
    }
  }

  dispose(): void {
    this.stop();
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
  }

  private active(): boolean {
    const config = this.deps.configManager.getConfig();
    return config.ulejra.assistantEnabled !== false && config.general.activeBackend === 'tandem';
  }

  private onChatMessage(msg: ChatMessage): void {
    if (msg.from !== 'user' || !msg.text.trim() || !this.active()) return;
    if (this.running) {
      this.again = true;
      return;
    }
    void this.run();
  }

  /** Answers the conversation; a message that arrives meanwhile gets one more answer after. */
  private async run(): Promise<void> {
    this.running = true;
    try {
      do {
        this.again = false;
        await this.answer();
      } while (this.again);
    } finally {
      this.running = false;
    }
  }

  private async answer(): Promise<void> {
    const { panelManager, account } = this.deps;
    const history = panelManager.getChatMessages(HISTORY_MESSAGES * 2);
    const conversation = buildConversation(history, this.answeredUpTo);
    if (conversation.length === 0) return;
    const lastUserId = [...history].reverse().find((msg) => msg.from === 'user')?.id ?? 0;

    const controller = new AbortController();
    this.inFlight = controller;
    panelManager.setWingmanTyping(true);
    /** What the server added during this answer, sent back when it continues after approvals. */
    const transcript: ServerTurn[] = [];
    let approvals: Record<string, 'approve' | 'reject'> | undefined;
    try {
      for (let round = 0; ; round++) {
        const response = await account.authorizedFetch(
          '/api/ulejra/desktop/chat',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ messages: [...conversation, ...transcript], ...(approvals ? { approvals } : {}) }),
            signal: controller.signal,
          },
          CHAT_TIMEOUT_MS,
        );
        const body = (await response.json().catch(() => ({}))) as DesktopChatReply;
        if (response.ok && body.finishReason === 'approval_required' && body.pendingApprovals?.length) {
          transcript.push(...(body.added ?? []));
          if (!this.deps.requestApproval || round >= MAX_APPROVAL_ROUNDS) {
            this.notice('This needs your approval. Approve it in the Ulejra web app, then ask me again.');
            return;
          }
          panelManager.setWingmanTyping(false);
          approvals = {};
          for (const pending of body.pendingApprovals) {
            const approved = await this.deps.requestApproval(describeApproval(pending), controller.signal);
            approvals[pending.toolCallId] = approved ? 'approve' : 'reject';
          }
          if (controller.signal.aborted) {
            this.notice('Stopped.');
            return;
          }
          panelManager.setWingmanTyping(true);
          continue;
        }
        this.finish(response, body, lastUserId);
        return;
      }
    } catch (error) {
      if (controller.signal.aborted) {
        this.notice('Stopped.');
      } else if (error instanceof UlejraAccountError && error.code === 'signed_out') {
        this.signInHint();
      } else if (error instanceof UlejraAccountError && error.code === 'backend_unreachable') {
        this.notice('Cannot reach the Ulejra server. Check your connection and try again.');
      } else {
        log.warn('Ulejra chat failed:', error instanceof Error ? error.message : String(error));
        this.notice('The Ulejra assistant did not answer. Try again in a moment.');
      }
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
      panelManager.setWingmanTyping(false);
    }
  }

  /** Posts the final answer, or says why there is none. */
  private finish(response: Response, body: DesktopChatReply, lastUserId: number): void {
    if (response.ok && typeof body.message?.content === 'string' && body.message.content.trim()) {
      const answer = this.reply(body.message.content);
      this.answeredUpTo.set(answer.id, lastUserId);
    } else if (response.status === 402) {
      this.notice('Your Ulejra balance has run out, so the assistant cannot answer.');
    } else if (response.status === 429) {
      this.notice('Too many messages at once. Wait a moment and try again.');
    } else {
      log.warn(`Ulejra chat answered ${response.status}${body.error ? ` (${body.error})` : ''}`);
      this.notice('The Ulejra assistant did not answer. Try again in a moment.');
    }
  }

  private signInHint(): void {
    if (this.now() - this.lastSignInHint < SIGN_IN_HINT_EVERY_MS) return;
    this.lastSignInHint = this.now();
    this.notice('Sign in to your Ulejra account in Settings (⌘ ,) to chat with the Ulejra assistant.');
  }

  private reply(text: string): ChatMessage {
    return this.deps.panelManager.addChatMessage('wingman', text, undefined, {
      actorLabel: ACTOR_LABEL,
      agentType: ULEJRA_AGENT_TYPE,
      notifyWebhook: false,
    });
  }

  private notice(text: string): void {
    this.deps.panelManager.addChatMessage('wingman', text, undefined, {
      actorLabel: ACTOR_LABEL,
      agentType: ULEJRA_NOTICE_TYPE,
      notifyWebhook: false,
    });
  }
}
