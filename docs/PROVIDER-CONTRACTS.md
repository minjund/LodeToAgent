# 제공사 이벤트 계약

LoadToAgent는 제공사별 이벤트를 아래 공통 단계로 정규화합니다.

`queued → session-start → turn-start → reasoning/tool/message → turn-complete → session-end`

수명주기 상태는 `starting`, `running`, `paused`, `waiting`, `idle`, `completed`, `failed`, `cancelled` 중 하나입니다. 이와 별도로 현재 활동을 `thinking`, `working`, `juggling`, `notification`, `attention`, `error`, `idle`로 보존합니다. 화면은 사용자 요청 직후 `생각 중`, 도구 실행 중 `작업 중`, 구조화 입력·권한 요청은 `대기 중`으로 표시합니다. `paused`는 LoadToAgent가 시작하고 사용자가 일시정지한 관리 실행에만 사용합니다.

`waiting`과 확인 알림은 `request_user_input`, `AskUserQuestion`, 실제 권한 승인처럼 식별 가능한 요청에만 사용합니다. 최종 assistant 문장의 물음표는 응답 의도 참고값으로만 남기며 단독으로 `waiting`이나 시스템 알림을 만들지 않습니다. 구조화 요청은 호출 ID로 중복을 제거하고, 일치하는 도구 결과·새 사용자 메시지·완료 또는 중단 수명주기에서 해제합니다.

## 관리 인텔리전스 계약

제공사별 원본 세션은 화면에 전달되기 전에 다음 관리 정보로 보강됩니다.

- `attention`: 승인·결정·입력·오류·일시정지처럼 사용자 조치가 필요한 이유와 관측 신뢰도
- `progress`: 최근 실행 이벤트 중 완료로 기록된 수, 최근 체크포인트, 막힘 사유와 마지막 활동 시각. 화면의 비율은 전체 계획 진척도가 아닙니다.
- `health`: 실패, 새 활동 없음, 장시간 응답 대기, AI 기억 한도, 반복 실패, 부모 연결 정보 누락 신호
- `controlCapabilities`: 실제 연결과 관리 실행 상태에 근거한 응답·중지·일시정지·재개·재시도·재배정 가능 여부
- `evidence`: 상태·부모/도움 AI 관계·완료 신호가 직접 확인인지 활동 기록 추정인지와 정보 출처. 확인 수준은 결과 품질의 신뢰도가 아닙니다.
- `outcome`: 완료 요약, 로그에서 찾은 파일·테스트·커밋 후보, 테스트 관련 로그와 완료 신호 수신 여부. 파일 존재나 결과 정확성을 독립 검증한 값이 아닙니다.

관측 이벤트가 없는 값은 사실로 단정하지 않고 `inferred` 또는 `unverified`로 표시합니다. 시간 기반 건강 신호는 매분 다시 계산됩니다.

서브에이전트 작업 지시는 제공사 호출 로그에서 확인한 원문만 `assignment`로 취급합니다. Claude의 `Agent`/`Task` 도구는 `input.prompt`, Codex의 `spawn_agent`는 평문 `message`가 근거입니다. Codex가 `message`를 암호문으로 저장한 경우 직전 메인 AI 설명을 실제 전달 원문으로 대체하지 않으며, 원문은 `protected`, 직전 설명은 별도 참고 문맥으로 표시합니다.

화면의 최근 세션 기준은 마지막 활동 후 24시간입니다. 실행 중인 세션은 마지막 활동 시각과 관계없이 계속 표시합니다. 앱이 실행 상태를 관측한 세션은 실행이 끝나도 마지막 AI 응답 후 30분 동안 관제 화면에서 `대기 중`으로 유지하며, 사용자가 직접 지난 기록으로 옮기면 즉시 제외합니다. 새 AI 응답이 생기면 이전의 수동 이동 기록은 무효화됩니다. `확인할 일`은 24시간 범위 안의 실제 응답 요청과 현재 실행 위험만 집계하며, 오래된 세션이나 단순한 낮은 확인 수준은 제외합니다.

## 명령·백그라운드 실행 계약

- 각 AI 세션은 `executions`에 자신이 시작한 일반 명령과 백그라운드 명령을 별도 기록으로 보관합니다. 도움 AI 세션과 섞어 세지 않습니다.
- 공통 필드는 `kind(shell|background)`, `mode(foreground|background)`, `status(running|completed|failed)`, 명령, 작업 폴더, 호출 ID, 시작·갱신·완료 시각입니다.
- Codex는 `shell_command`, `exec_command`와 `custom_tool_call: exec` 안의 `tools.exec_command(...)`를 인식합니다. 장기 실행이 반환한 cell/session ID는 후속 `wait`·`write_stdin` 호출과 연결합니다.
- Claude는 `Bash` 계열의 `run_in_background`와 후속 `TaskOutput`·`BashOutput`을 같은 실행으로 연결합니다. Gemini/Grok의 구조화 `tool_use`·`tool_result`에서도 셸 도구를 같은 계약으로 정규화합니다.
- 완료·실패 판정은 실행 도구의 바깥 결과 헤더와 실제 종료 코드 행을 우선합니다. 명령 출력 본문에 우연히 포함된 `session`이나 `exitCode` 문자열은 런타임 ID 또는 실패로 해석하지 않습니다.
- 스냅샷에는 최근 120개 실행을 보존하고, UI는 실행 중 항목을 먼저 표시한 뒤 최근 완료 기록을 제한적으로 보여 줍니다.

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
2. LoadToAgent가 시작한 CLI의 구조화 결과
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
