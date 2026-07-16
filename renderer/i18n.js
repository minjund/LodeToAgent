'use strict';

(() => {
  const STORAGE_KEY = 'loadtoagent:locale:v1';
  const SUPPORTED = new Set(['ko', 'en', 'zh-CN']);
  const LOCALE_TAGS = { ko: 'ko-KR', en: 'en-US', 'zh-CN': 'zh-CN' };
  const ATTRIBUTE_NAMES = ['aria-label', 'placeholder', 'title'];
  const IGNORE_SELECTOR = [
    '[data-i18n-ignore]', 'script', 'style', 'code', 'pre', '.xterm',
    '.chat-content', '.subagent-message-preview', '.terminal-history-message p',
    '.card-title', '.agent-task', '.agent-current strong', '.agent-flow-session-title',
    '.agent-flow-assignment strong', '.agent-flow-outcome-copy', '.conversation-preview',
    '#drawerTitle', '#releaseNotesText', '.terminal-target-meta b', '.terminal-screen',
  ].join(',');

  const rows = [
    ['LoadToAgent · AI 작업 도우미', 'LoadToAgent · AI Work Assistant', 'LoadToAgent · AI 工作助手'],
    ['AI 작업 도우미', 'AI Work Assistant', 'AI 工作助手'],
    ['본문으로 바로가기', 'Skip to main content', '跳到主要内容'],
    ['화면 선택', 'Choose view', '选择页面'],
    ['홈', 'Home', '首页'],
    ['진행 중', 'Active', '进行中'],
    ['내 확인 필요', 'Needs review', '需要我确认'],
    ['기존 세션에 이어서 입력', 'Continue an existing session', '继续现有会话'],
    ['세션 터미널', 'Session Terminal', '会话终端'],
    ['tmux 전용', 'tmux only', '仅限 tmux'],
    ['tmux 작업', 'tmux Workspaces', 'tmux 工作'],
    ['프로그램', 'Application', '应用'],
    ['설정', 'Settings', '设置'],
    ['더보기', 'More', '更多'],
    ['사용 가능한 AI', 'Available AI', '可用 AI'],
    ['AI 연결 상태 다시 확인', 'Check AI connections again', '重新检查 AI 连接'],
    ['작업 폴더', 'Workspaces', '工作文件夹'],
    ['작업 폴더 추가', 'Add workspace', '添加工作文件夹'],
    ['내 컴퓨터에서 안전하게', 'Secure on this computer', '安全保存在本机'],
    ['대화 기록은 이 PC에서만 읽습니다', 'Conversation history is read only on this PC', '对话记录仅在此电脑读取'],
    ['AI 작업 현황', 'AI Work Overview', 'AI 工作概览'],
    ['AI 작업을 한눈에 확인하세요.', 'See all AI work at a glance.', '一目了然地查看所有 AI 工作。'],
    ['진행 중인 일과 내 확인이 필요한 일을 먼저 보여주고, 나머지 기록은 아래에서 찾을 수 있습니다.', 'Active work and items needing your review appear first. Find everything else below.', '优先显示进行中的工作和需要您确认的事项，其余记录可在下方查看。'],
    ['현재 일하고 있는 AI를 확인하세요.', 'See which AI is working now.', '查看当前正在工作的 AI。'],
    ['무슨 일을 처리 중인지 보고, 작업을 누르면 AI 사이의 역할과 최신 진행 상황을 자세히 볼 수 있습니다.', 'See what is being handled, then open a task for AI roles and the latest progress.', '查看正在处理的内容，点击任务可详细了解 AI 之间的角色和最新进度。'],
    ['내 차례', 'Your turn', '轮到您了'],
    ['내 확인이 필요한 일을 먼저 처리하세요.', 'Handle items that need your review first.', '请优先处理需要您确认的事项。'],
    ['답변이나 선택을 기다리는 작업만 모았습니다. 항목을 열어 필요한 내용을 확인하세요.', 'Only tasks waiting for your response or choice are shown. Open one to review it.', '这里只显示等待您回复或选择的任务，请打开项目查看所需内容。'],
    ['기존 대화 이어가기', 'Continue an existing conversation', '继续现有对话'],
    ['AI 세션을 터미널에서 이어가세요.', 'Continue AI sessions in the terminal.', '在终端中继续 AI 会话。'],
    ['이전 대화와 실시간 명령창을 나란히 보며 같은 작업을 계속할 수 있습니다.', 'Continue the same task with its previous conversation beside the live terminal.', '在历史对话和实时终端并排显示的界面中继续同一任务。'],
    ['고급 작업 도구', 'Advanced work tools', '高级工作工具'],
    ['여러 명령창 작업을 한곳에서 관리하세요.', 'Manage multi-terminal work in one place.', '在一处管理多终端工作。'],
    ['tmux를 이미 사용하는 경우에만 필요한 화면입니다. 일반 작업은 홈과 세션 터미널만으로 충분합니다.', 'This view is only for existing tmux workflows. Home and Session Terminal cover regular work.', '此页面仅适用于已使用 tmux 的工作流。普通工作使用首页和会话终端即可。'],
    ['프로그램 관리', 'Application management', '应用管理'],
    ['버전과 업데이트를 확인하세요.', 'Check versions and updates.', '检查版本和更新。'],
    ['현재 설치 버전과 최신 정식 버전을 비교하고, 안전하게 검증된 설치 파일을 받을 수 있습니다.', 'Compare the installed and latest stable versions, then download a verified installer.', '比较当前安装版本与最新正式版本，并下载经过验证的安装文件。'],
    ['10분 시작 가이드', '10-minute quick start', '10 分钟快速入门'],
    ['새 AI 작업', 'New AI Task', '新建 AI 任务'],
    ['AI에게 새 일 맡기기', 'Assign a new task to AI', '向 AI 分配新任务'],
    ['연결 중', 'Connecting', '连接中'],
    ['현재 진행 중인 AI 작업', 'AI work currently in progress', '当前进行中的 AI 工作'],
    ['새 버전을 사용할 수 있습니다.', 'A new version is available.', '有新版本可用。'],
    ['설정에서 업데이트 파일을 받을 수 있습니다.', 'Download the update from Settings.', '可在设置中下载更新文件。'],
    ['업데이트 보기', 'View update', '查看更新'],

    ['환경 설정', 'Preferences', '偏好设置'],
    ['프로그램 설정', 'Application Settings', '应用设置'],
    ['표시 언어를 선택하고, 현재 설치된 버전과 최신 정식 버전을 확인할 수 있습니다.', 'Choose the display language and compare the installed version with the latest stable release.', '选择显示语言，并比较当前安装版本与最新正式版本。'],
    ['언어', 'Language', '语言'],
    ['표시 언어', 'Display language', '显示语言'],
    ['메뉴와 안내 문구에 사용할 언어를 선택하세요. 변경 사항은 바로 적용되고 다음 실행에도 유지됩니다.', 'Choose the language used for menus and guidance. Changes apply immediately and persist after restart.', '选择菜单和提示所使用的语言。更改将立即生效，并在下次启动时保留。'],
    ['앱 언어', 'App language', '应用语言'],
    ['업데이트', 'Updates', '更新'],
    ['설치 버전과 최신 버전 비교', 'Compare installed and latest versions', '比较已安装版本和最新版本'],
    ['현재 설치 버전', 'Installed version', '当前安装版本'],
    ['설치 방식 확인 중', 'Checking installation type', '正在检查安装方式'],
    ['버전 비교', 'Version comparison', '版本比较'],
    ['GitHub 최신 태그', 'Latest GitHub tag', 'GitHub 最新标签'],
    ['확인 전', 'Not checked', '尚未检查'],
    ['정식 릴리스 기준', 'Stable releases only', '以正式版本为准'],
    ['버전 상태', 'Version status', '版本状态'],
    ['업데이트 확인을 준비하고 있습니다.', 'Ready to check for updates.', '准备检查更新。'],
    ['GitHub의 최신 정식 릴리스를 확인합니다.', 'Checks the latest stable GitHub release.', '检查 GitHub 最新正式版本。'],
    ['최신 버전 확인 중', 'Checking latest version', '正在检查最新版本'],
    ['최신 버전을 확인하고 있습니다.', 'Checking the latest version.', '正在检查最新版本。'],
    ['최신 버전', 'Latest version', '最新版本'],
    ['업데이트 있음', 'Update available', '有可用更新'],
    ['이 컴퓨터에 맞는 설치 파일을 앱에서 안전하게 받을 수 있습니다.', 'A verified installer for this computer can be downloaded in the app.', '可在应用中安全下载适用于此电脑的已验证安装文件。'],
    ['릴리스는 확인했지만 맞는 설치 파일이 아직 준비되지 않았습니다.', 'The release exists, but a matching installer is not available yet.', '已找到新版本，但尚无匹配的安装文件。'],
    ['다운로드 중', 'Downloading', '正在下载'],
    ['업데이트 파일을 받고 있습니다.', 'Downloading the update file.', '正在下载更新文件。'],
    ['다운로드가 끝날 때까지 앱을 종료하지 마세요.', 'Keep the app open until the download finishes.', '下载完成前请勿退出应用。'],
    ['설치 준비 완료', 'Ready to install', '已准备安装'],
    ['업데이트 파일이 준비됐습니다.', 'The update file is ready.', '更新文件已准备就绪。'],
    ['설치 파일을 열고 화면의 안내에 따라 업데이트를 마무리하세요.', 'Open the installer and follow its instructions to finish updating.', '打开安装文件并按照屏幕提示完成更新。'],
    ['확인 실패', 'Check failed', '检查失败'],
    ['인터넷 연결을 확인한 뒤 다시 시도할 수 있습니다.', 'Check your internet connection and try again.', '请检查网络连接后重试。'],
    ['수동 업데이트', 'Manual update', '手动更新'],
    ['이 운영체제는 수동 업데이트가 필요합니다.', 'This operating system requires a manual update.', '此操作系统需要手动更新。'],
    ['GitHub 릴리스에서 최신 파일을 직접 확인하세요.', 'Get the latest file directly from GitHub Releases.', '请直接在 GitHub Releases 中获取最新文件。'],
    ['데스크톱 설치 파일', 'Desktop installer', '桌面安装版本'],
    ['npm 전역 설치본', 'Global npm installation', 'npm 全局安装版本'],
    ['로컬 개발 실행본', 'Local development build', '本地开发版本'],
    ['업데이트를 확인하고 있습니다.', 'Checking for updates.', '正在检查更新。'],
    ['GitHub의 최신 정식 릴리스 태그를 읽는 중입니다.', 'Reading the latest stable GitHub release tag.', '正在读取 GitHub 最新正式版本标签。'],
    ['업데이트 확인', 'Check for updates', '检查更新'],
    ['업데이트 파일 받기', 'Download update', '下载更新'],
    ['업데이트 파일 다운로드', 'Update download', '更新文件下载'],
    ['준비 중', 'Preparing', '准备中'],
    ['변경 사항', 'Release notes', '更新内容'],
    ['GitHub에서 전체 보기 ↗', 'View all on GitHub ↗', '在 GitHub 查看全部 ↗'],
    ['업데이트 기준', 'Update source', '更新来源'],
    ['GitHub 정식 릴리스', 'Stable GitHub releases', 'GitHub 正式版本'],
    ['초안과 프리릴리스는 제외하고, 패키지 버전보다 높은 태그만 안내합니다.', 'Drafts and prereleases are excluded; only tags newer than the installed package are shown.', '排除草稿和预发布版本，仅提示高于当前软件包版本的标签。'],
    ['파일 검증', 'File verification', '文件验证'],
    ['SHA-256 · 크기 확인', 'SHA-256 · Size check', 'SHA-256 · 大小校验'],
    ['GitHub가 제공하는 해시와 파일 크기가 다르면 설치 파일을 열지 않습니다.', 'The installer will not open if its hash or size differs from GitHub metadata.', '若哈希值或文件大小与 GitHub 元数据不符，将不会打开安装文件。'],
    ['런타임', 'Runtime', '运行时'],
    ['운영체제와 CPU에 맞는 Windows 설치 파일 또는 macOS DMG를 선택합니다.', 'Selects the Windows installer or macOS DMG that matches the OS and CPU.', '选择与操作系统和 CPU 匹配的 Windows 安装文件或 macOS DMG。'],
    ['현재 최신 버전입니다.', 'You are up to date.', '当前已是最新版本。'],
    ['설치된 버전이 GitHub의 최신 정식 릴리스와 같습니다.', 'The installed version matches the latest stable GitHub release.', '已安装版本与 GitHub 最新正式版本一致。'],
    ['새 업데이트가 있습니다.', 'A new update is available.', '有新的更新可用。'],
    ['이 컴퓨터에 맞는 설치 파일을 받을 수 있습니다.', 'An installer for this computer is available.', '可以下载适用于此电脑的安装文件。'],
    ['확인 중…', 'Checking…', '检查中…'],
    ['다운로드 중…', 'Downloading…', '下载中…'],
    ['설치 파일 열기', 'Open installer', '打开安装文件'],
    ['설치 파일 준비가 끝났습니다.', 'The installer is ready.', '安装文件已准备就绪。'],
    ['파일 검증 완료', 'File verified', '文件验证完成'],
    ['크기 확인 중', 'Checking size', '正在检查大小'],
    ['이 릴리스에 작성된 변경 사항이 없습니다.', 'No release notes were provided for this release.', '此版本未提供更新说明。'],

    ['첫 10분 코스', 'First 10 minutes', '前 10 分钟入门'],
    ['이 네 가지만 익히면 충분해요', 'These four steps are all you need', '掌握这四步就够了'],
    ['하나씩 눌러 직접 둘러보세요.', 'Try each step to explore the app.', '逐项点击，亲自体验应用。'],
    ['시작 가이드 진행률', 'Quick-start progress', '入门指南进度'],
    ['AI에게 일 맡기기', 'Assign work to AI', '向 AI 分配工作'],
    ['할 일과 작업 폴더를 고르면 바로 시작돼요.', 'Choose a task and workspace to get started.', '选择任务和工作文件夹即可开始。'],
    ['직접 해보기 →', 'Try it →', '立即尝试 →'],
    ['진행 상황 확인', 'Check progress', '查看进度'],
    ['초록 표시가 있는 AI는 지금 일하고 있어요.', 'AI with a green indicator is working now.', '带绿色标记的 AI 正在工作。'],
    ['진행 중 보기 →', 'View active work →', '查看进行中 →'],
    ['확인할 일 찾기', 'Find items to review', '查找待确认事项'],
    ['‘내 확인 필요’ 상태에는 답변이나 선택이 필요해요.', 'Items marked “Needs review” need a response or choice.', '标记为“需要我确认”的事项需要回复或选择。'],
    ['확인할 일 보기 →', 'View review items →', '查看待确认事项 →'],
    ['작업 자세히 보기', 'View task details', '查看任务详情'],
    ['대화, 진행 과정, 사용량을 한곳에서 확인해요.', 'See conversation, progress, and usage in one place.', '在一处查看对话、进度和用量。'],
    ['작업 열어보기 →', 'Open a task →', '打开任务 →'],
    ['가이드 접기', 'Collapse guide', '收起指南'],
    ['기본 사용법 완료', 'Basics completed', '基础使用已完成'],
    ['기본 사용법을 모두 익혔어요. 언제든 다시 열어볼 수 있습니다.', 'You completed the basics. You can reopen this guide anytime.', '您已掌握基础操作，随时可以重新打开本指南。'],

    ['대화와 실행 화면을 한곳에서', 'Conversation and execution together', '对话与执行同屏'],
    ['왼쪽에서 세션을 고르면 이전 AI 대화와 실시간 터미널을 나란히 보며 그대로 이어서 작업할 수 있습니다.', 'Choose a session on the left to continue with its prior AI conversation beside the live terminal.', '从左侧选择会话，即可在历史 AI 对话和实时终端旁继续工作。'],
    ['＋ Windows 세션', '＋ Windows session', '＋ Windows 会话'],
    ['＋ Linux 세션', '＋ Linux session', '＋ Linux 会话'],
    ['내 터미널 세션', 'My terminal sessions', '我的终端会话'],
    ['세션은 화면을 옮겨도 유지됩니다.', 'Sessions stay open when you change views.', '切换页面时会话仍会保持。'],
    ['다른 작업을 보고 돌아와도 출력과 작성 중인 명령이 그대로 남아 있어요.', 'Output and draft commands remain when you return from another view.', '查看其他工作后返回时，输出和正在编辑的命令仍会保留。'],
    ['세션을 선택해 주세요', 'Select a session', '请选择会话'],
    ['왼쪽 목록에서 이어갈 세션을 고르거나 새 세션을 만드세요.', 'Choose a session on the left or create a new one.', '从左侧列表选择要继续的会话，或新建会话。'],
    ['선택 대기', 'Waiting for selection', '等待选择'],
    ['현재 실행 중인 명령 중단', 'Interrupt the running command', '中断当前运行的命令'],
    ['실행 중단', 'Interrupt', '中断执行'],
    ['터미널 화면 정리', 'Clear terminal screen', '清理终端屏幕'],
    ['화면 정리', 'Clear', '清屏'],
    ['다시 시작', 'Restart', '重新启动'],
    ['직접 조작하기', 'Control directly', '直接操作'],
    ['세션 종료', 'End session', '结束会话'],
    ['작업 묶음 이름 바꾸기', 'Rename workspace', '重命名工作组'],
    ['창 추가', 'Add window', '添加窗口'],
    ['좌우로 나누기', 'Split left/right', '左右分割'],
    ['상하로 나누기', 'Split top/bottom', '上下分割'],
    ['창 배치', 'Window layout', '窗口布局'],
    ['바둑판', 'Tiled', '平铺'],
    ['같은 너비', 'Equal width', '等宽'],
    ['같은 높이', 'Equal height', '等高'],
    ['중요 창 위쪽', 'Main window on top', '主窗口在上'],
    ['중요 창 왼쪽', 'Main window on left', '主窗口在左'],
    ['선택한 칸 닫기', 'Close selected pane', '关闭所选窗格'],
    ['창 전체 닫기', 'Close entire window', '关闭整个窗口'],
    ['작업 묶음 끝내기', 'End workspace', '结束工作组'],
    ['선택한 AI의 이전 대화', 'Previous conversation for selected AI', '所选 AI 的历史对话'],
    ['AI 대화 기록', 'AI conversation history', 'AI 对话记录'],
    ['연결된 AI 세션', 'Connected AI session', '已连接的 AI 会话'],
    ['대화 기록을 불러오는 중', 'Loading conversation history', '正在加载对话记录'],
    ['대화 영역 접기', 'Collapse conversation panel', '收起对话区域'],
    ['이 대화가 오른쪽 터미널과 연결되어 있습니다', 'This conversation is connected to the terminal on the right', '此对话已连接到右侧终端'],
    ['실시간 터미널과 명령 입력', 'Live terminal and command input', '实时终端与命令输入'],
    ['실시간 터미널', 'Live terminal', '实时终端'],
    ['세션을 선택하면 출력이 여기에 표시됩니다', 'Select a session to show its output here', '选择会话后，输出将显示在此处'],
    ['이어갈 세션을 선택하세요', 'Choose a session to continue', '选择要继续的会话'],
    ['왼쪽 세션을 고르거나 새 세션을 만들면 실시간 출력과 명령 입력창이 열립니다.', 'Choose a session on the left or create one to open live output and command input.', '选择左侧会话或新建会话，即可打开实时输出和命令输入。'],
    ['터미널에 명령 보내기', 'Send command to terminal', '向终端发送命令'],
    ['Enter 전송 · Shift+Enter 줄바꿈', 'Enter to send · Shift+Enter for newline', 'Enter 发送 · Shift+Enter 换行'],
    ['먼저 왼쪽에서 세션을 선택하세요', 'Select a session on the left first', '请先从左侧选择会话'],
    ['보내기', 'Send', '发送'],
    ['세션을 선택하면 바로 입력할 수 있습니다.', 'Select a session to start typing.', '选择会话后即可输入。'],

    ['tmux 전용 공간', 'tmux workspace', 'tmux 专用空间'],
    ['tmux로 묶은 작업', 'Work grouped with tmux', '使用 tmux 分组的工作'],
    ['tmux를 사용하는 작업만 모아 봅니다. 일반 명령창은 이 화면에 섞이지 않습니다.', 'Only work using tmux appears here. Regular terminals are kept separate.', '此处仅显示使用 tmux 的工作，普通终端不会混入。'],
    ['↻ 새로고침', '↻ Refresh', '↻ 刷新'],
    ['＋ tmux 작업 만들기', '＋ Create tmux workspace', '＋ 创建 tmux 工作组'],
    ['tmux 탐색 경로', 'tmux navigation path', 'tmux 导航路径'],
    ['전체 목록으로', 'Back to all', '返回全部列表'],
    ['tmux 전용 조작', 'tmux controls', 'tmux 专用操作'],
    ['선택한 tmux 명령창', 'Selected tmux terminal', '所选 tmux 终端'],
    ['위 지도에서 칸을 고르면 출력 확인, 명령 전송, 창 나누기와 종료를 여기서 처리합니다.', 'Choose a pane in the map above to view output, send commands, split panes, or close them here.', '在上方地图中选择窗格后，可在此查看输出、发送命令、分割或关闭窗格。'],
    ['tmux 안의 명령창만', 'tmux terminals only', '仅显示 tmux 终端'],
    ['일반 명령창은 표시하지 않음', 'Regular terminals are hidden', '不显示普通终端'],
    ['tmux 명령창 조작', 'Control tmux terminals', '操作 tmux 终端'],
    ['여러 명령창 작업 보기', 'View multi-terminal work', '查看多终端工作'],

    ['지금 진행 중', 'Active now', '正在进行'],
    ['AI들이 맡은 일', 'Work assigned to AI', 'AI 负责的工作'],
    ['일을 누르면 누가 시작했고, 다른 AI에게 어떤 도움을 맡겼는지 쉽게 볼 수 있습니다.', 'Open a task to see who started it and what help was delegated to other AI.', '点击任务即可查看由谁发起，以及向其他 AI 分配了哪些协助。'],
    ['에이전트 탐색 경로', 'Agent navigation path', '智能体导航路径'],
    ['작업 목록으로', 'Back to task list', '返回任务列表'],
    ['전체 통계', 'Overall statistics', '总体统计'],
    ['AI별 현황', 'Status by AI', '各 AI 状态'],
    ['지난 기록', 'History', '历史记录'],
    ['최근 대화와 작업', 'Recent conversations and tasks', '最近的对话和任务'],
    ['진행 중인 작업', 'Active tasks', '进行中的任务'],
    ['내 확인이 필요한 작업', 'Tasks needing review', '需要我确认的任务'],
    ['작업 검색', 'Search tasks', '搜索任务'],
    ['작업 이름, AI, 폴더 찾기', 'Find task, AI, or folder', '查找任务、AI 或文件夹'],
    ['AI 제공사 필터', 'AI provider filter', 'AI 提供商筛选'],
    ['모든 AI', 'All AI', '所有 AI'],
    ['정렬', 'Sort', '排序'],
    ['최근에 움직인 순서', 'Most recently active', '最近活动优先'],
    ['많이 사용한 순서', 'Highest usage', '使用量最高优先'],
    ['기억 공간을 많이 쓴 순서', 'Highest context usage', '记忆空间使用最高优先'],
    ['작업 더 보기', 'Show more tasks', '显示更多任务'],
    ['아직 보여줄 작업이 없습니다', 'No tasks to show yet', '暂无可显示的任务'],
    ['검색 조건을 바꾸거나 AI에게 새 일을 맡겨보세요.', 'Change the search filters or assign a new task to AI.', '请更改搜索条件或向 AI 分配新任务。'],
    ['AI 작업', 'AI Task', 'AI 任务'],
    ['닫기', 'Close', '关闭'],
    ['대화 내용', 'Conversation', '对话内容'],
    ['진행 과정', 'Progress', '进度'],
    ['사용량', 'Usage', '用量'],
    ['모든 작업 폴더', 'All workspaces', '所有工作文件夹'],
    ['프로젝트 없음', 'No project', '无项目'],
    ['특정 프로젝트에 연결되지 않은 세션', 'Session not linked to a specific project', '未连接到特定项目的会话'],
    ['목록에서 제거', 'Remove from list', '从列表中移除'],
    ['＋ 버튼으로 자주 쓰는 작업 폴더를 등록할 수 있습니다.', 'Use the ＋ button to add frequently used workspaces.', '使用 ＋ 按钮可添加常用工作文件夹。'],
    ['전체 작업', 'All tasks', '全部任务'],
    ['지금 일하는 AI', 'AI working now', '正在工作的 AI'],
    ['내 확인 기다림', 'Waiting for review', '等待确认'],
    ['도움 AI 기록', 'Helper AI history', '协助 AI 记录'],
    ['사용한 토큰', 'Tokens used', '已用令牌'],
    ['개', 'items', '个'],
    ['사용 가능', 'Available', '可用'],
    ['활동 AI', 'Active AI', '活跃 AI'],
    ['메인 작업', 'Main tasks', '主要任务'],
    ['사용 토큰', 'Tokens used', '已用令牌'],
    ['검색 결과가 없습니다', 'No search results', '没有搜索结果'],
    ['검색어를 지우거나 AI와 작업 폴더 필터를 바꿔보세요.', 'Clear the search or change the AI and workspace filters.', '请清除搜索词，或更改 AI 和工作文件夹筛选条件。'],
    ['현재 진행 중인 작업이 없습니다', 'No tasks are currently active', '当前没有进行中的任务'],
    ['새 일을 맡기면 진행 상황이 이곳에 바로 표시됩니다.', 'New tasks will show their progress here immediately.', '分配新任务后，进度会立即显示在此处。'],
    ['모두 확인했습니다', 'All caught up', '全部已确认'],
    ['지금은 내 답변이나 선택을 기다리는 작업이 없습니다.', 'No tasks are waiting for your response or choice.', '目前没有任务在等待您的回复或选择。'],
    ['AI 준비 상태를 확인한 뒤 첫 작업을 시작해보세요.', 'Check AI readiness, then start your first task.', '检查 AI 准备状态后，开始第一个任务。'],
    ['자료 조사', 'Research', '资料调查'],
    ['검토', 'Review', '审查'],
    ['실행', 'Execution', '执行'],
    ['도움', 'Assistance', '协助'],
    ['계획', 'Planning', '规划'],
    ['시험', 'Testing', '测试'],
    ['활동', 'Activity', '活动'],
    ['잠시 쉬는 중', 'Temporarily idle', '暂时空闲'],
    ['확인 필요', 'Needs attention', '需要确认'],

    ['AI 작업 시작', 'Start AI task', '开始 AI 任务'],
    ['무슨 일을 맡길까요?', 'What should the AI work on?', '要让 AI 做什么？'],
    ['할 일을 먼저 적고, 어떤 AI가 어디서 작업할지 선택하세요.', 'Describe the task, then choose which AI will work in which folder.', '先描述任务，再选择由哪个 AI 在哪个文件夹中工作。'],
    ['새 작업 창 닫기', 'Close new task dialog', '关闭新任务窗口'],
    ['할 일 적기', 'Describe the task', '填写任务'],
    ['결과와 제약을 함께 적으면 더 정확해요.', 'Include the expected result and constraints for better accuracy.', '同时写明预期结果和限制条件会更准确。'],
    ['AI에게 맡길 일', 'Task for AI', '交给 AI 的任务'],
    ['예: 로그인 화면의 오류를 찾아 고치고, 관련 테스트까지 실행해줘', 'Example: Find and fix the login screen error, then run the related tests', '例如：查找并修复登录页面错误，然后运行相关测试'],
    ['빠른 요청 예시', 'Quick prompt examples', '快速请求示例'],
    ['오류 수정', 'Fix a bug', '修复错误'],
    ['코드 검토', 'Review code', '代码审查'],
    ['테스트 추가', 'Add tests', '添加测试'],
    ['실행 방법 선택', 'Choose how to run', '选择运行方式'],
    ['AI와 작업 폴더만 고르면 준비가 끝납니다.', 'Choose an AI and workspace to finish setup.', '选择 AI 和工作文件夹即可完成准备。'],
    ['어떤 AI에게 맡길까요?', 'Which AI should handle it?', '交给哪个 AI？'],
    ['프로젝트 폴더를 선택하세요', 'Choose a project folder', '请选择项目文件夹'],
    ['폴더 찾기', 'Browse', '浏览'],
    ['최근 작업 폴더', 'Recent workspaces', '最近的工作文件夹'],
    ['AI가 파일을 고칠 수 있게 허용', 'Allow AI to edit files', '允许 AI 修改文件'],
    ['켜면 선택한 폴더의 파일을 직접 수정합니다.', 'When enabled, the AI can directly edit files in the selected folder.', '启用后，AI 可直接修改所选文件夹中的文件。'],
    ['이 요청은 파일 수정이 필요해 보여요. 위의 수정 허용을 켜지 않으면 AI가 코드 변경 없이 검토만 합니다.', 'This request appears to need file changes. Without edit permission, the AI will only review the code.', '此请求似乎需要修改文件。若不启用修改权限，AI 将仅审查代码而不会更改。'],
    ['고급 설정', 'Advanced settings', '高级设置'],
    ['특정 모델을 직접 지정할 때만 사용', 'Use only when selecting a specific model', '仅在指定特定模型时使用'],
    ['사용 모델', 'Model', '使用模型'],
    ['몰라도 비워두세요', 'Leave blank if unsure', '不确定时请留空'],
    ['비워두면 AI가 알아서 선택합니다', 'Leave blank to let the AI choose', '留空则由 AI 自动选择'],
    ['시작', 'Start', '开始'],
    ['취소', 'Cancel', '取消'],
    ['AI에게 맡기기', 'Assign to AI', '交给 AI'],

    ['고급 기능과 설정', 'Advanced tools and settings', '高级功能与设置'],
    ['필요할 때만 여는 고급 기능이에요.', 'Advanced tools to open only when needed.', '仅在需要时打开的高级功能。'],
    ['기존 AI 대화를 직접 이어서 입력', 'Continue an existing AI conversation directly', '直接继续现有 AI 对话'],
    ['여러 명령창을 묶어 관리', 'Manage multiple terminals together', '集中管理多个终端'],
    ['버전과 업데이트 확인', 'Check version and updates', '检查版本和更新'],
    ['고급 작업', 'Advanced work', '高级工作'],
    ['여러 창 작업 만들기', 'Create multi-window workspace', '创建多窗口工作组'],
    ['여러 창 작업 만들기 닫기', 'Close multi-window workspace dialog', '关闭多窗口工作组窗口'],
    ['tmux 환경', 'tmux environment', 'tmux 环境'],
    ['작업 묶음 이름', 'Workspace name', '工作组名称'],
    ['시작 폴더', 'Starting folder', '起始文件夹'],
    ['선택 사항', 'Optional', '可选'],
    ['프로젝트의 절대 경로', 'Absolute project path', '项目绝对路径'],
    ['처음 실행할 명령', 'Initial command', '初始命令'],
    ['예: claude 또는 codex', 'Example: claude or codex', '例如：claude 或 codex'],
    ['작업 묶음 만들기', 'Create workspace', '创建工作组'],

    ['준비된 AI CLI가 없습니다. 공식 설치 안내를 따라 설치·로그인한 뒤 다시 확인해 주세요.', 'No AI CLI is ready. Follow the official setup guide, sign in, and check again.', '没有可用的 AI CLI。请按照官方安装指南安装并登录，然后重新检查。'],
    ['실행을 시작하지 못했습니다.', 'Could not start the task.', '无法启动任务。'],
    ['업데이트를 확인하지 못했습니다.', 'Could not check for updates.', '无法检查更新。'],
    ['업데이트 파일을 준비하지 못했습니다.', 'Could not prepare the update file.', '无法准备更新文件。'],
    ['GitHub 릴리스 페이지를 열지 못했습니다.', 'Could not open the GitHub release page.', '无法打开 GitHub 发布页面。'],
    ['AI CLI 연결 상태를 다시 확인했습니다.', 'AI CLI connections were checked again.', '已重新检查 AI CLI 连接状态。'],
    ['중지 요청을 보냈습니다.', 'Stop request sent.', '已发送停止请求。'],
    ['중지 요청을 보내지 못했습니다.', 'Could not send the stop request.', '无法发送停止请求。'],
    ['연결 실패', 'Connection failed', '连接失败'],
    ['설치 필요', 'Setup required', '需要安装'],
    ['CLI 발견됨', 'CLI found', '已找到 CLI'],
    ['완료', 'Completed', '已完成'],
    ['일하는 중', 'Working', '工作中'],
    ['쉬는 중', 'Idle', '空闲'],
    ['문제 발생', 'Problem', '出现问题'],
    ['중지됨', 'Stopped', '已停止'],
    ['직접 입력 가능', 'Direct input available', '可直接输入'],
    ['종료된 세션', 'Ended session', '已结束会话'],
    ['종료된 칸', 'Ended pane', '已结束窗格'],
    ['명령 전송 가능', 'Ready for commands', '可发送命令'],
    ['AI에게 이어서 지시', 'Continue instructing AI', '继续向 AI 发出指令'],
    ['tmux 명령창에 보내기', 'Send to tmux terminal', '发送到 tmux 终端'],
    ['실행할 명령을 입력하세요', 'Enter a command to run', '输入要运行的命令'],
  ];

  const catalog = Object.fromEntries(rows.map(([ko, en, zh]) => [ko, { en, 'zh-CN': zh }]));
  const textSources = new WeakMap();
  const textRendered = new WeakMap();
  const attributeSources = new WeakMap();
  const attributeRendered = new WeakMap();
  let locale = readLocale();

  function readLocale() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return SUPPORTED.has(saved) ? saved : 'ko';
    } catch {
      return 'ko';
    }
  }

  function preserveSpacing(source, translated) {
    const leading = source.match(/^\s*/)?.[0] || '';
    const trailing = source.match(/\s*$/)?.[0] || '';
    return `${leading}${translated}${trailing}`;
  }

  function applyRules(source, targetLocale) {
    const rules = targetLocale === 'en' ? [
      [/^(\d+) \/ (\d+) 완료$/, '$1 / $2 complete'],
      [/^(\d+)단계 남았어요\. 하나씩 눌러 직접 둘러보세요\.$/, '$1 steps left. Try each one to explore the app.'],
      [/^(\d+)초 전$/, '$1 sec ago'], [/^(\d+)분 전$/, '$1 min ago'], [/^(\d+)시간 전$/, '$1 hr ago'], [/^(\d+)일 전$/, '$1 days ago'],
      [/^방금 전$/, 'Just now'],
      [/^(\d+)개 실행 중$/, '$1 running'], [/^(\d+)개 유지 중$/, '$1 active'],
      [/^작업 더 보기 · (\d+)개 남음$/, 'Show more tasks · $1 remaining'],
      [/^새 버전 v(.+)을 사용할 수 있습니다\.$/, 'Version v$1 is available.'],
      [/^설치된 v(.+)이 GitHub의 최신 정식 버전과 같습니다\.$/, 'Installed v$1 matches the latest stable GitHub release.'],
      [/^v(.+) 업데이트가 있습니다\.$/, 'Update v$1 is available.'],
      [/^(.+) 공개$/, 'Published $1'],
      [/^(.+)에게 맡기기$/, 'Assign to $1'],
      [/^(.+) 작업을 시작했습니다\. ‘진행 중’ 화면에서 상태를 확인하세요\.$/, '$1 task started. Check its status in Active.'],
      [/^(.+) 설치 안내$/, '$1 setup guide'],
      [/^(\d+)개 항목$/, '$1 items'], [/^(\d+)건$/, '$1 events'], [/^(\d+)개$/, '$1'], [/^(\d+)명$/, '$1 agents'],
      [/^대화 (\d+)개$/, '$1 messages'], [/^최근 (\d+)개 표시$/, 'Showing latest $1'],
      [/^전체 (\d+)개$/, '$1 total'], [/^AI 백그라운드 (\d+)개$/, '$1 AI background'],
    ] : [
      [/^(\d+) \/ (\d+) 완료$/, '已完成 $1 / $2'],
      [/^(\d+)단계 남았어요\. 하나씩 눌러 직접 둘러보세요\.$/, '还剩 $1 步。请逐项点击体验。'],
      [/^(\d+)초 전$/, '$1 秒前'], [/^(\d+)분 전$/, '$1 分钟前'], [/^(\d+)시간 전$/, '$1 小时前'], [/^(\d+)일 전$/, '$1 天前'],
      [/^방금 전$/, '刚刚'],
      [/^(\d+)개 실행 중$/, '$1 个运行中'], [/^(\d+)개 유지 중$/, '$1 个保持中'],
      [/^작업 더 보기 · (\d+)개 남음$/, '显示更多任务 · 剩余 $1 个'],
      [/^새 버전 v(.+)을 사용할 수 있습니다\.$/, '新版本 v$1 可用。'],
      [/^설치된 v(.+)이 GitHub의 최신 정식 버전과 같습니다\.$/, '已安装的 v$1 与 GitHub 最新正式版本一致。'],
      [/^v(.+) 업데이트가 있습니다\.$/, 'v$1 更新可用。'],
      [/^(.+) 공개$/, '发布于 $1'],
      [/^(.+)에게 맡기기$/, '交给 $1'],
      [/^(.+) 작업을 시작했습니다\. ‘진행 중’ 화면에서 상태를 확인하세요\.$/, '$1 任务已启动。请在“进行中”页面查看状态。'],
      [/^(.+) 설치 안내$/, '$1 安装指南'],
      [/^(\d+)개 항목$/, '$1 个项目'], [/^(\d+)건$/, '$1 条'], [/^(\d+)개$/, '$1 个'], [/^(\d+)명$/, '$1 个智能体'],
      [/^대화 (\d+)개$/, '$1 条对话'], [/^최근 (\d+)개 표시$/, '显示最近 $1 条'],
      [/^전체 (\d+)개$/, '共 $1 个'], [/^AI 백그라운드 (\d+)개$/, '$1 个 AI 后台任务'],
    ];
    for (const [pattern, replacement] of rules) {
      if (pattern.test(source)) return source.replace(pattern, replacement);
    }
    return source;
  }

  function t(source, requestedLocale = locale) {
    const value = String(source == null ? '' : source);
    if (requestedLocale === 'ko' || !value.trim()) return value;
    const core = value.trim();
    const translated = catalog[core]?.[requestedLocale] || applyRules(core, requestedLocale);
    return translated === core ? value : preserveSpacing(value, translated);
  }

  function ignored(node) {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return !element || Boolean(element.closest(IGNORE_SELECTOR));
  }

  function translateTextNode(node, force = false) {
    if (!node || node.nodeType !== Node.TEXT_NODE || ignored(node)) return;
    const current = node.nodeValue || '';
    if (!force && textRendered.get(node) === current) return;
    if (!force || !textSources.has(node)) textSources.set(node, current);
    const source = textSources.get(node);
    const next = t(source);
    textRendered.set(node, next);
    if (current !== next) node.nodeValue = next;
  }

  function translateAttributes(element, force = false) {
    if (!(element instanceof Element) || ignored(element)) return;
    const sources = attributeSources.get(element) || {};
    const rendered = attributeRendered.get(element) || {};
    for (const name of ATTRIBUTE_NAMES) {
      if (!element.hasAttribute(name)) continue;
      const current = element.getAttribute(name) || '';
      if (!force && rendered[name] === current) continue;
      if (!force || !(name in sources)) sources[name] = current;
      const next = t(sources[name]);
      rendered[name] = next;
      if (current !== next) element.setAttribute(name, next);
    }
    attributeSources.set(element, sources);
    attributeRendered.set(element, rendered);
  }

  function translateTree(root, force = false) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) return translateTextNode(root, force);
    if (root instanceof Element) translateAttributes(root, force);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (node.nodeType === Node.TEXT_NODE) translateTextNode(node, force);
      else translateAttributes(node, force);
      node = walker.nextNode();
    }
  }

  function syncDocument() {
    document.documentElement.lang = locale === 'zh-CN' ? 'zh-CN' : locale;
    document.documentElement.dataset.locale = locale;
    const select = document.querySelector('#languageSelect');
    if (select) select.value = locale;
  }

  function setLocale(nextLocale) {
    if (!SUPPORTED.has(nextLocale) || nextLocale === locale) return false;
    locale = nextLocale;
    try { localStorage.setItem(STORAGE_KEY, locale); } catch {}
    syncDocument();
    translateTree(document.documentElement, true);
    window.dispatchEvent(new CustomEvent('loadtoagent:locale-changed', { detail: { locale, localeTag: LOCALE_TAGS[locale] } }));
    return true;
  }

  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'characterData') translateTextNode(record.target);
      else if (record.type === 'attributes') translateAttributes(record.target);
      else record.addedNodes.forEach(node => translateTree(node));
    }
  });

  window.LoadToAgentI18n = {
    getLocale: () => locale,
    getLocaleTag: () => LOCALE_TAGS[locale],
    getSupportedLocales: () => ['ko', 'en', 'zh-CN'],
    setLocale,
    t,
    translateTree,
  };

  syncDocument();
  translateTree(document.documentElement);
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTE_NAMES });
  document.addEventListener('change', event => {
    if (event.target?.id === 'languageSelect') setLocale(event.target.value);
  });
})();
