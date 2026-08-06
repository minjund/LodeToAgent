# Sketch Manifest

## Design direction

LoadToAgent의 핵심 정보인 사용자 판단, 실행 관계, 완료 기록을 유지하면서 “보이지 않는 AI의 일을 관측한다”는 정체성을 명확한 시각 문법으로 번역한다. 초기 실험은 우주·의식·존재론의 형이상학적 은유를 탐색했고, 이후 방향은 장식을 걷어내고 메인 에이전트 → 서브에이전트·PowerShell → 결과라는 인과관계 자체를 제품의 미학으로 삼는다. 모든 실행 단위는 보이되 현재의 움직임과 사용자의 판단만 강하게 말한다.

## Reference points

- LoadToAgent의 실제 데이터 구조: 진행 중 9, 확인 필요 3, 완료 36
- 기존 control-room UI의 메인 에이전트 → 서브에이전트 → 결과 정리 관계
- 사용자가 요청한 우주·신비주의·철학적 추상의 세 방향
- 현재 Electron UI의 실제 실행 단위: 서브에이전트, PowerShell, 백그라운드 작업, 완료 증거
- “한눈에 보인다”를 장식이 아닌 인과·위임·시간의 문법으로 해석

## Sketches

| # | Name | Design question | Winner | Tags |
|---|------|-----------------|--------|------|
| 001 | metaphysical-directions | 형이상학적 세계관 중 어떤 시각 문법이 AI 관제에 가장 자연스러운가? | — | metaphysical, full-shell, dashboard |
| 002 | agent-flow-atlas | 메인 에이전트, 서브에이전트, PowerShell 실행을 기능 손실 없이 한눈에 읽게 하는 가장 단순한 시각 문법은 무엇인가? | A · 인과선 | layout, agent-flow, subagents, powershell |
| 003 | causal-spine-workbench | 여러 세션의 인과선을 한 화면에 유지하면서 현재 구현된 전체 기능을 어디에 배치해야 단순함이 보존되는가? | A | multi-session, causal-lines, full-shell, navigation, context-dock, terminal, tmux |
| 004 | intent-lineage | 에이전트 관제 화면을 기능 대시보드가 아니라 인간의 의도와 AI 행위의 관계를 보여주는 철학적 인터페이스로 만들 수 있는가? | — | philosophy, intent, provenance, causal-lines, multi-session |
| 005 | project-first-workspace | 왼쪽 프로젝트를 기준으로 지금 하는 일, 진행 중인 세션, 지난 작업을 어떻게 보여줘야 가장 빠르게 이해되는가? | — | project-first, sidebar, sessions, history, status |
| 006 | terminal-first-agent-session | 에이전트 대화를 별도 채팅 화면으로 분리하지 않고, 터미널을 항상 보이는 세션 원본으로 만들려면 어떤 정보층이 필요한가? | — | terminal-first, pty, agent-session, native-chat, multi-session |
| 007 | project-to-terminal-story | 메인에서 프로젝트를 발견하고 실행 중 세션의 터미널에 개입하기까지 화면 전환이 하나의 연속된 이야기로 읽히는가? | — | storyboard, project-first, session-drilldown, terminal-first, attention |
| 008 | current-shell-terminal-only | 현재 LoadToAgent 디자인을 전혀 바꾸지 않고 세션 대화 영역만 동일 PTY 터미널로 교체할 수 있는가? | — | current-ui, terminal-only, drawer, pty, minimal-change |
| 009 | inline-pty-toggle | 현재 화면을 그대로 둔 채 오른쪽 세션 팝업만 클릭한 AI 에이전트 행 바로 아래의 PTY로 바꾸고 기존 상세 정보를 작업 진행 화면에 넣을 수 있는가? | 최소 변경안 | current-ui, inline-pty, detail-view, minimal-change |
