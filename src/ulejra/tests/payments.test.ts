import { describe, expect, it, vi } from 'vitest';
import type { PanelManager } from '../../panel/manager';
import type { UlejraAccount } from '../account';
import { UlejraPaymentApprovals, describePayment, formatMinor } from '../payments';
import type { ApprovalPrompter } from '../prompter';
import { askWithTimeout } from '../prompter';

vi.mock('../../utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const purchase = {
  id: 'ap1',
  kind: 'purchase',
  status: 'pending',
  title: 'Nasi goreng x2',
  amountMinor: 2500,
  currency: 'USD',
  counterpartyHandle: 'warung-sari',
  autoApproved: false,
};

const overview = (approvals: unknown[]) => new Response(JSON.stringify({ approvals }), { status: 200 });

/** Approval cards the test answers by hand. */
function cards() {
  const open: Array<{ description: string; answer: (approved: boolean) => void; dismissed: boolean }> = [];
  const prompt: ApprovalPrompter = (description) => {
    let answer!: (approved: boolean) => void;
    const decision = new Promise<boolean>((resolve) => {
      answer = resolve;
    });
    const card = { description, answer, dismissed: false };
    open.push(card);
    return {
      decision,
      dismiss: () => {
        card.dismissed = true;
        answer(false);
      },
    };
  };
  return { open, prompt };
}

function setup(responses: Response[]) {
  const authorizedFetch = vi.fn(async () => responses.shift() ?? overview([]));
  const notices: string[] = [];
  const panelManager = {
    addChatMessage: vi.fn((_from: string, text: string) => notices.push(text)),
  } as unknown as PanelManager;
  const { open, prompt } = cards();
  const payments = new UlejraPaymentApprovals({
    account: { authorizedFetch } as unknown as UlejraAccount,
    panelManager,
    prompt,
  });
  return { payments, authorizedFetch, notices, open };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('payment approval cards', () => {
  it('describes the payment: what, how much, with whom', () => {
    expect(formatMinor(2500, 'USD')).toBe('25.00 USD');
    expect(describePayment(purchase)).toBe('Pay for a purchase: Nasi goreng x2\nAmount: 25.00 USD\nWith: @warung-sari');
  });

  it('shows one card per pending approval and sends the user’s Approve', async () => {
    const { payments, authorizedFetch, notices, open } = setup([
      overview([purchase, { ...purchase, id: 'auto', autoApproved: true }, { ...purchase, id: 'old', status: 'approved' }]),
      new Response('{}', { status: 200 }),
    ]);

    await payments.check();
    expect(open.map((c) => c.description)).toEqual([describePayment(purchase)]);

    open[0].answer(true);
    await flush();
    await flush();

    expect(authorizedFetch).toHaveBeenLastCalledWith('/api/ulejra/commerce/approvals/ap1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(notices).toEqual(['Approved: Nasi goreng x2 (25.00 USD).']);
  });

  it('sends a decline when the user rejects', async () => {
    const { payments, authorizedFetch, open } = setup([overview([purchase]), new Response('{}', { status: 200 })]);
    await payments.check();
    open[0].answer(false);
    await flush();
    await flush();
    expect(JSON.parse((authorizedFetch.mock.calls[1] as unknown as [string, RequestInit])[1].body as string)).toEqual({
      decision: 'decline',
    });
  });

  it('does not show the same approval twice', async () => {
    const { payments, open } = setup([overview([purchase]), overview([purchase])]);
    await payments.check();
    await payments.check();
    expect(open).toHaveLength(1);
  });

  it('closes the card without deciding anything when the approval was decided in the web app', async () => {
    const { payments, authorizedFetch, notices, open } = setup([overview([purchase]), overview([])]);
    await payments.check();
    await payments.check();
    await flush();

    expect(open[0].dismissed).toBe(true);
    expect(authorizedFetch).toHaveBeenCalledTimes(2);
    expect(authorizedFetch.mock.calls.every(([path]) => path === '/api/ulejra/commerce')).toBe(true);
    expect(notices).toEqual([]);
  });

  it('stays quiet when signed out or offline', async () => {
    const { payments, authorizedFetch, open, notices } = setup([]);
    authorizedFetch.mockRejectedValue(new Error('signed out'));
    await payments.check();
    expect(authorizedFetch).toHaveBeenCalledTimes(1);
    expect(open).toEqual([]);
    expect(notices).toEqual([]);
  });
});

describe('askWithTimeout', () => {
  it('closes an unanswered action card on stop and counts it as no', async () => {
    const { open, prompt } = cards();
    const controller = new AbortController();
    const answer = askWithTimeout(prompt, 'Click: Beli', controller.signal);
    controller.abort();
    expect(await answer).toBe(false);
    expect(open[0].dismissed).toBe(true);
  });

  it('closes an unanswered action card after the timeout', async () => {
    vi.useFakeTimers();
    const { open, prompt } = cards();
    const answer = askWithTimeout(prompt, 'Click: Beli', new AbortController().signal, 1000);
    vi.advanceTimersByTime(1000);
    expect(await answer).toBe(false);
    expect(open[0].dismissed).toBe(true);
    vi.useRealTimers();
  });
});
