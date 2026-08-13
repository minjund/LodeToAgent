'use strict';

const assert = require('assert');
const path = require('path');
const { parseClaude, parseCodex, parseGeneric } = require('../../src/agentMonitor');
const {
  structuredInputRequest,
  structuredInputRequestText,
} = require('../../src/agentMonitor/responseIntent');

function registerStructuredInputRequestTests(context) {
  const { test, temp, jsonl } = context;

  test('구조화된 질문은 표시 필드만 안전하게 정규화하고 공급자 호출별 ID를 유지한다', () => {
    const request = structuredInputRequest(JSON.stringify({
      questions: [
        {
          id: 'environment',
          header: ' 실행\n환경 ',
          question: '  Windows와\tWSL 중 어디서 실행할까요? ',
          multi_select: false,
          options: [
            { label: ' Windows ', description: ' 로컬\n환경 ' },
            { label: 'WSL', description: 'Linux 환경' },
            { label: 'Docker', description: '컨테이너' },
            { label: 'Remote', description: '원격' },
            { label: '노출되면 안 됨', description: '다섯 번째 옵션' },
          ],
          secret: '질문 객체의 임의 필드는 노출하면 안 됩니다.',
        },
        {
          key: 'checks',
          header: '검사',
          prompt: '검사 항목을 선택해 주세요.',
          multiSelect: true,
          options: [{ label: '테스트', description: '전체 테스트' }],
        },
        { message: '배포를 진행할까요?' },
        { id: 'ignored', question: '네 번째 질문은 포함하면 안 됩니다.' },
      ],
      hidden: '도구 payload의 나머지 내용',
    }), 'call-17');

    assert.deepStrictEqual(request, [
      {
        id: 'call-17:environment', callId: 'call-17', header: '실행 환경',
        question: 'Windows와 WSL 중 어디서 실행할까요?', multiSelect: false,
        options: [
          { label: 'Windows', description: '로컬 환경' },
          { label: 'WSL', description: 'Linux 환경' },
          { label: 'Docker', description: '컨테이너' },
          { label: 'Remote', description: '원격' },
        ],
      },
      {
        id: 'call-17:checks', callId: 'call-17', header: '검사',
        question: '검사 항목을 선택해 주세요.', multiSelect: true,
        options: [{ label: '테스트', description: '전체 테스트' }],
      },
      {
        id: 'call-17:3', callId: 'call-17', header: '',
        question: '배포를 진행할까요?', multiSelect: false, options: [],
      },
    ]);
    assert.equal(JSON.stringify(request).includes('secret'), false);
    assert.equal(JSON.stringify(request).includes('노출하면 안 됩니다'), false);
    assert.equal(JSON.stringify(request).includes('다섯 번째'), false);
  });

  test('구조화된 질문 정규화는 손상·거대·예외 payload에서도 제한을 지킨다', () => {
    assert.deepStrictEqual(structuredInputRequest('{malformed-json', 'broken'), []);
    assert.deepStrictEqual(structuredInputRequest(`{"questions":[],"padding":"${'x'.repeat(32_001)}"}`, 'large'), []);

    const throwing = {};
    Object.defineProperty(throwing, 'questions', { get() { throw new Error('읽기 실패'); } });
    assert.doesNotThrow(() => structuredInputRequest(throwing, 'unsafe'));
    assert.deepStrictEqual(structuredInputRequest(throwing, 'unsafe'), []);

    const cyclic = { questions: [] };
    cyclic.questions.push(cyclic);
    assert.doesNotThrow(() => structuredInputRequest(cyclic, 'cycle'));
    assert.deepStrictEqual(structuredInputRequest(cyclic, 'cycle'), []);

    const bounded = structuredInputRequest({
      questions: [{
        id: 'i'.repeat(500), header: 'h'.repeat(500), question: 'q'.repeat(800),
        options: [{ label: 'l'.repeat(500), description: 'd'.repeat(500) }],
      }],
    }, 'c'.repeat(500))[0];
    assert.equal(bounded.callId.length, 180);
    assert.equal(bounded.id.length, 361);
    assert.equal(bounded.header.length, 80);
    assert.equal(bounded.question.length, 420);
    assert.equal(bounded.options[0].label.length, 160);
    assert.equal(bounded.options[0].description.length, 280);
    assert.equal(structuredInputRequestText({ questions: [
      { question: '첫 질문' }, { question: '둘째 질문' }, { question: '셋째 질문' }, { question: '제외 질문' },
    ] }), '첫 질문\n둘째 질문\n셋째 질문');
  });

  test('Codex·Claude·범용 파서는 미해결 입력 호출의 질문을 responseIntent.requests로 보존한다', () => {
    const codexRows = [
      { timestamp: '2026-08-13T01:00:00Z', type: 'session_meta', payload: { id: 'structured-codex', cwd: 'D:\\repo' } },
      { timestamp: '2026-08-13T01:00:01Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
      { timestamp: '2026-08-13T01:00:02Z', type: 'response_item', payload: {
        type: 'function_call', name: 'request_user_input', call_id: 'codex-old',
        arguments: JSON.stringify({ questions: [{ id: 'old', question: '먼저 답할 질문' }] }),
      } },
      { timestamp: '2026-08-13T01:00:03Z', type: 'response_item', payload: {
        type: 'function_call', name: 'request_user_input', call_id: 'codex-live',
        arguments: JSON.stringify({ questions: [{
          id: 'scope', header: '범위', question: '검사 범위를 골라 주세요.',
          options: [{ label: '전체', description: '전체 프로젝트' }, { label: '변경분', description: '변경 파일만' }],
        }] }),
      } },
      { timestamp: '2026-08-13T01:00:04Z', type: 'response_item', payload: {
        type: 'function_call_output', call_id: 'codex-old', output: '{"answers":{"old":"done"}}',
      } },
    ];
    const codex = parseCodex(jsonl(path.join(temp, 'structured-input', 'codex.jsonl'), codexRows));
    assert.deepStrictEqual(codex.responseIntent.requests, [{
      id: 'codex-live:scope', callId: 'codex-live', header: '범위',
      question: '검사 범위를 골라 주세요.', multiSelect: false,
      options: [
        { label: '전체', description: '전체 프로젝트' },
        { label: '변경분', description: '변경 파일만' },
      ],
    }]);

    const claudeRows = [
      { type: 'user', timestamp: '2026-08-13T01:01:00Z', message: { role: 'user', content: '배포를 준비해줘' } },
      { type: 'assistant', timestamp: '2026-08-13T01:01:01Z', message: { role: 'assistant', content: [{
        type: 'tool_use', id: 'claude-ask', name: 'AskUserQuestion', input: { questions: [{
          header: '환경', question: '배포 환경을 선택해 주세요.', multiSelect: true,
          options: [{ label: '스테이징', description: '사전 검증' }],
        }] },
      }] } },
    ];
    const claude = parseClaude(jsonl(path.join(temp, 'structured-input', 'claude.jsonl'), claudeRows));
    assert.deepStrictEqual(claude.responseIntent.requests, [{
      id: 'claude-ask:1', callId: 'claude-ask', header: '환경',
      question: '배포 환경을 선택해 주세요.', multiSelect: true,
      options: [{ label: '스테이징', description: '사전 검증' }],
    }]);

    const generic = parseGeneric(jsonl(path.join(temp, 'structured-input', 'generic.jsonl'), [{
      type: 'tool_use', id: 'generic-ask', name: 'request_user_input', timestamp: '2026-08-13T01:02:00Z',
      input: { questions: [{ id: 'confirm', question: '계속할까요?' }] },
    }]), 'gemini');
    assert.deepStrictEqual(generic.responseIntent.requests, [{
      id: 'generic-ask:confirm', callId: 'generic-ask', header: '',
      question: '계속할까요?', multiSelect: false, options: [],
    }]);

    const answeredCodex = parseCodex(jsonl(path.join(temp, 'structured-input', 'codex-answered.jsonl'), [
      ...codexRows,
      { timestamp: '2026-08-13T01:00:05Z', type: 'response_item', payload: {
        type: 'function_call_output', call_id: 'codex-live', output: '{"answers":{"scope":"전체"}}',
      } },
    ]));
    assert.notEqual(answeredCodex.responseIntent.source, 'input-tool');
    assert.equal(answeredCodex.responseIntent.requests, undefined);
  });
}

module.exports = { registerStructuredInputRequestTests };
