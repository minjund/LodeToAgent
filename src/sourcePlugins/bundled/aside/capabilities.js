'use strict';

const DOMAIN_TOKENS = new Set(['task', 'tasks', 'session', 'sessions', 'conversation', 'conversations', 'chat', 'chats', 'thread', 'threads']);
const IDENTITY_NAMES = new Set([
  'id', 'taskid', 'task_id', 'sessionid', 'session_id', 'conversationid', 'conversation_id',
  'threadid', 'thread_id', 'chatid', 'chat_id',
]);
const PROMPT_NAMES = new Set(['prompt', 'message', 'text', 'instruction', 'request', 'query', 'content', 'input']);
const CWD_NAMES = new Set(['cwd', 'directory', 'folder', 'path', 'workspace', 'workingdirectory', 'working_directory']);
const TITLE_NAMES = new Set(['title', 'name', 'label']);
const REASON_NAMES = new Set(['reason']);
const CURSOR_NAMES = new Set(['cursor', 'nextcursor', 'next_cursor', 'after']);
const LIMIT_NAMES = new Set(['limit', 'count', 'pagesize', 'page_size', 'maxresults', 'max_results']);

const DEFINITIONS = Object.freeze({
  list: { verbs: ['list', 'search', 'recent', 'find', 'browse', 'enumerate'], identity: false, prompt: false },
  detail: { verbs: ['get', 'read', 'detail', 'show', 'fetch', 'inspect'], identity: true, prompt: false },
  start: { verbs: ['create', 'new', 'start', 'launch', 'begin'], identity: false, prompt: true },
  send: { verbs: ['continue', 'send', 'message', 'prompt', 'instruct', 'reply', 'resume'], identity: true, prompt: true },
  stop: { verbs: ['stop', 'cancel', 'interrupt', 'abort'], identity: true, prompt: false },
  archive: { verbs: ['archive'], identity: true, prompt: false },
  delete: { verbs: ['delete', 'remove'], identity: true, prompt: false },
});

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function nameTokens(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function normalizedPropertyName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
}

function propertyRole(name, operation) {
  const normalized = normalizedPropertyName(name);
  const compact = normalized.replace(/_/g, '');
  if (IDENTITY_NAMES.has(normalized) || IDENTITY_NAMES.has(compact)) return 'identity';
  if (PROMPT_NAMES.has(normalized) || PROMPT_NAMES.has(compact)) return 'prompt';
  if (operation === 'start' && (normalized === 'task' || normalized === 'description')) return 'prompt';
  if (CWD_NAMES.has(normalized) || CWD_NAMES.has(compact)) return 'cwd';
  if (TITLE_NAMES.has(normalized) || TITLE_NAMES.has(compact)) return 'title';
  if (REASON_NAMES.has(normalized) || REASON_NAMES.has(compact)) return 'reason';
  if (CURSOR_NAMES.has(normalized) || CURSOR_NAMES.has(compact)) return 'cursor';
  if (LIMIT_NAMES.has(normalized) || LIMIT_NAMES.has(compact)) return 'limit';
  return '';
}

function schemaSupportsRole(role, schema = {}) {
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (!types.length) return true;
  if (['identity', 'prompt', 'cwd', 'title', 'reason', 'cursor'].includes(role)) return types.includes('string');
  if (role === 'limit') return types.includes('integer') || types.includes('number');
  return false;
}

function operationNameMatches(name, operation) {
  const tokens = nameTokens(name);
  if (!tokens.some(token => DOMAIN_TOKENS.has(token))) return false;
  const definition = DEFINITIONS[operation];
  const hasVerb = definition.verbs.some(verb => tokens.includes(verb));
  const pluralGet = operation === 'list' && tokens.includes('get')
    && tokens.some(token => ['tasks', 'sessions', 'conversations', 'chats', 'threads'].includes(token));
  if (!hasVerb && !pluralGet) return false;
  const safeFillers = new Set([
    ...DOMAIN_TOKENS,
    ...definition.verbs,
    'aside', 'browser', 'mcp', 'by', 'id', 'with', 'to',
    ...(operation === 'list' ? ['get', 'all', 'current', 'active'] : []),
    ...(operation === 'detail' ? ['details'] : []),
  ]);
  // A tool must describe the whole task/session operation, not an adjacent
  // resource such as task attachments, credentials, or browser storage.
  return tokens.every(token => safeFillers.has(token));
}

function inspectSchema(tool, operation) {
  const schema = tool && (tool.inputSchema || tool.input_schema);
  if (!plainObject(schema)) return { valid: false, reason: 'missing inputSchema' };
  if (schema.type && schema.type !== 'object') return { valid: false, reason: 'inputSchema is not an object' };
  const properties = plainObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
  const roles = {};
  for (const [name, propertySchema] of Object.entries(properties)) {
    const role = propertyRole(name, operation);
    const normalizedSchema = plainObject(propertySchema) ? propertySchema : {};
    if (role && schemaSupportsRole(role, normalizedSchema)
      && (!roles[role] || (required.includes(name) && !required.includes(roles[role].name)))) {
      roles[role] = { name, schema: normalizedSchema };
    }
  }

  const definition = DEFINITIONS[operation];
  if (definition.identity && !roles.identity) return { valid: false, reason: 'no task/session identifier input' };
  if (definition.prompt && !roles.prompt) return { valid: false, reason: 'no prompt/message input' };
  if (operation === 'list' && required.some(name => propertyRole(name, operation) === 'identity')) {
    return { valid: false, reason: 'list tool requires a task/session identifier' };
  }

  const supportedRequiredRoles = new Set({
    list: ['limit'],
    detail: ['identity'],
    start: ['prompt', 'cwd', 'title'],
    send: ['identity', 'prompt'],
    stop: ['identity'],
    archive: ['identity'],
    delete: ['identity'],
  }[operation]);
  for (const name of required) {
    const role = propertyRole(name, operation);
    if (!role || !supportedRequiredRoles.has(role)) {
      return { valid: false, reason: `unsupported required input: ${name}` };
    }
  }

  return { valid: true, schema, properties, required, roles };
}

function descriptorFor(tool, operation) {
  if (!tool || typeof tool.name !== 'string' || !operationNameMatches(tool.name, operation)) return null;
  const inspected = inspectSchema(tool, operation);
  if (!inspected.valid) return null;
  const tokens = nameTokens(tool.name);
  const score = 10
    + (tokens.some(token => DEFINITIONS[operation].verbs.includes(token)) ? 4 : 0)
    + (inspected.required.length === 0 ? 1 : 0)
    + (inspected.roles.identity ? 1 : 0)
    + (inspected.roles.prompt ? 1 : 0);
  return {
    operation,
    name: tool.name,
    description: String(tool.description || ''),
    inputSchema: inspected.schema,
    required: inspected.required,
    roles: inspected.roles,
    score,
  };
}

function discoverAsideTools(tools) {
  const validTools = Array.isArray(tools) ? tools.filter(tool => plainObject(tool) && typeof tool.name === 'string') : [];
  const operations = {};
  for (const operation of Object.keys(DEFINITIONS)) {
    const matches = validTools
      .map(tool => descriptorFor(tool, operation))
      .filter(Boolean)
      .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
    operations[operation] = matches[0] || null;
  }
  return {
    operations,
    capabilities: {
      list: Boolean(operations.list),
      detail: Boolean(operations.detail),
      start: Boolean(operations.start),
      sendInstruction: Boolean(operations.send),
      stop: Boolean(operations.stop),
      archive: Boolean(operations.archive),
      delete: Boolean(operations.delete),
    },
    toolNames: validTools.map(tool => tool.name),
  };
}

function firstValue(input, names) {
  for (const name of names) {
    if (input[name] !== undefined && input[name] !== null && input[name] !== '') return input[name];
  }
  return undefined;
}

function valueForRole(role, input) {
  if (role === 'identity') return firstValue(input, ['taskId', 'sessionId', 'externalId', 'id']);
  if (role === 'prompt') return firstValue(input, ['prompt', 'message', 'text', 'instruction']);
  if (role === 'cwd') return firstValue(input, ['cwd', 'directory', 'folder']);
  if (role === 'title') {
    const explicit = firstValue(input, ['title', 'name']);
    if (explicit !== undefined) return explicit;
    const prompt = firstValue(input, ['prompt', 'message', 'text', 'instruction']);
    return prompt === undefined ? undefined : String(prompt).replace(/\s+/g, ' ').trim().slice(0, 80);
  }
  if (role === 'reason') return firstValue(input, ['reason']);
  if (role === 'cursor') return firstValue(input, ['cursor']);
  if (role === 'limit') return firstValue(input, ['limit']);
  return undefined;
}

function validateSchemaValue(name, value, schema) {
  const type = schema && schema.type;
  if (type === 'string' && typeof value !== 'string') return String(value);
  if ((type === 'number' || type === 'integer') && typeof value !== 'number') {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw new TypeError(`Aside MCP input ${name} must be numeric.`);
    return type === 'integer' ? Math.trunc(numeric) : numeric;
  }
  if (type === 'boolean' && typeof value !== 'boolean') {
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new TypeError(`Aside MCP input ${name} must be boolean.`);
  }
  if (Array.isArray(schema && schema.enum) && !schema.enum.includes(value)) {
    throw new TypeError(`Aside MCP input ${name} is not an allowed value.`);
  }
  return value;
}

function boundedRoleValue(role, value) {
  if (value === undefined) return value;
  if (role === 'limit') {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 1 || numeric > 1000) {
      const error = new TypeError('Aside MCP list limit must be between 1 and 1000.');
      error.code = 'ASIDE_INPUT_INVALID';
      throw error;
    }
    return numeric;
  }
  const limits = { identity: 500, prompt: 120_000, cwd: 32_768, title: 500, reason: 2_000, cursor: 2_000 };
  const text = String(value);
  if (!text || text.length > (limits[role] || 2_000) || /\u0000/.test(text)
    || (role === 'identity' && /[\u0000-\u001f\u007f]/.test(text))) {
    const error = new TypeError(`Aside MCP input for ${role || 'unknown'} is invalid.`);
    error.code = 'ASIDE_INPUT_INVALID';
    throw error;
  }
  return text;
}

function buildAsideToolArguments(descriptor, input = {}) {
  if (!descriptor || !descriptor.roles) {
    const error = new Error('Aside MCP capability is unavailable.');
    error.code = 'ASIDE_CAPABILITY_UNAVAILABLE';
    throw error;
  }
  const args = {};
  for (const [role, property] of Object.entries(descriptor.roles)) {
    const value = boundedRoleValue(role, valueForRole(role, input));
    if (value !== undefined) args[property.name] = validateSchemaValue(property.name, value, property.schema);
  }
  for (const requiredName of descriptor.required || []) {
    if (args[requiredName] === undefined) {
      const property = descriptor.inputSchema && descriptor.inputSchema.properties
        && descriptor.inputSchema.properties[requiredName] || {};
      const role = propertyRole(requiredName, descriptor.operation);
      const value = boundedRoleValue(role, valueForRole(role, input));
      if (role && value !== undefined) args[requiredName] = validateSchemaValue(requiredName, value, property);
      else {
        const error = new Error(`Aside MCP tool ${descriptor.name} requires ${requiredName}.`);
        error.code = 'ASIDE_INPUT_REQUIRED';
        throw error;
      }
    }
  }
  return args;
}

function unavailableCapability(action) {
  const error = new Error(`Aside does not expose an official ${action} task tool in this installation.`);
  error.code = 'ASIDE_CAPABILITY_UNAVAILABLE';
  error.action = action;
  return error;
}

module.exports = {
  DEFINITIONS,
  buildAsideToolArguments,
  descriptorFor,
  discoverAsideTools,
  inspectSchema,
  nameTokens,
  operationNameMatches,
  schemaSupportsRole,
  unavailableCapability,
};
