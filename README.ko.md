<div align="center">

# LoadToAgent

### 일하는 모든 AI를 한곳에서 보는 로컬 작업 지휘실

Claude, Codex, Gemini, Grok 세션을 모니터링하고, 메인 AI와 도움 AI의 관계를 따라가며, 토큰 사용량을 확인하고, 연결된 터미널로 바로 일을 전달하세요. 대화 기록은 외부로 업로드하지 않습니다.

[![Desktop CI](https://github.com/minjund/LodeToAgent/actions/workflows/desktop-ci.yml/badge.svg)](https://github.com/minjund/LodeToAgent/actions/workflows/desktop-ci.yml)
[![npm version](https://img.shields.io/npm/v/loadtoagent?logo=npm&color=CB3837)](https://www.npmjs.com/package/loadtoagent)
![macOS](https://img.shields.io/badge/macOS-지원-111827?logo=apple)
![Windows](https://img.shields.io/badge/Windows-지원-111827?logo=windows11)
![Local first](https://img.shields.io/badge/데이터-로컬--퍼스트-35d69f)

[English](README.md) | [简体中文](README.zh-CN.md) | **한국어**

</div>

<div align="center">
  <img src="docs/assets/loadtoagent-demo.gif" alt="AI 작업과 도움 AI, 대화, 토큰 사용량을 차례로 보여주는 LoadToAgent 데모" width="960" />
</div>

> AI 대화 기록은 내 컴퓨터에 그대로 남습니다. LoadToAgent는 이미 사용 중인 AI 도구가 만든 로컬 세션 파일을 직접 읽습니다.

## 설치와 실행

npm을 사용하거나, 바로 실행할 수 있는 프로그램 파일을 내려받을 수 있습니다. 어느 방식이든 Git으로 저장소를 받을 필요는 없습니다.

### 방법 1: npm

LoadToAgent는 npm에 [`loadtoagent`](https://www.npmjs.com/package/loadtoagent)로 공개되어 있습니다. 전역 설치한 뒤 `loadtoagent` 명령으로 데스크톱 앱을 여세요.

```bash
npm install -g loadtoagent
loadtoagent
```

npm 방식은 바탕 화면이나 응용 프로그램 바로가기를 만들지 않습니다. 앱을 열 때마다 터미널에서 `loadtoagent`를 실행하세요. 설치 직후 명령을 찾지 못하면 터미널을 한 번 닫았다가 다시 여세요.

```bash
# 업데이트
npm install -g loadtoagent@latest

# 삭제
npm uninstall -g loadtoagent
```

### 방법 2: 프로그램 파일 직접 다운로드

[최신 GitHub Release](https://github.com/minjund/LodeToAgent/releases/latest)에서 내 컴퓨터에 맞는 파일을 내려받으세요. 이 방식은 Node.js가 필요하지 않습니다.

| 운영체제 | 받을 파일 | 실행 방법 |
|---|---|---|
| Windows 10/11 (x64) | `LoadToAgent-<version>-portable.exe` | 받은 파일을 더블클릭하세요. 설치 과정이 없는 포터블 실행 파일입니다. |
| Apple Silicon Mac | `LoadToAgent-<version>-arm64.dmg` | DMG를 열고 LoadToAgent를 응용 프로그램 폴더로 옮긴 뒤 응용 프로그램에서 실행하세요. |
| Intel Mac | `LoadToAgent-<version>-x64.dmg` | DMG를 열고 LoadToAgent를 응용 프로그램 폴더로 옮긴 뒤 응용 프로그램에서 실행하세요. |

현재 배포 파일에는 코드 서명이 없어 Windows SmartScreen 또는 macOS Gatekeeper가 알 수 없는 개발자 경고를 표시할 수 있습니다. 이 저장소의 공식 Releases 페이지에서 받은 파일일 때만 계속하세요. macOS에서는 LoadToAgent를 Control-클릭하고 **열기**를 선택합니다. Windows에서는 **추가 정보 → 실행**을 선택합니다.

### 필요한 환경

- macOS 또는 Windows
- npm으로 설치할 때만 Node.js 18 이상
- Claude Code, Codex CLI, Gemini CLI, Grok CLI 중 하나 이상 설치 및 로그인
- tmux 작업 지도를 사용할 때만 tmux 필요

## 한눈에 볼 수 있는 것

| 화면 | 확인할 수 있는 내용 |
|---|---|
| AI 작업 지도 | Claude, Codex, Gemini, Grok별 실시간 작업 |
| 연결 관계 | 사용자 요청, 선택한 메인 AI, 직접 나눠 맡긴 도움 AI |
| 작업 상세 | 대화, 도구 호출, 진행 과정, 모델, 작업 폴더, 상태 |
| 토큰 | 입력·출력·캐시·추론·전체 사용량과 보고된 컨텍스트 점유율 |
| 터미널 | 로컬 셸과 LoadToAgent가 소유한 터미널로의 안전한 명령 전달 |
| tmux 작업 | macOS 또는 Windows WSL의 세션 → 창 → 패널 → AI 프로세스 관계 |

LoadToAgent는 `직접 입력 가능`, `브리지 연결 후 입력 가능`, `원래 앱에서 계속해야 하는 보기 전용`, `종료된 세션`을 구분합니다. 임의의 외부 창에 키 입력을 보내지 않습니다.

## 연결된 터미널 사용

LoadToAgent 앱을 열어 둔 뒤 인증된 로컬 브리지로 AI CLI를 시작합니다.

```bash
loadtoagent run claude
loadtoagent run codex
loadtoagent run gemini
loadtoagent run grok
```

`--` 뒤의 값은 각 AI CLI 옵션으로 그대로 전달됩니다.

```bash
loadtoagent run claude -- --model claude-sonnet-4-6
```

이제 외부 터미널과 LoadToAgent 대시보드가 같은 LoadToAgent 전용 PTY를 조작합니다. 다른 곳에서 이미 시작한 세션은 계속 볼 수 있지만, 원래 앱이 지원하는 연결 방식이 없으면 보기 전용으로 유지됩니다.

## 로컬 퍼스트와 보안

- 세션 파일은 사용자 프로필에서 직접 읽습니다.
- API 키 파일은 읽거나 표시하지 않으며 인증은 각 AI CLI가 처리합니다.
- 터미널 브리지는 사용자별 토큰과 로컬 named pipe 또는 Unix domain socket을 사용합니다.
- 터미널·tmux 동작 전에 격리된 화면에서 온 요청인지 확인하고 대상과 입력 형식을 검증합니다.
- 작업 폴더 수정 권한을 켜면 선택한 AI가 해당 폴더를 변경할 수 있으므로 신뢰하는 저장소에서만 사용하세요.

화면 공유 전에는 표시되는 대화 내용을 확인하세요. AI 대화와 도구 입력에 민감한 프로젝트 정보가 포함될 수 있습니다.

## 로컬 개발

```bash
npm install
npm start
npm test
```

추가 검사와 배포 파일 빌드:

```bash
npm run test:terminal
npm run test:bridge
npm run test:tmux -- macOS
npm run test:visual
npm run dist:mac
npm run dist:win
```

`dist:mac`은 Apple Silicon·Intel용 DMG/ZIP을 만들고, `dist:win`은 Windows 포터블 실행 파일을 만듭니다. 실제 macOS 배포에는 관리자의 Apple 서명·notarization 인증 정보가 필요합니다.

## 지원하는 세션 소스

| AI | 기존 세션 | 새 작업 스트림 | 도움 AI 연결 |
|---|---|---|---|
| Claude | Claude Code 로컬 JSONL 대화 기록 | 구조화 headless 출력 | transcript의 subagent 기록 |
| Codex | Codex 로컬 rollout JSONL | `codex exec --json` | `thread_spawn` 부모 정보 |
| Gemini | Gemini 로컬 chat JSON/JSONL | 구조화 스트리밍 출력 | 제공되는 경우 부모 ID |
| Grok | Grok 로컬 session JSON/JSONL | 구조화 스트리밍 출력 | 제공되는 경우 부모 ID |

AI별 이벤트 매핑과 컨텍스트 계산 원칙은 [Provider Contracts](docs/PROVIDER-CONTRACTS.md)에 정리되어 있습니다.

## 릴리스

GitHub 태그 릴리스가 만들어지면 전체 테스트를 실행하고, 출처 증명이 포함된 npm 패키지를 발행하며, macOS·Windows 배포 파일을 빌드해 릴리스에 첨부합니다. 패키지 버전과 릴리스 태그는 같아야 합니다.

---

<div align="center">
  여러 AI를 동시에 쓰면서도 각각 무엇을 하는지 정확히 알고 싶은 사람을 위해 만들었습니다.
</div>
