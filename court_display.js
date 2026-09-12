/* Browser-owned display controls: fullscreen must originate in a user gesture. */
(() => {
  'use strict';
  const state = { renderer: '', acceleration: 'Checking GPU…', fullscreen: false };
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (kind, options) {
    const game = this.id === 'canvas' && /^(webgl2?|experimental-webgl)$/.test(kind);
    const context = original.call(this, kind, game ? { ...options, powerPreference: 'high-performance' } : options);
    if (game && context && !state.renderer) {
      const extension = context.getExtension('WEBGL_debug_renderer_info');
      state.renderer = extension ? context.getParameter(extension.UNMASKED_RENDERER_WEBGL) : context.getParameter(context.RENDERER);
      state.acceleration = /swiftshader|llvmpipe|software rasterizer/i.test(state.renderer)
        ? 'Software rendering detected. Enable graphics acceleration in your browser’s system settings, then relaunch it.'
        : extension ? 'GPU rendering active' : 'GPU renderer details unavailable';
    }
    return context;
  };
  let panel, status, fullscreen;
  function refresh() {
    state.fullscreen = !!document.fullscreenElement;
    if (fullscreen) fullscreen.textContent = state.fullscreen ? 'Exit fullscreen' : 'Enter fullscreen';
    if (status) status.textContent = state.acceleration + (state.renderer ? '\n' + state.renderer : '');
  }
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
      refresh();
    } catch (error) {
      status.textContent = 'Fullscreen was unavailable. Try the browser’s fullscreen shortcut (F11 on Windows).';
    }
  }
  function showSettings() { panel.hidden = false; refresh(); fullscreen.focus(); }
  function closeSettings() { panel.hidden = true; document.getElementById('canvas')?.focus(); }
  window.CourtDisplay = Object.freeze({ showSettings, closeSettings, status: () => JSON.stringify(state) });
  document.addEventListener('fullscreenchange', refresh);
  document.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    style.textContent = '#court-display{position:fixed;inset:0;z-index:10000;background:#111e;display:grid;place-items:center;color:#eee;font:16px system-ui}#court-display[hidden]{display:none}#court-display section{width:min(480px,85vw);padding:28px;border:1px solid #667;background:#172027;border-radius:12px}#court-display button{padding:12px 18px;margin:8px 8px 8px 0;font:inherit;cursor:pointer}#court-display p{line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}';
    document.head.append(style);
    panel = document.createElement('div'); panel.id = 'court-display'; panel.hidden = true;
    panel.innerHTML = '<section role="dialog" aria-modal="true" aria-label="Browser display"><h2>Browser display</h2><button id="court-fullscreen">Enter fullscreen</button><button id="court-display-close">Back to game settings</button><p id="court-gpu"></p><p>Low graphics is the browser default. Change quality in game Settings. Fullscreen keeps the interface sharp while automatic resolution limits the 3D workload.</p><p>Escape can release the mouse or exit fullscreen. Resume the game to capture the mouse again.</p></section>';
    document.body.append(panel);
    status = document.getElementById('court-gpu'); fullscreen = document.getElementById('court-fullscreen');
    fullscreen.disabled = !document.fullscreenEnabled;
    fullscreen.addEventListener('click', toggleFullscreen);
    document.getElementById('court-display-close').addEventListener('click', closeSettings);
    panel.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSettings(); }
      if (event.key === 'Tab') {
        const buttons = [...panel.querySelectorAll('button:not(:disabled)')];
        const next = (buttons.indexOf(document.activeElement) + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
        event.preventDefault(); buttons[next].focus();
      }
    });
  });
})();
