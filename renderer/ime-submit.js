'use strict';

// Korean and other IMEs report the Enter that finishes composition as an
// in-progress keydown. Ignoring it forces a second Enter. Defer that same
// intent until compositionend, while cancelling the deferred request if the
// browser also emits a normal Enter or the form is submitted by a click.
window.LoadToAgentImeSubmit = (() => {
  const pendingInputs = new WeakSet();
  const deferredSubmissions = new WeakMap();

  function cancel(input) {
    if (!input) return;
    pendingInputs.delete(input);
    const timer = deferredSubmissions.get(input);
    if (timer != null) clearTimeout(timer);
    deferredSubmissions.delete(input);
  }

  function submit(input) {
    if (!input?.isConnected || !String(input.value || '').trim()) return false;
    const form = input.closest?.('form');
    if (!form || typeof form.requestSubmit !== 'function') return false;
    form.requestSubmit();
    return true;
  }

  function handleKeydown(event, input) {
    if (!input || event?.key !== 'Enter' || event.shiftKey) return false;
    if (event.isComposing || event.keyCode === 229) {
      pendingInputs.add(input);
      return true;
    }
    cancel(input);
    event.preventDefault?.();
    submit(input);
    return true;
  }

  function handleCompositionEnd(event) {
    const input = event?.target;
    if (!input || !pendingInputs.has(input)) return false;
    const previous = deferredSubmissions.get(input);
    if (previous != null) clearTimeout(previous);
    const timer = setTimeout(() => {
      deferredSubmissions.delete(input);
      if (!pendingInputs.delete(input)) return;
      submit(input);
    }, 0);
    deferredSubmissions.set(input, timer);
    return true;
  }

  function handleSubmit(form) {
    cancel(form?.querySelector?.('[data-agent-command-draft], #terminalCommandInput'));
  }

  return { handleKeydown, handleCompositionEnd, handleSubmit, cancel };
})();
