'use strict';

function registerAgentIpc({ handleTrusted, snapshot, requestDetail, runner, isProviderVisible = () => true, probeProviders }) {
  handleTrusted('agents:snapshot', snapshot);
  handleTrusted('agents:detail', requestDetail);
  handleTrusted('agents:run', options => {
    if (!isProviderVisible(options && options.provider)) throw new Error('설정에서 숨긴 AI는 실행할 수 없습니다.');
    return runner().start(options);
  });
  handleTrusted('agents:stop', runId => runner().stop(runId));
  handleTrusted('agents:active-runs', () => runner().listActive().filter(run => isProviderVisible(run.provider)));
  handleTrusted('providers:probe', probeProviders);
}

module.exports = { registerAgentIpc };
