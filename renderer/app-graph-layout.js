"use strict";

window.WhiteboxAppFactories = window.WhiteboxAppFactories || {};

window.WhiteboxAppFactories.createGraphLayout = function createGraphLayout(context = {}) {
  const {
    $,
  } = context;

  let agentWorkflowFrame = 0;

  function workflowPortPoint(port, canvasRect) {
    const rect = port.getBoundingClientRect();
    return { x: rect.left - canvasRect.left + rect.width / 2, y: rect.top - canvasRect.top + rect.height / 2 };
  }

  function workflowCurve(from, to) {
    const horizontal = Math.abs(to.x - from.x) >= Math.abs(to.y - from.y);
    if (horizontal) {
      const distance = Math.max(34, Math.abs(to.x - from.x) * 0.48);
      return [
        `M ${from.x.toFixed(1)} ${from.y.toFixed(1)}`,
        `C ${(from.x + distance).toFixed(1)} ${from.y.toFixed(1)},`,
        `${(to.x - distance).toFixed(1)} ${to.y.toFixed(1)},`,
        `${to.x.toFixed(1)} ${to.y.toFixed(1)}`,
      ].join(" ");
    }
    const distance = Math.max(34, Math.abs(to.y - from.y) * 0.48);
    return [
      `M ${from.x.toFixed(1)} ${from.y.toFixed(1)}`,
      `C ${from.x.toFixed(1)} ${(from.y + distance).toFixed(1)},`,
      `${to.x.toFixed(1)} ${(to.y - distance).toFixed(1)},`,
      `${to.x.toFixed(1)} ${to.y.toFixed(1)}`,
    ].join(" ");
  }

  function drawAgentWorkflowConnections() {
    const canvas = document.querySelector(".agent-workflow-canvas");
    if (!canvas || !canvas.isConnected) return;
    const svg = canvas.querySelector(".agent-workflow-edges");
    const paths = svg && svg.querySelector("[data-workflow-paths]");
    const upstream = canvas.querySelector('[data-workflow-port="upstream-output"]');
    const focusInput = canvas.querySelector('[data-workflow-port="focus-input"]');
    const focusOutput = canvas.querySelector('[data-workflow-port="focus-output"]');
    const childrenGroupInput = canvas.querySelector('[data-workflow-port="children-group-input"]');
    if (!svg || !paths || !upstream || !focusInput) return;
    const rect = canvas.getBoundingClientRect();
    svg.setAttribute("viewBox", `0 0 ${Math.max(1, rect.width)} ${Math.max(1, rect.height)}`);
    const upstreamPath = `<path class="agent-workflow-edge upstream branch"
      data-workflow-edge-kind="upstream" pathLength="1"
      d="${workflowCurve(workflowPortPoint(upstream, rect), workflowPortPoint(focusInput, rect))}"
      marker-end="url(#workflowArrow)">
      </path>`;
    const downstreamPath =
      focusOutput && childrenGroupInput
        ? `<path class="agent-workflow-edge downstream group"
          data-workflow-edge-kind="children-group" pathLength="1"
          d="${workflowCurve(workflowPortPoint(focusOutput, rect), workflowPortPoint(childrenGroupInput, rect))}"
          marker-end="url(#workflowArrow)">
        </path>`
        : "";
    paths.innerHTML = `${upstreamPath}${downstreamPath}`;
  }

  function scheduleAgentWorkflowConnections() {
    cancelAnimationFrame(agentWorkflowFrame);
    agentWorkflowFrame = requestAnimationFrame(() => requestAnimationFrame(drawAgentWorkflowConnections));
  }

  return { agentWorkflowFrame, workflowPortPoint, workflowCurve, drawAgentWorkflowConnections, scheduleAgentWorkflowConnections };
};
