import { apiCall, truncateToWords } from '../mcp/api-client';
import { wrapWithSecurityContext } from '../mcp/tools/_security-context';

/**
 * Browser tools for the Ulejra assistant: what the user's agent may do in the user's own browser,
 * through the same local API the MCP tools use (so the prompt-injection scanner, stealth and
 * scoping all apply). Reading, navigating, scrolling and searching a site's own search field run
 * straight away; clicking, filling other fields and key presses wait for the user's Approve.
 */

export interface BrowserToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

type Args = Record<string, unknown>;
type Call = (method: string, endpoint: string, body?: unknown) => Promise<unknown>;

interface BrowserTool {
  definition: BrowserToolDefinition;
  /** The approval card text, for tools the user must approve. */
  approval?: (args: Args) => string;
  run(args: Args, call: Call): Promise<string>;
}

/** Longest tool output sent to the model. */
const MAX_OUTPUT_CHARS = 12_000;
const MAX_QUERY_CHARS = 200;

/** A snapshot line: `- searchbox "Cari di Tokopedia" [@e21] value="…"`. */
const FIELD_LINE = /^\s*-\s*(searchbox|combobox|textbox)\s+"([^"]*)"[^\n]*?\[(@e\d+)\]/gim;
/** Field names that mean "search", in the languages Ulejra users write in. */
const SEARCH_NAME = /search|cari|telusur|pencarian|find|zoek|such|recherche|buscar|pesquis|cerca|搜索|検索|검색|بحث/i;

export interface SearchField {
  ref: string;
  role: string;
  name: string;
}

/** The search fields in a snapshot: role searchbox, or a text field whose name says search. */
export function findSearchFields(snapshot: string): SearchField[] {
  const fields: SearchField[] = [];
  for (const match of snapshot.matchAll(FIELD_LINE)) {
    const [, role, name, ref] = match;
    if (role.toLowerCase() === 'searchbox' || SEARCH_NAME.test(name)) {
      fields.push({ ref, role: role.toLowerCase(), name });
    }
  }
  return fields;
}

const PURPOSE = {
  type: 'string',
  description: 'One short sentence telling the user what this does and why. Shown on the approval card.',
};
const NO_SECRETS =
  'Never type passwords, card numbers, PINs or one-time codes: ask the user to type those themselves.';
const LOCATOR = {
  by: { type: 'string', enum: ['role', 'text', 'label', 'placeholder'], description: 'How to find the element' },
  value: { type: 'string', description: 'The role, visible text, label or placeholder to look for' },
};

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

function clip(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n[…cut, ${text.length - MAX_OUTPUT_CHARS} more characters]` : text;
}

function json(value: unknown): string {
  return clip(typeof value === 'string' ? value : JSON.stringify(value));
}

/** Only web pages: no file:, javascript:, data: or internal URLs. */
export function webUrl(raw: unknown): string {
  const text = str(raw).trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    throw new Error(`Not a valid web address: ${text || '(empty)'}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Only http and https web pages can be opened.');
  }
  return url.toString();
}

function card(action: string, args: Args, lines: Array<[string, unknown]>): string {
  const purpose = str(args.purpose);
  return [
    purpose ? `${action}: ${purpose}` : action,
    ...lines.filter(([, value]) => str(value)).map(([label, value]) => `${label}: ${str(value)}`),
  ].join('\n');
}

const tool = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): BrowserToolDefinition => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});

const TOOLS: BrowserTool[] = [
  {
    definition: tool(
      'browser_search',
      'Search on the current site: types the query into the page’s own search field and presses Enter. Runs without asking the user. Use it to find products, prices or information; use browser_fill only for other fields.',
      {
        query: { type: 'string', description: 'What to search for' },
        ref: { type: 'string', description: 'Optional @ref of the search field from browser_snapshot; the first search field is used otherwise' },
      },
      ['query'],
    ),
    async run(args, call) {
      const query = str(args.query).trim();
      if (!query || query.length > MAX_QUERY_CHARS) {
        throw new Error(`The search needs a query of 1 to ${MAX_QUERY_CHARS} characters.`);
      }
      const data = (await call('GET', '/snapshot?compact=true&interactive=true')) as Record<string, unknown>;
      if (data?.blocked === true) return clip(wrapWithSecurityContext(data, ''));
      const fields = findSearchFields(str(data.snapshot));
      const ref = str(args.ref);
      const field = ref ? fields.find((f) => f.ref === ref) : fields[0];
      if (!field) {
        throw new Error(
          ref
            ? `${ref} is not a search field. To type into other fields use browser_fill (the user approves it).`
            : 'This page has no search field. Open the site’s search page, or use browser_snapshot and browser_fill.',
        );
      }
      await call('POST', '/snapshot/fill', { ref: field.ref, value: query });
      await call('POST', '/press-key', { key: 'Enter' });
      await call('POST', '/wait', { timeout: 10_000 }).catch(() => undefined);
      return `Searched for "${query}" in ${field.name ? `"${field.name}"` : 'the search field'} (${field.ref}). Read the page or take a snapshot to see the results.`;
    },
  },
  {
    definition: tool('browser_navigate', 'Open a web page in the user’s active tab.', { url: { type: 'string', description: 'The web address' } }, ['url']),
    async run(args, call) {
      const url = webUrl(args.url);
      await call('POST', '/navigate', { url });
      return `Opened ${url}`;
    },
  },
  {
    definition: tool('browser_read_page', 'Read the active tab as text (title, address and up to 2000 words).', {}, []),
    async run(_args, call) {
      const data = (await call('GET', '/page-content')) as Record<string, unknown>;
      if (data?.blocked === true) return clip(wrapWithSecurityContext(data, ''));
      const text = [`Title: ${str(data.title) || 'Untitled'}`, `Address: ${str(data.url)}`, '', truncateToWords(str(data.text), 2000)].join('\n');
      return clip(wrapWithSecurityContext(data, text));
    },
  },
  {
    definition: tool(
      'browser_snapshot',
      'List the elements of the active tab with @ref ids (e.g. @e12) to click or fill. Use before browser_click and browser_fill.',
      { interactive_only: { type: 'boolean', description: 'Only buttons, links and fields (default true)' } },
      [],
    ),
    async run(args, call) {
      const params = new URLSearchParams({ compact: 'true' });
      if (args.interactive_only !== false) params.set('interactive', 'true');
      const data = (await call('GET', `/snapshot?${params.toString()}`)) as Record<string, unknown>;
      if (data?.blocked === true) return clip(wrapWithSecurityContext(data, ''));
      return clip(wrapWithSecurityContext(data, str(data.snapshot)));
    },
  },
  {
    definition: tool('browser_click', 'Click an element by its @ref from browser_snapshot. The user approves each click.', { ref: { type: 'string', description: 'The @ref, e.g. "@e12"' }, purpose: PURPOSE }, ['ref', 'purpose']),
    approval: (args) => card('Click', args, [['Element', args.ref]]),
    async run(args, call) {
      return json(await call('POST', '/snapshot/click', { ref: str(args.ref) }));
    },
  },
  {
    definition: tool(
      'browser_fill',
      `Fill a field by its @ref from browser_snapshot. The user approves each fill; for a site search use browser_search instead. ${NO_SECRETS}`,
      { ref: { type: 'string', description: 'The @ref, e.g. "@e3"' }, value: { type: 'string', description: 'The text to fill in' }, purpose: PURPOSE },
      ['ref', 'value', 'purpose'],
    ),
    approval: (args) => card('Fill in', args, [['Field', args.ref], ['Text', args.value]]),
    async run(args, call) {
      return json(await call('POST', '/snapshot/fill', { ref: str(args.ref), value: str(args.value) }));
    },
  },
  {
    definition: tool('browser_find_click', 'Find an element by role, text, label or placeholder and click it. The user approves each click.', { ...LOCATOR, purpose: PURPOSE }, ['by', 'value', 'purpose']),
    approval: (args) => card('Click', args, [['Element', `${str(args.by)} "${str(args.value)}"`]]),
    async run(args, call) {
      return json(await call('POST', '/find/click', { by: str(args.by), value: str(args.value) }));
    },
  },
  {
    definition: tool(
      'browser_find_fill',
      `Find a field by role, text, label or placeholder and fill it. The user approves each fill. ${NO_SECRETS}`,
      { ...LOCATOR, text: { type: 'string', description: 'The text to fill in' }, purpose: PURPOSE },
      ['by', 'value', 'text', 'purpose'],
    ),
    approval: (args) => card('Fill in', args, [['Field', `${str(args.by)} "${str(args.value)}"`], ['Text', args.text]]),
    async run(args, call) {
      return json(await call('POST', '/find/fill', { by: str(args.by), value: str(args.value), text: str(args.text) }));
    },
  },
  {
    definition: tool(
      'browser_press_key',
      'Press a key in the active tab, e.g. Enter, Tab, Escape, ArrowDown. The user approves each key press (Enter can submit a form); browser_search already presses Enter.',
      { key: { type: 'string', description: 'The key name' }, purpose: PURPOSE },
      ['key', 'purpose'],
    ),
    approval: (args) => card('Press key', args, [['Key', args.key]]),
    async run(args, call) {
      return json(await call('POST', '/press-key', { key: str(args.key) }));
    },
  },
  {
    definition: tool(
      'browser_scroll',
      'Scroll the active tab.',
      {
        direction: { type: 'string', enum: ['up', 'down'] },
        to: { type: 'string', enum: ['top', 'bottom'], description: 'Jump to the top or bottom instead' },
      },
      ['direction'],
    ),
    async run(args, call) {
      const body: Args = { direction: str(args.direction) === 'up' ? 'up' : 'down', amount: 600 };
      if (args.to === 'top' || args.to === 'bottom') body.target = args.to;
      await call('POST', '/scroll', body);
      return `Scrolled ${str(body.target) || str(body.direction)}`;
    },
  },
  {
    definition: tool('browser_go_back', 'Go back to the previous page in the active tab.', {}, []),
    async run(_args, call) {
      await call('POST', '/execute-js', { code: 'window.history.back()' });
      return 'Went back';
    },
  },
  {
    definition: tool('browser_wait_for_load', 'Wait until the active tab has finished loading (up to 10 seconds).', {}, []),
    async run(_args, call) {
      return json(await call('POST', '/wait', { timeout: 10_000 }));
    },
  },
  {
    definition: tool('browser_list_tabs', 'List the open tabs and which one is active.', {}, []),
    async run(_args, call) {
      return json(await call('GET', '/active-tab/context'));
    },
  },
  {
    definition: tool('browser_open_tab', 'Open a web page in a new tab.', { url: { type: 'string', description: 'The web address' } }, ['url']),
    async run(args, call) {
      const url = webUrl(args.url);
      return json(await call('POST', '/tabs/open', { url, source: 'ulejra' }));
    },
  },
  {
    definition: tool('browser_focus_tab', 'Switch to another open tab by its id from browser_list_tabs.', { tabId: { type: 'string' } }, ['tabId']),
    async run(args, call) {
      return json(await call('POST', '/tabs/focus', { tabId: str(args.tabId) }));
    },
  },
];

const BY_NAME = new Map(TOOLS.map((entry) => [entry.definition.function.name, entry]));

export interface BrowserToolbox {
  definitions: BrowserToolDefinition[];
  has(name: string): boolean;
  /** The approval card text when the user must approve this call; null when it runs straight away. */
  approvalFor(name: string, args: Args): string | null;
  /** Runs a call; failures come back as text for the model, never as a throw. */
  run(name: string, args: Args): Promise<string>;
}

export function createBrowserToolbox(call: Call = apiCall): BrowserToolbox {
  return {
    definitions: TOOLS.map((entry) => entry.definition),
    has: (name) => BY_NAME.has(name),
    approvalFor(name, args) {
      return BY_NAME.get(name)?.approval?.(args) ?? null;
    },
    async run(name, args) {
      const entry = BY_NAME.get(name);
      if (!entry) return JSON.stringify({ error: 'UNKNOWN_TOOL', message: `No browser tool named ${name}.` });
      try {
        return await entry.run(args, call);
      } catch (error) {
        return JSON.stringify({ error: 'FAILED', message: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}
