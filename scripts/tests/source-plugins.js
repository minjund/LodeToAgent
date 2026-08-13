'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ASIDE_MANIFEST, OMO_MANIFEST } = require('../../src/sourcePlugins/bundled');
const {
  canonicalSessionId,
  normalizeSourceSession,
} = require('../../src/sourcePlugins/contracts');
const {
  DELETE_TOKEN_TTL_MS,
  SourcePluginControlHost,
} = require('../../src/sourcePlugins/controlHost');
const { SourcePluginMonitorHost } = require('../../src/sourcePlugins/monitorHost');
const { discoverAsideTools } = require('../../src/sourcePlugins/bundled/aside/capabilities');
const { OmoOpenCodeMonitor } = require('../../src/sourcePlugins/bundled/omo');
const { enrichSession } = require('../../src/sessionIntelligence');
const {
  McpStdioClient,
  createMessageParser,
  encodeJsonRpcMessage,
} = require('../../src/sourcePlugins/mcpClient');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (_unsupportedRuntime) {
  // The product reports node:sqlite as unavailable on older Node runtimes.
}

function registerSourcePluginTests(context) {
  const { root, temp, test } = context;

  test('source plugin manifest와 canonical ID가 출처·모델·환경·런타임을 분리한다', () => {
    assert.equal(Object.isFrozen(OMO_MANIFEST), true);
    assert.equal(Object.isFrozen(ASIDE_MANIFEST), true);
    assert.notEqual(OMO_MANIFEST.id, ASIDE_MANIFEST.id);
    assert.notEqual(OMO_MANIFEST.source.id, ASIDE_MANIFEST.source.id);
    assert.equal(canonicalSessionId(OMO_MANIFEST.id, 'shared-id'), 'builtin.omo:shared-id');
    assert.equal(canonicalSessionId(ASIDE_MANIFEST.id, 'shared-id'), 'builtin.aside:shared-id');

    const normalized = normalizeSourceSession({
      externalId: 'shared-id',
      title: 'fixture',
      modelProvider: 'openai',
      modelProviderLabel: 'OpenAI',
      environment: { kind: 'windows', label: 'Windows' },
      provenance: { runtime: { kind: 'opencode', label: 'OpenCode' } },
      updatedAt: '2026-08-13T00:00:00.000Z',
    }, OMO_MANIFEST, { platform: 'win32' });

    assert.equal(normalized.id, 'builtin.omo:shared-id');
    assert.equal(normalized.provenance.source.id, 'omo');
    assert.equal(normalized.provenance.provider.id, 'openai');
    assert.equal(normalized.provenance.environment.kind, 'windows');
    assert.equal(normalized.provenance.runtime.kind, 'opencode');
    assert.equal(normalized.provenance.runtime.label, 'OpenCode');
  });

  test('OMO OpenCode SQLite fixture가 부모·모델 제공자·대화·도구·산출물을 복원한다', () => {
    if (!DatabaseSync) return;
    const dbFile = path.join(temp, 'source-plugin-opencode.db');
    const fixtureCwd = path.join(temp, 'omo-workspace');
    fs.mkdirSync(fixtureCwd, { recursive: true });
    const db = new DatabaseSync(dbFile);
    try {
      db.exec(`
        CREATE TABLE session (
          id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT,
          directory TEXT, title TEXT, version TEXT,
          summary_additions INTEGER, summary_deletions INTEGER,
          summary_files INTEGER, summary_diffs TEXT,
          time_created INTEGER, time_updated INTEGER,
          time_compacting INTEGER, time_archived INTEGER
        );
        CREATE TABLE message (
          id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER,
          time_updated INTEGER, data TEXT
        );
        CREATE TABLE part (
          id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
          time_created INTEGER, time_updated INTEGER, data TEXT
        );
      `);
      const base = 1_760_000_000_000;
      const insertSession = db.prepare(`
        INSERT INTO session (
          id, project_id, parent_id, slug, directory, title, version,
          summary_additions, summary_deletions, summary_files, summary_diffs,
          time_created, time_updated, time_compacting, time_archived
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertSession.run(
        'ses-parent', 'project-fixture', null, 'parent', fixtureCwd, 'Parent fixture', '1',
        4, 1, 1, '[]', base, base + 9_000, null, null,
      );
      insertSession.run(
        'ses-child', 'project-fixture', 'ses-parent', 'child', fixtureCwd, 'Child fixture', '1',
        0, 0, 0, '[]', base + 4_000, base + 8_000, null, null,
      );

      const insertMessage = db.prepare(
        'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)',
      );
      insertMessage.run('msg-parent-user', 'ses-parent', base, base, JSON.stringify({
        role: 'user', time: { created: base }, model: { providerID: 'openai', modelID: 'gpt-fixture' },
      }));
      insertMessage.run('msg-parent-assistant', 'ses-parent', base + 1_000, base + 9_000, JSON.stringify({
        role: 'assistant', agent: '\u200BHephaestus', providerID: 'openai', modelID: 'gpt-fixture',
        finish: 'stop', time: { created: base + 1_000, completed: base + 9_000 },
        tokens: { input: 10, output: 5 },
      }));
      insertMessage.run('msg-child-user', 'ses-child', base + 4_000, base + 4_000, JSON.stringify({
        role: 'user', time: { created: base + 4_000 }, model: { providerID: 'anthropic', modelID: 'claude-fixture' },
      }));
      insertMessage.run('msg-child-assistant', 'ses-child', base + 5_000, base + 8_000, JSON.stringify({
        role: 'assistant', agent: 'librarian', providerID: 'anthropic', modelID: 'claude-fixture',
        finish: 'stop', time: { created: base + 5_000, completed: base + 8_000 },
      }));

      const insertPart = db.prepare(
        'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)',
      );
      const part = (id, messageId, sessionId, created, data) => insertPart.run(
        id, messageId, sessionId, created, data.state?.time?.end || created, JSON.stringify(data),
      );
      part('part-user-text', 'msg-parent-user', 'ses-parent', base, {
        type: 'text', text: 'Create the deterministic fixture.',
      });
      part('part-assistant-text', 'msg-parent-assistant', 'ses-parent', base + 8_000, {
        type: 'text', text: 'The deterministic fixture is complete.',
      });
      part('part-shell', 'msg-parent-assistant', 'ses-parent', base + 2_000, {
        type: 'tool', tool: 'bash', callID: 'call-shell',
        state: {
          status: 'completed', input: { command: 'npm test' }, output: 'fixture tests passed',
          time: { start: base + 2_000, end: base + 3_000 }, metadata: { exit: 0 },
        },
      });
      part('part-patch', 'msg-parent-assistant', 'ses-parent', base + 3_000, {
        type: 'tool', tool: 'apply_patch', callID: 'call-patch',
        state: {
          status: 'completed', input: {},
          time: { start: base + 3_000, end: base + 3_500 },
          metadata: { files: [{ relativePath: 'src/result.js', type: 'update' }] },
        },
      });
      part('part-task', 'msg-parent-assistant', 'ses-parent', base + 4_000, {
        type: 'tool', tool: 'task', callID: 'call-task',
        state: {
          status: 'completed', input: { description: 'Inspect fixture', prompt: 'Inspect only the fixture.' },
          time: { start: base + 4_000, end: base + 8_000 },
          metadata: { sessionId: 'ses-child', agent: 'librarian' },
        },
      });
      part('part-child-user-text', 'msg-child-user', 'ses-child', base + 4_000, {
        type: 'text', text: 'Inspect the fixture.',
      });
      part('part-child-assistant-text', 'msg-child-assistant', 'ses-child', base + 7_000, {
        type: 'text', text: 'Fixture inspected.',
      });
    } finally {
      db.close();
    }

    const monitor = new OmoOpenCodeMonitor({
      dbPath: dbFile,
      DatabaseSync,
      omoConfigured: true,
      platform: 'linux',
      arch: 'x64',
      now: () => 1_760_000_100_000,
    });
    try {
      const sessions = monitor.scan({ limit: 10 });
      assert.equal(sessions.length, 2);
      const parent = sessions.find(session => session.externalId === 'ses-parent');
      const child = sessions.find(session => session.externalId === 'ses-child');
      assert.ok(parent);
      assert.ok(child);
      assert.equal(child.parentId, parent.id);
      assert.equal(parent.childIds.includes(child.id), true);
      assert.equal(parent.collaboration.spawns.some(spawn => spawn.childId === child.id), true);
      assert.equal(parent.modelProvider, 'openai');
      assert.equal(child.modelProvider, 'anthropic');
      assert.deepEqual(parent.messages.map(message => message.role), ['user', 'assistant']);
      assert.equal(parent.messages[1].text, 'The deterministic fixture is complete.');
      assert.equal(parent.executions.some(execution => execution.command === 'npm test' && execution.status === 'completed'), true);
      assert.equal(parent.artifacts.some(artifact => artifact.name === 'result.js'), true);
      const enrichedParent = enrichSession(parent, sessions, 1_760_000_100_000);
      assert.equal(enrichedParent.outcome.artifacts.some(artifact => artifact.value.endsWith('result.js')), true);
      assert.equal(parent.provenance.source.id, 'omo');
      assert.equal(parent.provenance.provider.id, 'openai');
      assert.equal(parent.provenance.runtime.kind, 'opencode');
    } finally {
      monitor.close();
    }
  });

  test('Aside 선택 폴더 기록은 전역 기능이 켜져 있어도 control host에서 읽기 전용이다', async () => {
    const host = new SourcePluginControlHost({ platform: 'darwin', findExecutable: () => null });
    let calls = 0;
    host.aside = { control: async () => { calls += 1; return { accepted: true }; } };
    host.statuses.set(ASIDE_MANIFEST.id, {
      capabilities: { sendInstruction: true, stop: true, archive: true, delete: true },
      controlUnavailableReasons: {},
    });
    const folderSession = {
      id: 'builtin.aside:folder-fixture',
      externalId: 'folder-fixture',
      sourcePluginId: ASIDE_MANIFEST.id,
      readOnly: true,
      controlAuthority: 'read-only-import',
      sourceControlCapabilities: { sendInstruction: false, stop: false, archive: false, delete: false },
      sourcePlugin: { revision: 'folder-r1' },
      updatedAt: '2026-08-13T00:00:00.000Z',
    };

    await assert.rejects(
      host.control(folderSession, 'send', { prompt: 'must not be sent' }),
      /읽기 전용|공식 Aside/,
    );
    assert.throws(() => host.prepareDelete(folderSession), /읽기 전용|공식 Aside/);
    assert.equal(calls, 0);
  });

  test('Aside CLI가 있어도 macOS 15 미만이면 시작과 제어를 fail closed한다', async () => {
    const host = new SourcePluginControlHost({
      platform: 'darwin',
      findExecutable: name => name === 'aside' ? '/fixture/aside' : '',
    });
    host.createAsideController = async () => ({
      probe: async () => ({
        available: false,
        platformSupported: false,
        reason: 'Aside Browser requires macOS 15 or newer.',
        capabilities: {},
      }),
      dispose: async () => {},
    });
    await host.refresh();
    const status = host.listSources().find(item => item.id === ASIDE_MANIFEST.id);
    assert.equal(status.installed, true);
    assert.equal(status.available, false);
    assert.equal(status.capabilities.start, false);
    assert.match(status.reason, /macOS 15/);
    await host.dispose();
  });

  test('LoadToAgent가 실행한 OMO 세션만 관찰된 stop 권한을 활성화한다', async () => {
    const controlHost = new SourcePluginControlHost({ platform: 'linux', findExecutable: () => null });
    controlHost.statuses.set(OMO_MANIFEST.id, {
      id: OMO_MANIFEST.id,
      capabilities: { stop: false, readConversation: true, readSteps: true, readArtifacts: true },
      controlUnavailableReasons: { stop: '관리 중인 OMO 프로세스만 중지할 수 있습니다.' },
    });
    controlHost.children.set('managed-process', {
      id: 'managed-process', pluginId: OMO_MANIFEST.id, externalId: 'managed-session', child: {},
    });

    const monitorHost = new SourcePluginMonitorHost({
      platform: 'linux',
      definitions: [{
        manifest: OMO_MANIFEST,
        createMonitor: () => ({
          scan: () => [
            {
              externalId: 'managed-session', title: 'Managed', status: 'running',
              updatedAt: '2026-08-13T00:00:00.000Z',
              sourceControlCapabilities: { stop: true, readConversation: true, readSteps: true, readArtifacts: true },
            },
            {
              externalId: 'external-session', title: 'External', status: 'running',
              updatedAt: '2026-08-13T00:00:00.000Z',
              sourceControlCapabilities: { stop: true, readConversation: true, readSteps: true, readArtifacts: true },
            },
          ],
        }),
      }],
    });
    monitorHost.setRuntimeStatuses(controlHost.listSources());
    const result = await monitorHost.scan();
    const managed = result.sessions.find(session => session.externalId === 'managed-session');
    const external = result.sessions.find(session => session.externalId === 'external-session');

    assert.deepEqual(controlHost.listSources()[0].managedSessionIds, ['managed-session']);
    assert.equal(managed.sourceControlCapabilities.stop, true);
    assert.equal(external.sourceControlCapabilities.stop, false);
    await monitorHost.dispose();
  });

  test('source delete 확인 토큰은 대상에 묶이고 한 번만 사용할 수 있다', async () => {
    let deleteCalls = 0;
    const host = new SourcePluginControlHost({
      platform: 'linux',
      findExecutable: () => null,
      execFile: async () => { deleteCalls += 1; return { stdout: '', stderr: '' }; },
    });
    host.statuses.set(OMO_MANIFEST.id, {
      executable: 'opencode-fixture', capabilities: { delete: true }, controlUnavailableReasons: {},
    });
    const session = {
      id: 'builtin.omo:delete-fixture', externalId: 'delete-fixture', sourcePluginId: OMO_MANIFEST.id,
      sourcePlugin: { revision: 'r1' }, updatedAt: '2026-08-13T00:00:00.000Z', cwd: temp,
    };
    const prepared = host.prepareDelete(session);
    await host.control(session, 'delete', { deleteToken: prepared.token });
    assert.equal(deleteCalls, 1);
    await assert.rejects(
      host.control(session, 'delete', { deleteToken: prepared.token }),
      /만료|다시 확인/,
    );
    assert.equal(deleteCalls, 1);
  });

  test('source delete 확인 토큰은 리비전 변경과 만료 뒤 거절된다', async () => {
    let now = 10_000;
    let deleteCalls = 0;
    const host = new SourcePluginControlHost({
      platform: 'linux',
      now: () => now,
      findExecutable: () => null,
      execFile: async () => { deleteCalls += 1; return { stdout: '', stderr: '' }; },
    });
    host.statuses.set(OMO_MANIFEST.id, {
      executable: 'opencode-fixture', capabilities: { delete: true }, controlUnavailableReasons: {},
    });
    const session = {
      id: 'builtin.omo:revision-fixture', externalId: 'revision-fixture', sourcePluginId: OMO_MANIFEST.id,
      sourcePlugin: { revision: 'r1' }, updatedAt: '2026-08-13T00:00:00.000Z', cwd: temp,
    };
    const revisionToken = host.prepareDelete(session).token;
    await assert.rejects(
      host.control({ ...session, sourcePlugin: { revision: 'r2' } }, 'delete', { deleteToken: revisionToken }),
      /변경|다시/,
    );

    const expiring = host.prepareDelete(session);
    now = expiring.expiresAt + 1;
    assert.ok(now > 10_000 + DELETE_TOKEN_TTL_MS);
    await assert.rejects(
      host.control(session, 'delete', { deleteToken: expiring.token }),
      /만료|다시 확인/,
    );
    assert.equal(deleteCalls, 0);
  });

  test('Aside MCP discovery가 attachment·credential 같은 유사 파괴 도구를 task 삭제로 오인하지 않는다', () => {
    const identitySchema = {
      type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'],
    };
    const sendSchema = {
      type: 'object',
      properties: { taskId: { type: 'string' }, message: { type: 'string' } },
      required: ['taskId', 'message'],
    };
    const discovery = discoverAsideTools([
      { name: 'delete_task_attachment', inputSchema: identitySchema },
      { name: 'remove_task_credentials', inputSchema: identitySchema },
      { name: 'send_task_message', inputSchema: sendSchema },
    ]);
    assert.equal(discovery.capabilities.delete, false);
    assert.equal(discovery.operations.delete, null);
    assert.equal(discovery.capabilities.sendInstruction, true);

    const explicit = discoverAsideTools([{ name: 'delete_task', inputSchema: identitySchema }]);
    assert.equal(explicit.capabilities.delete, true);
    assert.equal(explicit.operations.delete.name, 'delete_task');
  });

  test('MCP parser가 UTF-8 Content-Length와 newline frame의 분할 입력을 보존한다', () => {
    const messages = [];
    const warnings = [];
    const parser = createMessageParser(
      message => messages.push(message),
      warning => warnings.push(warning),
    );
    const framed = encodeJsonRpcMessage({ jsonrpc: '2.0', id: 1, result: { text: '한글 ✓' } }, 'content-length');
    for (let offset = 0; offset < framed.length; offset += 3) parser.push(framed.subarray(offset, offset + 3));
    const newline = encodeJsonRpcMessage({ jsonrpc: '2.0', method: 'tools/list_changed' }, 'newline');
    for (let offset = 0; offset < newline.length; offset += 5) parser.push(newline.subarray(offset, offset + 5));
    parser.end();

    assert.deepEqual(messages, [
      { jsonrpc: '2.0', id: 1, result: { text: '한글 ✓' } },
      { jsonrpc: '2.0', method: 'tools/list_changed' },
    ]);
    assert.deepEqual(warnings, []);
  });

  test('MCP server request의 ID가 pending response ID와 같아도 client 요청을 가로채지 않는다', () => {
    const writes = [];
    const client = new McpStdioClient();
    let resolved = false;
    client.child = {
      stdin: {
        destroyed: false,
        write(value) { writes.push(Buffer.from(value)); },
      },
    };
    client.pending.set('7', {
      resolve() { resolved = true; },
      reject() {},
      timer: null,
      method: 'tools/list',
    });
    client._handleMessage({ jsonrpc: '2.0', id: 7, method: 'ping' });

    assert.equal(resolved, false);
    assert.equal(client.pending.has('7'), true);
    assert.equal(writes.length, 1);
    assert.deepEqual(JSON.parse(writes[0].toString('utf8')), { jsonrpc: '2.0', id: 7, result: {} });
    client.pending.clear();
    client.child = null;
  });

  test('renderer가 source·provider·environment·runtime 4개 배지와 source 삭제 확인을 유지한다', () => {
    const renderer = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
    for (const dimension of ['source', 'provider', 'environment', 'runtime']) {
      assert.equal(renderer.includes(`session-dimension ${dimension}`), true, `${dimension} 배지가 없습니다.`);
    }
    assert.equal(renderer.includes('읽기 전용 폴더'), true);
    assert.equal(renderer.includes('공식 연결'), true);
    assert.equal(renderer.includes('data-session-source='), true);
    assert.equal(renderer.includes('data-session-provider='), true);
    assert.equal(renderer.includes('data-session-environment='), true);
    assert.equal(renderer.includes('data-session-runtime='), true);

    const actions = fs.readFileSync(path.join(root, 'renderer', 'app-agent-actions.js'), 'utf8');
    assert.equal(actions.includes('prepareSourceDelete(sessionId)'), true);
    assert.equal(actions.includes('window.confirm('), true);
    assert.equal(actions.includes('deleteToken: prepared.token'), true);

    const worker = fs.readFileSync(path.join(root, 'src', 'monitorWorker.js'), 'utf8');
    assert.equal(worker.includes('provenance: session.provenance || null'), true);
    assert.equal(worker.includes("controlAuthority: session.controlAuthority || ''"), true);
    assert.equal(worker.includes('readOnly: Boolean(session.readOnly)'), true);
    assert.equal(worker.includes('JSON.stringify(item.managedSessionIds || [])'), true);

    const runModal = fs.readFileSync(path.join(root, 'renderer', 'app-run-modal.js'), 'utf8');
    assert.equal(runModal.includes('data-aside-history-remove='), true);
    assert.equal(runModal.includes('읽기 전용 기록 연결 가능'), true);
    assert.equal(runModal.includes('source.id === "builtin.aside" && state.platform.id === "darwin"'), true);

    const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    const visibility = fs.readFileSync(path.join(root, 'renderer', 'app-provider-visibility.js'), 'utf8');
    assert.equal(main.includes('session.sourcePluginId || isProviderVisible(session.provider)'), true);
    assert.equal(visibility.includes('session.sourcePluginId || isProviderVisible(session.provider)'), true);
  });
}

module.exports = { registerSourcePluginTests };
