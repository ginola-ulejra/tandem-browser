import type { PanelManager } from '../panel/manager';
import { createLogger } from '../utils/logger';
import type { UlejraAccount } from './account';
import type { ApprovalPrompt, ApprovalPrompter } from './prompter';

const log = createLogger('UlejraPayments');

/**
 * Payment approvals on the desktop: the owner's pending Ulejra approvals (purchases, escrow
 * releases, publishing) shown as Wingman approval cards, decided through the same endpoint as the
 * web app's approvals panel.
 *
 * Only the user's click decides. A card never times out into a decision; when the approval is
 * decided elsewhere (the web app) or expires, its card closes and nothing is sent.
 */

export const ULEJRA_PAYMENT_NOTICE_TYPE = 'ulejra-notice';

const CHECK_EVERY_MS = 30_000;

export interface PendingApproval {
  id: string;
  kind: string;
  status: string;
  title: string;
  amountMinor?: number;
  currency?: string;
  counterpartyHandle?: string;
  autoApproved?: boolean;
  expiresAt?: string;
}

const ACTIONS: Record<string, string> = {
  purchase: 'Pay for a purchase',
  release_escrow: 'Release the payment to the seller',
  publish_listing: 'Publish a listing',
  publish_request: 'Publish a request',
};

export function formatMinor(minor: number, currency = ''): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(minor));
  const amount = `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return currency ? `${amount} ${currency}` : amount;
}

/** The approval card text: what, how much, with whom, until when. */
export function describePayment(approval: PendingApproval): string {
  const lines = [`${ACTIONS[approval.kind] ?? 'Approve'}: ${approval.title}`];
  if (typeof approval.amountMinor === 'number') {
    lines.push(`Amount: ${formatMinor(approval.amountMinor, approval.currency)}`);
  }
  if (approval.counterpartyHandle) {
    lines.push(`With: @${approval.counterpartyHandle.replace(/^@/, '')}`);
  }
  if (approval.expiresAt) {
    const expires = new Date(approval.expiresAt);
    if (!Number.isNaN(expires.getTime())) lines.push(`Expires: ${expires.toLocaleString()}`);
  }
  return lines.join('\n');
}

export interface UlejraPaymentApprovalsDeps {
  account: UlejraAccount;
  panelManager: PanelManager;
  prompt: ApprovalPrompter;
  checkEveryMs?: number;
}

interface OpenCard {
  prompt: ApprovalPrompt;
  /** Decided in the web app or expired: close without sending anything. */
  closedElsewhere: boolean;
}

export class UlejraPaymentApprovals {
  private readonly open = new Map<string, OpenCard>();
  private timer: NodeJS.Timeout | null = null;
  private checking: Promise<void> | null = null;

  constructor(private readonly deps: UlejraPaymentApprovalsDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check(), this.deps.checkEveryMs ?? CHECK_EVERY_MS);
    this.timer.unref?.();
    void this.check();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const card of this.open.values()) {
      card.closedElsewhere = true;
      card.prompt.dismiss();
    }
    this.open.clear();
  }

  /** Looks for pending approvals now; one check at a time. */
  check(): Promise<void> {
    this.checking ??= this.checkOnce().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  private async checkOnce(): Promise<void> {
    const pending = await this.fetchPending();
    if (!pending) return;
    const ids = new Set(pending.map((approval) => approval.id));
    for (const [id, card] of this.open) {
      if (!ids.has(id)) {
        card.closedElsewhere = true;
        card.prompt.dismiss();
      }
    }
    for (const approval of pending) {
      if (!this.open.has(approval.id)) this.show(approval);
    }
  }

  /** The owner's pending approvals; null when signed out, offline or commerce is not set up. */
  private async fetchPending(): Promise<PendingApproval[] | null> {
    try {
      const response = await this.deps.account.authorizedFetch('/api/ulejra/commerce');
      if (!response.ok) return null;
      const body = (await response.json()) as { approvals?: PendingApproval[] };
      return (body.approvals ?? []).filter(
        (approval) => approval.status === 'pending' && !approval.autoApproved && typeof approval.id === 'string',
      );
    } catch {
      return null;
    }
  }

  private show(approval: PendingApproval): void {
    const card: OpenCard = { prompt: this.deps.prompt(describePayment(approval), 'payment'), closedElsewhere: false };
    this.open.set(approval.id, card);
    void card.prompt.decision.then(async (approved) => {
      this.open.delete(approval.id);
      if (card.closedElsewhere) return;
      await this.decide(approval, approved);
    });
  }

  private async decide(approval: PendingApproval, approved: boolean): Promise<void> {
    const what = typeof approval.amountMinor === 'number'
      ? `${approval.title} (${formatMinor(approval.amountMinor, approval.currency)})`
      : approval.title;
    try {
      const response = await this.deps.account.authorizedFetch(
        `/api/ulejra/commerce/approvals/${encodeURIComponent(approval.id)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ decision: approved ? 'approve' : 'decline' }),
        },
      );
      if (response.ok) {
        this.notice(`${approved ? 'Approved' : 'Declined'}: ${what}.`);
        return;
      }
      log.warn(`Approval decision answered ${response.status}`);
    } catch (error) {
      log.warn('Approval decision failed:', error instanceof Error ? error.message : String(error));
    }
    this.notice(`Could not record your decision on ${what}. Decide it in the Ulejra web app.`);
  }

  private notice(text: string): void {
    this.deps.panelManager.addChatMessage('wingman', text, undefined, {
      actorLabel: 'Ulejra',
      agentType: ULEJRA_PAYMENT_NOTICE_TYPE,
      notifyWebhook: false,
    });
  }
}
