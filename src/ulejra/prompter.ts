import type { TaskManager } from '../agents/task-manager';

/**
 * Wingman approval cards for Ulejra: one card per question, answered only by the user's click.
 * `dismiss` closes a card without a decision the caller acts on (it resolves `decision` false,
 * and the caller knows it dismissed it).
 */

export type ApprovalCardKind = 'action' | 'payment';

export interface ApprovalPrompt {
  decision: Promise<boolean>;
  dismiss(): void;
}

export type ApprovalPrompter = (description: string, kind: ApprovalCardKind) => ApprovalPrompt;

export function createApprovalPrompter(taskManager: TaskManager): ApprovalPrompter {
  return (description, kind) => {
    const task = taskManager.createTask(description, 'claude', 'claude', [{
      description,
      action: { type: kind === 'payment' ? 'ulejra_payment' : 'ulejra_tool', params: {} },
      riskLevel: 'high',
      requiresApproval: true,
    }]);
    const stepId = task.steps[0].id;
    let settled = false;
    const decision = taskManager.requestApproval(task, 0).finally(() => {
      settled = true;
    });
    return {
      decision,
      dismiss: () => {
        if (!settled) taskManager.respondToApproval(task.id, stepId, false);
      },
    };
  };
}

/**
 * An approval card for an assistant action that closes itself, unanswered, after `timeoutMs` or
 * when `signal` aborts; both count as no.
 */
export function askWithTimeout(
  prompt: ApprovalPrompter,
  description: string,
  signal: AbortSignal,
  timeoutMs = 5 * 60_000,
): Promise<boolean> {
  const card = prompt(description, 'action');
  const timer = setTimeout(() => card.dismiss(), timeoutMs);
  const onAbort = () => card.dismiss();
  signal.addEventListener('abort', onAbort, { once: true });
  return card.decision.then((approved) => {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    return approved && !signal.aborted;
  });
}
