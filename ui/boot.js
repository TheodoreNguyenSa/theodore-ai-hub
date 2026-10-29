// Loaded first: if the page cannot start (a script failed to load or threw), say so on screen and in the server log
// instead of leaving an empty window.
(function () {
  function show(msg) {
    try { fetch('/api/client-log', { method: 'POST', credentials: 'same-origin', headers: { 'x-relay': '1', 'content-type': 'application/json' }, body: JSON.stringify({ message: msg }) }); } catch (e) { /* */ }
    if (window.__relayStarted) return;
    var d = document.getElementById('booterr') || document.body.appendChild(Object.assign(document.createElement('pre'), { id: 'booterr' }));
    d.style.cssText = 'position:fixed;left:16px;bottom:16px;right:16px;max-height:40vh;overflow:auto;background:#fff4f3;color:#a32a22;padding:12px;border-radius:8px;font:12px/1.5 Consolas,monospace;z-index:99;white-space:pre-wrap';
    d.textContent += msg + '\n';
  }
  window.addEventListener('error', function (e) {
    if (e.target && e.target !== window && (e.target.src || e.target.href)) show('Could not load ' + (e.target.src || e.target.href));
    else show((e.message || 'error') + ' at ' + (e.filename || '') + ':' + (e.lineno || '') + ':' + (e.colno || ''));
  }, true);
  setTimeout(function () { if (!window.__relayStarted) show('The page did not start (app.js did not run).'); }, 4000);
})();
