'use strict';

const MUTATING_OPERATIONS = [
  'new-session',
  'new-window',
  'split-pane',
  'rename-session',
  'rename-window',
  'select-layout',
  'kill-pane',
  'kill-window',
  'kill-session',
];

function registerTmuxIpc({ handleTrusted, controller, refresh }) {
  handleTrusted('tmux:send-text', async options => {
    try {
      return await controller.sendText(options || {});
    } catch (error) {
      if (error?.deliveryState === 'rejected') {
        return {
          ok: false,
          error: String(error.message || error),
          code: String(error.code || ''),
          deliveryId: String(error.deliveryId || options?.deliveryId || ''),
          deliveryState: 'rejected',
        };
      }
      throw error;
    }
  });
  handleTrusted('tmux:send-key', options => controller.sendKey(options || {}));
  handleTrusted('tmux:capture', options => controller.capture(options || {}));

  for (const operation of MUTATING_OPERATIONS) {
    const method = operation.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    handleTrusted(`tmux:${operation}`, async options => {
      const result = await controller[method](options || {});
      refresh();
      return result;
    });
  }
}

module.exports = { registerTmuxIpc };
