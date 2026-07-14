# Lodestar · AI 작업 도우미

Claude, GPT(Codex), Gemini, Grok이 지금 무슨 일을 하는지 한 화면에서 확인하고 새 일을 맡길 수 있는 Windows·macOS 프로그램입니다. 전문 용어를 몰라도 `진행 중 → 내 확인 필요 → 자세히 보기` 순서로 따라가며, 도움을 맡은 AI와 대화 내용, 진행 과정, 토큰 사용량, AI가 사용할 수 있는 기억 공간을 확인할 수 있습니다.

## 주요 기능

- **처음 보는 사람을 위한 안내**: 홈 화면에서 무엇을 먼저 보고 눌러야 하는지 3단계로 설명하고, 상태와 버튼을 `일하는 중`, `내 확인 필요`, `AI에게 새 일 맡기기`처럼 행동 중심의 쉬운 말로 표시합니다.
- **한눈에 보는 작업 카드**: AI별 큰 일을 짧은 행으로 묶고, 작업 수에 맞춰 카드 너비를 자동으로 넓혀 불필요한 빈 공간과 정보 과밀을 줄입니다.
- **연결형 AI 작업 흐름**: 작업을 선택하면 `일을 맡긴 AI → 지금 선택한 AI → 나눠 맡긴 AI`를 n8n처럼 포트와 곡선으로 연결합니다. 도움 AI를 선택해도 메인 AI는 항상 왼쪽에 남아 같은 방향으로 돌아갈 수 있습니다.
- **선택한 AI에게 바로 지시**: 가운데 AI 카드에서 자연어 지시를 작성해 연결된 일반 터미널, 안전한 외부 브리지 또는 tmux 패널로 즉시 보냅니다. 임의의 외부 창에는 키 입력을 주입하지 않습니다.
- **안전한 외부 터미널 브리지**: `lodestar run codex`처럼 시작하면 사용자 전용 인증 소켓과 Lodestar 소유 PTY로 연결됩니다. 외부 터미널과 대시보드가 같은 AI를 조작하되 다른 창으로 오발송할 수 없습니다.
- **입력 가능 상태 구분**: `직접 입력 가능`, `연결 후 입력 가능`, `보기 전용 · 원래 앱에서 계속`, `종료된 세션`을 분리해 현재 가능한 동작을 바로 보여줍니다.
- **Codex 원래 작업 열기**: Codex 데스크톱에서 시작된 보기 전용 세션은 공식 `codex://threads/<thread-id>` 딥링크로 원래 작업을 엽니다.
- **부드러운 화면 전환**: 카드 재정렬은 이전 위치에서 이어지고 새 작업만 순차적으로 나타납니다. 작업 관계선, 화면 전환, 상세 패널, 모달과 알림은 같은 속도감으로 움직이며 운영체제의 애니메이션 축소 설정도 따릅니다.
- **일반 명령창과 tmux 완전 분리**: `일반 명령창`에는 Windows의 PowerShell·WSL 또는 macOS의 zsh를 표시하고, tmux 지도·생성·패널 목록·명령 전송·창 나누기·종료는 `tmux 작업` 전용 화면 한곳에 모읍니다.
- **밀도 적응형 에이전트 지도**: 활성 작업을 Claude·GPT·Gemini·Grok 레인으로 묶고 AI별 최근 6개 흐름만 우선 표시해, 동시에 수십 개 세션이 실행돼도 전체 상태를 짧은 행으로 비교할 수 있습니다.
- **관계 따라가기**: 작업 흐름을 선택하면 전체 목록 대신 현재 에이전트 카드와 상위 세션·직접 연결된 서브에이전트만 표시하고 `전체 흐름 → 메인 세션 → 서브에이전트` 경로로 단계 탐색합니다.
- **통합된 서브에이전트 관측**: 별도 서브에이전트 탭 없이 지도와 세션 카드에서 부모·자식 관계, 역할, 맡은 작업, 상태와 토큰을 함께 확인합니다.
- **동적 서브에이전트 노드**: Claude의 `subagents/` transcript와 Codex의 `thread_spawn.parent_thread_id`를 읽어 이름, 역할, 맡은 작업과 부모-자식 관계를 연결합니다.
- **tmux 전용 지도**: Windows에서는 `WSL 배포판`, macOS에서는 로컬 환경부터 `tmux 세션 → 윈도우 → 패널 → AI 프로세스` 계층을 그리고, 패널 PID의 자식 프로세스를 따라 Claude·Codex·Gemini·Grok을 식별합니다.
- **tmux 대화 연결**: Windows의 WSL 또는 macOS 로컬 사용자 홈의 최신 AI 기록과 패널의 작업 폴더·제공사·실행 시각을 매칭하고, 연결된 패널에서 대화·라이프사이클·토큰 상세를 바로 엽니다.
- **통합 터미널 제어**: 앱 안에서 여러 PowerShell·WSL·zsh PTY를 동시에 열고 키보드 입력, 완성된 명령 전송, 크기 조절, `Ctrl+C`, `Ctrl+L`, 재시작, 종료를 제어합니다.
- **tmux 원격 제어**: 감지된 패널의 출력을 실시간 캡처하고 명령·제어 키를 전달하며, 필요하면 해당 세션에 대화형 PTY로 바로 연결합니다.
- **tmux 관리**: 새 세션·윈도우·분할 패널 생성, 세션 이름 변경, 레이아웃 선택과 패널·윈도우·세션 종료를 터미널 탭에서 수행합니다.
- **대화 기록**: 사용자, AI 응답, 도구 호출을 세션별 상세 드로어에서 확인합니다.
- **읽기 쉬운 상세**: JSON 결과는 대상·분류·내용 카드 또는 키·값 구조로 풀어서 표시하고, 상세창을 열면 가장 최근 대화로 자동 이동합니다.
- **프로세스 우선 활성 상태**: transcript가 잠시 멈춰도 Windows AI CLI 또는 tmux 패널의 프로세스가 살아 있으면 각각의 세션을 계속 `작업 중` 카드로 표시합니다.
- **토큰 관측**: 입력, 출력, 캐시 읽기, 캐시 생성, 추론, 합계를 AI 및 세션별로 집계합니다.
- **대형 컨텍스트 게이지**: 가장 최근 턴의 `사용량 / 전체 한도`, 점유율, 남은 용량을 한 줄에 표시하고 75%부터 주황색, 90%부터 빨간색으로 경고합니다.
- **새 작업 실행**: 설치된 네 제공사 CLI를 공식 구조화 출력 모드로 실행하고 이벤트를 즉시 카드에 반영합니다.
- **로컬 퍼스트**: 기존 세션 기록은 사용자 PC에서 직접 읽고, Lodestar가 실행한 작업도 Electron `userData` 아래에 보관합니다.
- **경량 실시간 갱신**: 카드에는 짧은 미리보기만 전송하고 전체 대화는 카드를 열 때 요청합니다. 한 번에 최대 30개 과거 카드만 렌더링하며 새 세션은 파일 감시로 즉시 발견합니다.

## 지원 데이터 소스

| AI | 기존 세션 | 새 작업 스트림 | 서브에이전트 |
|---|---|---|---|
| Claude | `~/.claude/projects/**/*.jsonl` | `claude -p --output-format stream-json` | transcript의 `subagents/agent-*.jsonl` |
| GPT · Codex | `~/.codex/sessions/**/*.jsonl` | `codex exec --json` | `session_meta.source.subagent.thread_spawn` |
| Gemini | `~/.gemini/tmp/*/chats/*.{json,jsonl}` | `gemini -p --output-format stream-json` | 세션 데이터에 부모 ID가 있으면 연결 |
| Grok | `~/.grok/sessions/*.{json,jsonl}` | `grok -p --output-format streaming-json` | 세션 데이터에 부모 ID가 있으면 연결 |

앱 밖에서 실행한 세션의 “작업 중” 상태는 Windows 또는 macOS AI CLI 프로세스, tmux 패널의 PID 계보, transcript 갱신 이벤트를 함께 사용합니다. 프로세스가 살아 있으면 파일 갱신이 잠시 멈춰도 활성 카드가 유지되고, 프로세스 연결을 찾지 못한 기록만 최근 이벤트 시각으로 상태를 추론합니다. Lodestar에서 시작한 세션은 자식 프로세스와 구조화 이벤트를 직접 관측합니다. 제공사 CLI가 토큰 또는 컨텍스트 정보를 기록하지 않은 세션은 임의 값을 만들지 않고 `0` 또는 `--`로 표시합니다.

tmux 지도는 Windows에서는 `wsl.exe`의 배포판을, macOS에서는 로컬 tmux 서버를 자동 탐지합니다. Windows에서는 WSL 사용자 홈의 AI 기록도 제공사별 최신 40개까지 읽습니다. AI 기록을 찾지 못한 경우에도 PID 계보에서 확인된 제공사·프로세스·작업 폴더는 표시합니다.

터미널 탭의 PowerShell·WSL·zsh는 실제 PTY에 연결되므로 대화형 CLI, ANSI 색상, 전체 화면 프로그램을 지원합니다. tmux 패널 목록은 운영체제별 토폴로지 감지 결과와 연결되며, 명령 본문은 셸 명령 문자열로 합치지 않고 tmux 버퍼의 표준 입력으로 전달합니다. 원격 SSH 서버 안의 tmux는 해당 서버에 대한 별도 연결 구성이 없으면 자동 탐지하지 않습니다.

## 실행

```powershell
npm install
npm start
```

앱을 한 번 실행하면 `~/.lodestar/bin`에 현재 설치본을 가리키는 외부 브리지 실행기가 만들어집니다. AI 카드의 **연결 명령 복사**를 누르면 현재 운영체제에서 바로 실행할 수 있는 전체 명령이 복사됩니다. 해당 디렉터리를 `PATH`에 추가하면 아래처럼 짧게 사용할 수 있습니다.

```text
lodestar run claude
lodestar run codex
lodestar run gemini
lodestar run grok
```

브리지는 `~/.lodestar/bridge.json`의 사용자 전용 토큰과 Windows named pipe 또는 macOS Unix domain socket으로 인증합니다. 브리지 없이 이미 실행 중인 임의의 외부 터미널은 보기 전용입니다.

앱 상단의 **새 AI 작업** 버튼에서 제공사와 작업 폴더를 선택하고 프롬프트를 입력합니다. “작업 폴더 수정 허용”은 각 CLI의 워크스페이스 편집 모드를 켭니다. 실행 전 해당 CLI 설치와 인증이 완료되어 있어야 합니다.

```powershell
# 설치 확인 예시
claude --version
codex --version
gemini --version
grok version
```

## 테스트와 빌드

```powershell
npm test
npm run test:terminal
npm run test:bridge
npm run test:tmux -- Ubuntu-22.04
npm run test:visual
npm run dist
npm run dist:win
npm run dist:mac
```

`dist:mac`은 Apple Silicon(`arm64`)과 Intel(`x64`)용 DMG·ZIP을 생성합니다. macOS GUI 앱에서 Homebrew CLI를 찾을 수 있도록 로그인 셸의 `PATH`, `/opt/homebrew/bin`, `/usr/local/bin`을 자동 반영합니다. 배포용 DMG의 Apple 코드 서명·notarization은 빌드 환경에 인증서를 제공해야 합니다.

`npm run test:terminal`은 Electron의 Windows ConPTY 또는 macOS PTY에서 로컬 셸의 입력·출력·종료를 검증합니다. `npm run test:bridge`는 별도 CLI 프로세스에서 인증 소켓을 거쳐 Lodestar PTY에 입력하고 AI 출력을 되받는 전체 왕복을 검증합니다. `npm run test:tmux`는 지정한 WSL 배포판 또는 macOS 로컬 환경에 고유한 임시 tmux 세션을 만들고 입력·캡처·분할·윈도우·레이아웃·이름 변경과 모니터 탐지를 확인한 뒤 반드시 그 임시 세션을 제거합니다. `npm run test:visual`은 실제 로컬 세션을 불러온 1600×980 대시보드, 통합 터미널, tmux 관계도, 노드 탐색과 상세 화면을 `artifacts/`에 생성합니다.

## 구조

- `main.js` — Electron 창, 작업 폴더, IPC, 모니터/실행기 연결
- `preload.js` — 격리된 렌더러 API
- `src/providerRegistry.js` — 제공사 메타데이터와 모델 컨텍스트 규칙
- `src/agentMonitor.js` — 네 제공사 로컬 세션 파서와 공통 세션 모델
- `src/agentRunner.js` — 구조화 CLI 실행, 스트림 정규화, 중지 및 영속화
- `src/tmuxMonitor.js` — WSL·macOS 로컬 tmux 토폴로지, 프로세스 계보, AI 세션 연결
- `src/terminalManager.js` — PowerShell·WSL·zsh·tmux PTY의 수명주기, 입출력, 크기와 신호 제어
- `src/tmuxController.js` — tmux 명령·키 입력·캡처와 세션·윈도우·패널 관리
- `src/processMonitor.js` — Windows AI CLI 프로세스 식별, 중복 래퍼 제거, 세션 실행 상태 연결
- `renderer/` — 에이전트 관계도, 통합 터미널, tmux 지도, 세션 카드, 상세 드로어, 새 작업 모달
- `scripts/regression-test.js` — 파서·usage·부모 관계·UI 계약 회귀 테스트

## 공식 문서 기준

- [Claude Code headless](https://code.claude.com/docs/en/headless), [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Codex non-interactive mode](https://developers.openai.com/codex/non-interactive), [Codex app-server](https://developers.openai.com/codex/app-server)
- [Gemini CLI headless](https://geminicli.com/docs/cli/headless/), [Gemini CLI session management](https://geminicli.com/docs/cli/session-management/), [Gemini CLI hooks](https://geminicli.com/docs/hooks/reference/)
- [Grok Build headless](https://docs.x.ai/build/cli/headless-scripting), [Grok CLI reference](https://docs.x.ai/build/cli/reference)

세부 이벤트 매핑과 컨텍스트 산정 원칙은 [docs/PROVIDER-CONTRACTS.md](docs/PROVIDER-CONTRACTS.md)에 정리되어 있습니다.

## 개인정보와 보안

- 세션 카드에는 로컬 transcript의 대화와 도구 입력이 표시될 수 있습니다. 화면 공유 전에 민감한 내용을 확인하세요.
- 앱은 API 키 파일을 읽거나 화면에 표시하지 않습니다. 인증은 각 CLI가 자체적으로 처리합니다.
- Windows에서는 Claude·Codex·Gemini·Grok CLI 후보 프로세스만 제한적으로 조회하며, 일반 응용 프로그램이나 Claude/Codex 데스크톱 렌더러 프로세스는 활성 세션으로 계산하지 않습니다.
- 작업 폴더 수정 권한을 켜면 AI가 파일을 변경할 수 있습니다. 신뢰할 수 있는 저장소에서만 사용하세요.
- 터미널 명령은 선택한 로컬 셸 또는 tmux 패널에서 사용자의 권한으로 실행됩니다. 대상·명령을 확인한 뒤 전송하세요.
- 터미널 IPC는 Lodestar의 격리된 렌더러에서 온 요청만 허용하며, tmux 대상·키·이름·레이아웃을 허용 목록과 형식 규칙으로 검증합니다.
