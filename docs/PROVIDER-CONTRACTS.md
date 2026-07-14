# 제공사 이벤트 계약

Lodestar는 제공사별 이벤트를 아래 공통 단계로 정규화합니다.

`queued → session-start → turn-start → reasoning/tool/message → turn-complete → session-end`

상태는 `starting`, `running`, `waiting`, `idle`, `completed`, `failed`, `cancelled` 중 하나입니다. 구조화 완료 이벤트가 없는 외부 세션은 파일 갱신 시각과 마지막 메시지 역할을 이용해 `running`, `waiting`, `idle`을 구분합니다.

## Claude

- `--output-format stream-json --verbose --include-partial-messages`의 `system/init`, `assistant`, `stream_event`, `result`를 사용합니다.
- `SubagentStart`/`SubagentStop` 공식 훅 계약에서 서브에이전트의 별도 transcript와 `agent_id`가 정의되어 있습니다. 로컬 저장소의 `subagents/agent-*.jsonl` 경로를 같은 구조로 해석합니다.
- assistant message의 `usage`를 request ID별로 한 번만 합산합니다. 최근 request usage는 컨텍스트 사용량, 전체 request usage 합계는 누적 토큰으로 사용합니다.
- Claude Opus 4.6 이상, Opus 4.7/4.8, Sonnet 4.6/5는 공식 모델 문서 기준 1M 컨텍스트를 사용하고 그 밖의 모델은 200K로 표시합니다. 세션이 한도를 직접 보고하면 관측값이 우선합니다.

## GPT · Codex

- `codex exec --json`의 `thread.started`, `turn.started`, `item.*`, `turn.completed`, `turn.failed`, `error`를 사용합니다.
- 로컬 rollout의 `session_meta`, `turn_context`, `event_msg`, `response_item`을 읽습니다.
- `event_msg.token_count.info.total_token_usage`는 누적 토큰, `last_token_usage`는 최근 턴, `model_context_window`는 컨텍스트 한도로 사용합니다.
- `session_meta.source.subagent.thread_spawn.parent_thread_id`를 부모 카드 ID로 사용합니다.

## Gemini

- headless `stream-json`의 `init`, `message`, `tool_use`, `tool_result`, `error`, `result` 이벤트를 사용합니다.
- 공식 세션 관리 문서가 지정한 `~/.gemini/tmp/<project_hash>/chats/`에서 대화, 도구, token stats를 읽습니다.
- 모델별 한도를 세션이 보고하지 않으면 Gemini 장문 컨텍스트 기본값 1,048,576을 카탈로그 기준값으로 표시합니다. 정확한 값은 Google SDK의 model info 조회 결과가 기록된 경우 그 값을 우선합니다.

## Grok

- headless `streaming-json` 이벤트를 기록하고, 세션은 공식 경로인 `~/.grok/sessions`에서 읽습니다.
- Grok Build 0.1은 256K, Grok 4.5는 500K, Grok 4.3/4.20은 1M 컨텍스트를 공식 모델 카탈로그 기준값으로 사용합니다.
- Grok ACP의 `session/update`처럼 점진적 agent message가 제공되면 같은 message 스트림으로 합칩니다.

## 정확성 우선순위

1. 세션 이벤트가 직접 보고한 값
2. Lodestar가 시작한 CLI의 구조화 결과
3. 제공사 공식 모델 카탈로그의 모델별 한도
4. 값 미보고(`0` 또는 `--`)

누적 토큰과 컨텍스트 점유율은 서로 다른 지표입니다. 누적 토큰은 세션 전체의 사용량 합계이고, 컨텍스트 점유율은 마지막 모델 호출이 현재 모델 창에서 사용한 비율입니다.

## WSL · tmux 연결 계약

- `wsl.exe --list --quiet`로 사용자 배포판을 찾고 Docker 전용 배포판은 제외합니다.
- 각 배포판의 기본 tmux 서버에서 `session → window → pane` 구조와 패널 PID·현재 명령·작업 폴더를 읽습니다.
- 패널 PID의 전체 자식 프로세스를 따라가 실제 Claude, Codex, Gemini, Grok 실행 파일을 식별합니다. 패널 표면 명령이 `node`, `bash`여도 자식 바이너리가 우선합니다.
- WSL 사용자 홈의 최신 제공사 기록을 UNC 경로로 읽고 `제공사 + 배포판 + 작업 폴더 + 세션 활동 시각` 점수로 패널에 연결합니다.
- 연결 점수가 충분하지 않으면 대화나 토큰을 임의 연결하지 않고 AI 프로세스 정보만 표시합니다.

## Windows 실행 프로세스 계약

- `claude.exe`, `codex.exe`, Gemini/Grok CLI 및 공식 Node 래퍼만 후보로 조회합니다.
- Claude/Codex 데스크톱 앱의 Electron 렌더러, GPU, 네트워크 및 app-server 프로세스는 CLI 세션에서 제외합니다.
- 동일한 CLI의 Node 래퍼와 네이티브 자식 바이너리가 함께 있으면 가장 안쪽 실행 프로세스 하나만 세션으로 계산합니다.
- 프로세스와 대화 기록을 제공사·환경·시작 시각·최근 활동으로 일대일 연결하며, 연결되지 않은 프로세스도 별도 실행 카드로 표시합니다.
- Windows 또는 tmux 프로세스가 살아 있는 동안 transcript 갱신 시각과 무관하게 해당 세션을 `작업 중`으로 유지합니다.
