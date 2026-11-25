import { describe, expect, it, vi } from 'vitest';
import type { ConfigManager } from '../../config/manager';
import type { ChatMessage, PanelManager } from '../../panel/manager';
import { UlejraAccountError, type UlejraAccount } from '../account';
import { createBrowserToolbox, type BrowserToolbox } from '../browserTools';
import { ULEJRA_AGENT_TYPE, ULEJRA_NOTICE_TYPE, UlejraAssistant, buildConversation, describeApproval } from '../assistant';

vi.mock('../../mcp/api-client', () => ({ apiCall: vi.fn(), truncateToWords: (t: string) => t }));

vi.mock('../../utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

/** A PanelManager stand-in that stores messages and notifies listeners like the real one. */
function fakePanel() {
  const messages: ChatMessage[] = [];
  const listeners = new Set<(msg: ChatMessage) => void>();
  const typing: boolean[] = [];
  let id = 0;
  const panel = {
    addChatMessage: vi.fn((from: string, text: string, _image?: string, opts: { actorLabel?: string; agentType?: string } = {}) => {
      const msg: ChatMessage = { id: ++id, from, text, timestamp: id, actorLabel: opts.actorLabel, agentType: opts.agentType };
      messages.push(msg);
      for (const listener of listeners) listener(msg);
      return msg;
    }),
    getChatMessages: vi.fn((limit: number) => messages.slice(-limit)),
    onChatMessage: vi.fn((listener: (msg: ChatMessage) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    setWingmanTyping: vi.fn((value: boolean) => typing.push(value)),
  };
  return { panel: panel as unknown as PanelManager, messages, typing };
}

function reply(content: string, status = 200) {
  return new Response(JSON.stringify(status === 200 ? { message: { role: 'assistant', content } } : { error: content }), {
    status,
  });
}

function setup(
  authorizedFetch: ReturnType<typeof vi.fn>,
  config: { activeBackend?: string; assistantEnabled?: boolean } = {},
  requestApproval?: (description: string, signal: AbortSignal) => Promise<boolean>,
  browserTools?: BrowserToolbox,
) {
  const { panel, messages, typing } = fakePanel();
  const configManager = {
    getConfig: () => ({
      general: { activeBackend: config.activeBackend ?? 'tandem' },
      ulejra: { backendUrl: 'http://localhost:3080', assistantEnabled: config.assistantEnabled ?? true },
    }),
  } as unknown as ConfigManager;
  const stopListeners: Array<() => void> = [];
  const assistant = new UlejraAssistant({
    configManager,
    panelManager: panel,
    account: { authorizedFetch } as unknown as UlejraAccount,
    onEmergencyStop: (listener) => {
      stopListeners.push(listener);
      return () => undefined;
    },
    requestApproval,
    browserTools,
  });
  const say = (text: string) => panel.addChatMessage('user', text);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { assistant, messages, typing, say, settle, emergencyStop: () => stopListeners.forEach((l) => l()) };
}

const fromUlejra = (messages: ChatMessage[]) => messages.filter((m) => m.from === 'wingman');

describe('buildConversation', () => {
  it('keeps the user and Ulejra turns, drops notices and other agents, starts with the user', () => {
    const history: ChatMessage[] = [
      { id: 1, from: 'wingman', text: 'Emergency stop! 0 tasks stopped.', timestamp: 1 },
      { id: 2, from: 'wingman', text: 'earlier answer', timestamp: 2, agentType: ULEJRA_AGENT_TYPE },
      { id: 3, from: 'user', text: 'hello', timestamp: 3 },
      { id: 4, from: 'wingman', text: 'Sign in first', timestamp: 4, agentType: ULEJRA_NOTICE_TYPE },
      { id: 5, from: 'wingman', text: 'Hi! How can I help?', timestamp: 5, agentType: ULEJRA_AGENT_TYPE },
      { id: 6, from: 'wingman', text: 'from OpenClaw', timestamp: 6, agentType: 'openclaw' },
      { id: 7, from: 'user', text: 'cari harga beras', timestamp: 7 },
    ];
    expect(buildConversation(history)).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'Hi! How can I help?' },
      { role: 'user', content: 'cari harga beras' },
    ]);
  });
});

describe('buildConversation ordering', () => {
  it('has nothing to answer when the last turn is already an answer', () => {
    const history: ChatMessage[] = [
      { id: 1, from: 'user', text: 'hello', timestamp: 1 },
      { id: 2, from: 'wingman', text: 'Hi!', timestamp: 2, agentType: ULEJRA_AGENT_TYPE },
    ];
    expect(buildConversation(history)).toEqual([]);
  });
});

describe('UlejraAssistant', () => {
  it('answers a user message as Ulejra, with the typing indicator around it', async () => {
    const authorizedFetch = vi.fn(async () => reply('Halo! Saya Ulejra.'));
    const { messages, typing, say, settle } = setup(authorizedFetch);

    say('hello');
    await settle();

    const [path, init] = authorizedFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/ulejra/desktop/chat');
    expect(JSON.parse(init.body as string)).toEqual({ messages: [{ role: 'user', content: 'hello' }] });
    expect(fromUlejra(messages)).toMatchObject([
      { text: 'Halo! Saya Ulejra.', actorLabel: 'Ulejra', agentType: ULEJRA_AGENT_TYPE },
    ]);
    expect(typing).toEqual([true, false]);
  });

  it('stays quiet in another chat backend or when turned off', async () => {
    for (const config of [{ activeBackend: 'openclaw' }, { assistantEnabled: false }]) {
      const authorizedFetch = vi.fn(async () => reply('x'));
      const { messages, say, settle } = setup(authorizedFetch, config);
      say('hello');
      await settle();
      expect(authorizedFetch).not.toHaveBeenCalled();
      expect(fromUlejra(messages)).toEqual([]);
    }
  });

  it('points to Settings when not signed in, at most once every ten minutes', async () => {
    const authorizedFetch = vi.fn(async () => {
      throw new UlejraAccountError('signed_out', 'Sign in first');
    });
    const { messages, say, settle } = setup(authorizedFetch);

    say('hello');
    await settle();
    say('hello again');
    await settle();

    const notices = fromUlejra(messages);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ agentType: ULEJRA_NOTICE_TYPE });
    expect(notices[0].text).toContain('Settings');
  });

  it('says when the balance has run out', async () => {
    const { messages, say, settle } = setup(vi.fn(async () => reply('insufficient_balance', 402)));
    say('hello');
    await settle();
    expect(fromUlejra(messages)[0].text).toContain('balance has run out');
  });

  it('stops the request in flight on the emergency stop', async () => {
    const authorizedFetch = vi.fn(
      (_path: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const { messages, typing, say, settle, emergencyStop } = setup(authorizedFetch);

    say('open my bank');
    await settle();
    emergencyStop();
    await settle();

    expect(fromUlejra(messages)).toMatchObject([{ text: 'Stopped.', agentType: ULEJRA_NOTICE_TYPE }]);
    expect(typing).toEqual([true, false]);
  });

  it('answers once more, with the whole conversation, for a message sent while it was answering', async () => {
    let release!: () => void;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    const authorizedFetch = vi
      .fn()
      .mockImplementationOnce(async () => {
        await first;
        return reply('answer one');
      })
      .mockImplementationOnce(async () => reply('answer two'));
    const { messages, say, settle } = setup(authorizedFetch);

    say('first');
    await settle();
    say('second');
    release();
    await settle();
    await settle();

    expect(authorizedFetch).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse((authorizedFetch.mock.calls[1][1] as RequestInit).body as string);
    /** "answer one" answered "first", so it goes before "second", which is what is left to answer. */
    expect(secondBody.messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer one' },
      { role: 'user', content: 'second' },
    ]);
    expect(fromUlejra(messages).map((m) => m.text)).toEqual(['answer one', 'answer two']);
  });
});

describe('UlejraAssistant approvals', () => {
  const pendingTurn = {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'c9', type: 'function', function: { name: 'update_listing_price', arguments: '{}' } }],
  };
  const needsApproval = () =>
    new Response(
      JSON.stringify({
        message: pendingTurn,
        finishReason: 'approval_required',
        added: [pendingTurn],
        pendingApprovals: [
          {
            toolCallId: 'c9',
            name: 'update_listing_price',
            title: 'Change a listing price',
            details: { listing: 'Nasi goreng', new_price: '2.50 USD' },
          },
        ],
      }),
      { status: 200 },
    );

  it('describes an approval as the action and one line per detail', () => {
    expect(
      describeApproval({
        toolCallId: 'c9',
        name: 'update_listing_price',
        title: 'Change a listing price',
        details: { listing: 'Nasi goreng', new_price: '2.50 USD' },
      }),
    ).toBe('Change a listing price\nlisting: Nasi goreng\nnew price: 2.50 USD');
  });

  it('asks the user, then sends the decision back with what the server added', async () => {
    const authorizedFetch = vi
      .fn()
      .mockResolvedValueOnce(needsApproval())
      .mockResolvedValueOnce(reply('Done: Nasi goreng is now 2.50 USD.'));
    const requestApproval = vi.fn(async () => true);
    const { messages, say, settle } = setup(authorizedFetch, {}, requestApproval);

    say('set nasi goreng to 2.50');
    await settle();
    await settle();

    expect(requestApproval).toHaveBeenCalledWith(
      'Change a listing price\nlisting: Nasi goreng\nnew price: 2.50 USD',
      expect.any(AbortSignal),
    );
    const second = JSON.parse((authorizedFetch.mock.calls[1][1] as RequestInit).body as string);
    expect(second.approvals).toEqual({ c9: 'approve' });
    expect(second.messages).toEqual([{ role: 'user', content: 'set nasi goreng to 2.50' }, pendingTurn]);
    expect(fromUlejra(messages).map((m) => m.text)).toEqual(['Done: Nasi goreng is now 2.50 USD.']);
  });

  it('sends a rejection when the user declines', async () => {
    const authorizedFetch = vi
      .fn()
      .mockResolvedValueOnce(needsApproval())
      .mockResolvedValueOnce(reply('OK, I left the price as it was.'));
    const { say, settle } = setup(authorizedFetch, {}, vi.fn(async () => false));

    say('set nasi goreng to 2.50');
    await settle();
    await settle();

    const second = JSON.parse((authorizedFetch.mock.calls[1][1] as RequestInit).body as string);
    expect(second.approvals).toEqual({ c9: 'reject' });
  });
});

describe('UlejraAssistant in the browser', () => {
  const browserTurn = (calls: Array<{ id: string; name: string; args: Record<string, unknown> }>) => {
    const message = {
      role: 'assistant',
      content: '',
      tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })),
    };
    return new Response(JSON.stringify({ message, finishReason: 'tool_calls', added: [message] }), { status: 200 });
  };

  it('sends its browser tools, runs the calls, and sends the results back', async () => {
    const call = vi.fn(async () => ({ ok: true }));
    const authorizedFetch = vi
      .fn()
      .mockResolvedValueOnce(browserTurn([{ id: 'b1', name: 'browser_navigate', args: { url: 'tokopedia.com' } }]))
      .mockResolvedValueOnce(reply('Tokopedia is open.'));
    const { messages, say, settle } = setup(authorizedFetch, {}, vi.fn(), createBrowserToolbox(call));

    say('open tokopedia');
    await settle();
    await settle();

    const first = JSON.parse((authorizedFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(first.tools.map((t: { function: { name: string } }) => t.function.name)).toContain('browser_navigate');
    expect(call).toHaveBeenCalledWith('POST', '/navigate', { url: 'https://tokopedia.com/' });
    const second = JSON.parse((authorizedFetch.mock.calls[1][1] as RequestInit).body as string);
    expect(second.messages.slice(-1)[0]).toEqual({ role: 'tool', tool_call_id: 'b1', content: 'Opened https://tokopedia.com/' });
    expect(fromUlejra(messages).map((m) => m.text)).toEqual(['Tokopedia is open.']);
  });

  it('asks before a click and tells the model when the user declines, without clicking', async () => {
    const call = vi.fn(async () => ({ ok: true }));
    const requestApproval = vi.fn(async () => false);
    const authorizedFetch = vi
      .fn()
      .mockResolvedValueOnce(browserTurn([{ id: 'b2', name: 'browser_click', args: { ref: '@e7', purpose: 'Press Beli' } }]))
      .mockResolvedValueOnce(reply('OK, I did not click it.'));
    const { say, settle } = setup(authorizedFetch, {}, requestApproval, createBrowserToolbox(call));

    say('buy it');
    await settle();
    await settle();

    expect(requestApproval).toHaveBeenCalledWith('Click: Press Beli\nElement: @e7', expect.any(AbortSignal));
    expect(call).not.toHaveBeenCalled();
    const second = JSON.parse((authorizedFetch.mock.calls[1][1] as RequestInit).body as string);
    expect(JSON.parse(second.messages.slice(-1)[0].content).error).toBe('DECLINED');
  });

  it('clicks after the user approves', async () => {
    const call = vi.fn(async () => ({ completed: true }));
    const authorizedFetch = vi
      .fn()
      .mockResolvedValueOnce(browserTurn([{ id: 'b3', name: 'browser_click', args: { ref: '@e7', purpose: 'Open results' } }]))
      .mockResolvedValueOnce(reply('Done.'));
    const { say, settle } = setup(authorizedFetch, {}, vi.fn(async () => true), createBrowserToolbox(call));

    say('show results');
    await settle();
    await settle();

    expect(call).toHaveBeenCalledWith('POST', '/snapshot/click', { ref: '@e7' });
  });
});
