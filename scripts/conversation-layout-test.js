const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const drawer = fs.readFileSync(path.join(root, "renderer", "app-drawer.js"), "utf8");
const events = fs.readFileSync(path.join(root, "renderer", "app-events-dialogs.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "renderer", "styles-control-room.css"), "utf8");

assert.match(
  drawer,
  /const CONTEXT_DRAWER_MIN_WIDTH = 1680;/,
  "대화 패널의 2분할 최소 폭은 1680px이어야 합니다.",
);
assert.match(
  drawer,
  /window\.innerWidth >= CONTEXT_DRAWER_MIN_WIDTH/,
  "대화창을 열 때 현재 창 폭으로 2분할 여부를 결정해야 합니다.",
);
assert.match(
  events,
  /window\.innerWidth < CONTEXT_DRAWER_MIN_WIDTH && state\.drawerPresentation === "context"/,
  "창이 1680px 미만으로 줄면 2분할 대화 패널을 정리해야 합니다.",
);
assert.match(
  events,
  /window\.innerWidth - CONTEXT_WORKSPACE_MIN_WIDTH/,
  "2분할 대화 패널은 본문에 필요한 최소 폭을 남겨야 합니다.",
);
assert.match(
  styles,
  /@media \(min-width:1680px\)\s*\{\s*body\.conversation-context-open #appShell/,
  "2분할 레이아웃 CSS는 1680px 이상에서만 적용되어야 합니다.",
);
assert.doesNotMatch(
  styles,
  /@media \(min-width:1280px\)\s*\{\s*body\.conversation-context-open #appShell/,
  "1280px 대화 패널 분할 규칙이 다시 생기면 본문이 눌립니다.",
);

console.log("conversation layout tests passed");
