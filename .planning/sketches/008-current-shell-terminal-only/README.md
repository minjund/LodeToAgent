---
sketch: 008
name: current-shell-terminal-only
question: "현재 LoadToAgent 디자인을 전혀 바꾸지 않고 세션 대화 영역만 동일 PTY 터미널로 교체할 수 있는가?"
winner: null
tags: [current-ui, terminal-only, drawer, pty, minimal-change, storyboard]
---

# 스케치 008: Current Shell, Terminal Only Change

## 디자인 질문

현재 메인, 프로젝트 사이드바, AI 사용량, 프로젝트 선택 화면, 프로젝트 상세, 세션 드로어 헤더와 탭을 그대로 둔 채 `대화` 탭의 본문과 입력만 동일 PTY 터미널로 바꿀 수 있는가?

## 변경하지 않는 영역

- 실제 `renderer/index.html`과 테스트 픽스처에서 캡처한 프로젝트 미선택 화면
- 실제 프로젝트 선택 후 화면의 사이드바, 상단 AI 사용량, 상태 탭, 확인 대기 카드와 세션 카드
- 현재 세션 드로어의 위치, 헤더, 제목, 메타 정보, 닫기, 새 대화, `요약 / 대화 / 진행 과정 / 사용량` 탭
- 현재 앱의 색상, 타이포그래피, 간격과 테두리 문법

## 변경하는 영역

- `대화` 탭의 구조화된 메시지 목록을 raw PTY와 scrollback으로 교체
- 하단 메시지 입력을 같은 PTY에 쓰는 터미널 입력으로 교체
- `PTY 연결됨`, 메시지 전달됨, 실행 중, 내 답변 대기 상태를 터미널 내부에 표시

## 변형

- **A · 현재 드로어 폭** — 현재 640px 수준의 드로어 폭과 앱 레이아웃을 그대로 유지한다. 전체 디자인 불변 원칙에 가장 충실하다.
- **B · 넓은 터미널** — 셸과 구성요소는 그대로 두고 터미널 드로어 폭만 820px로 넓힌다. 긴 명령과 출력 가독성이 좋아진다.

## 스토리 순서

1. 현재 메인 화면에서 프로젝트 선택
2. 현재 프로젝트 화면에서 실행 중 세션 선택
3. 현재 세션 드로어의 `대화` 본문만 터미널로 표시
4. 같은 터미널에서 에이전트 질문을 보고 바로 답변

## 보는 방법

`index.html`을 열고 하단의 01~04 장면을 누른다. 상단 A/B는 터미널 영역 폭만 비교한다. `클릭 영역`을 켜면 실제 이동 대상이 표시된다.

## 기준 이미지

- `artifacts/loadtoagent-project-selection.png`
- `artifacts/loadtoagent-project-selected-all-visible.png`

두 이미지는 현재 렌더러의 `scripts/project-selection-visual.js`를 실행해 생성했다.
