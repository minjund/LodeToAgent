'use strict';

const PROVIDERS = Object.freeze({
  claude: {
    id: 'claude',
    label: 'Claude',
    company: 'Anthropic',
    command: 'claude',
    accent: '#d97757',
    mark: 'CL',
    historyHint: '~/.claude/projects',
    docs: 'https://code.claude.com/docs/en/headless',
  },
  codex: {
    id: 'codex',
    label: 'GPT',
    company: 'OpenAI · Codex',
    command: 'codex',
    accent: '#10a37f',
    mark: 'GPT',
    historyHint: '~/.codex/sessions',
    docs: 'https://developers.openai.com/codex/codex-manual.md',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    company: 'Google',
    command: 'gemini',
    accent: '#8ab4f8',
    mark: 'GM',
    historyHint: '~/.gemini/tmp/*/chats',
    docs: 'https://geminicli.com/docs/cli/headless/',
  },
  grok: {
    id: 'grok',
    label: 'Grok',
    company: 'xAI',
    command: 'grok',
    accent: '#f4f4f5',
    mark: 'X',
    historyHint: '~/.grok/sessions',
    docs: 'https://docs.x.ai/build/cli/headless-scripting',
  },
});

function providerList() {
  return Object.values(PROVIDERS).map(item => ({ ...item }));
}

function normalizeProvider(value) {
  const raw = String(value || '').toLowerCase();
  if (raw.includes('anthropic') || raw.includes('claude')) return 'claude';
  if (raw.includes('openai') || raw.includes('codex') || raw === 'gpt') return 'codex';
  if (raw.includes('google') || raw.includes('gemini')) return 'gemini';
  if (raw.includes('xai') || raw.includes('grok')) return 'grok';
  return PROVIDERS[raw] ? raw : 'codex';
}

function modelContextWindow(provider, model, observed) {
  const exact = Number(observed || 0);
  if (Number.isFinite(exact) && exact > 0) return { tokens: exact, source: 'session' };
  const id = String(model || '').toLowerCase();

  if (provider === 'claude') {
    if (/opus-4-[678]|sonnet-(?:4-6|5)|fable-5|mythos/.test(id)) {
      return { tokens: 1_000_000, source: 'model-catalog' };
    }
    return { tokens: 200_000, source: 'model-catalog' };
  }

  if (provider === 'codex') {
    if (/gpt-5\.(?:4|5)(?:$|-|\b)/.test(id)) return { tokens: 1_050_000, source: 'model-catalog' };
    if (/gpt-5\.4-mini/.test(id)) return { tokens: 400_000, source: 'model-catalog' };
    return { tokens: 0, source: 'unknown' };
  }

  if (provider === 'gemini') {
    if (/gemini/.test(id)) return { tokens: 1_048_576, source: 'model-catalog' };
    return { tokens: 0, source: 'unknown' };
  }

  if (provider === 'grok') {
    if (/grok-build/.test(id)) return { tokens: 256_000, source: 'model-catalog' };
    if (/grok-4\.5/.test(id)) return { tokens: 500_000, source: 'model-catalog' };
    if (/grok-4\.(?:3|20)/.test(id)) return { tokens: 1_000_000, source: 'model-catalog' };
    return { tokens: 0, source: 'unknown' };
  }

  return { tokens: 0, source: 'unknown' };
}

function blankUsage() {
  return {
    input: 0,
    cachedInput: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    total: 0,
  };
}

function finalizeUsage(raw = {}) {
  const usage = blankUsage();
  for (const key of Object.keys(usage)) {
    const value = Number(raw[key] || 0);
    usage[key] = Number.isFinite(value) && value > 0 ? value : 0;
  }
  if (!usage.total) usage.total = usage.input + usage.output + usage.reasoning;
  return usage;
}

module.exports = {
  PROVIDERS,
  providerList,
  normalizeProvider,
  modelContextWindow,
  blankUsage,
  finalizeUsage,
};
