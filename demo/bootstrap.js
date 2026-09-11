/* Keep this entry point independent of the application's module dependency graph. */
(() => {
  const output = document.getElementById('console');
  const status = document.getElementById('status');
  const retry = document.getElementById('restart');
  let loaded = false;
  let failed = false;
  let timer;
  const describe = error => error?.stack || error?.message || String(error || 'Unknown startup error');
  function fail(error) {
    failed = true;
    clearTimeout(timer);
    status.textContent = 'Application failed to start';
    output.textContent = `${describe(error)}\n\nUse Restart compiler to retry. If this continues, include this error when reporting the issue.`;
    retry.hidden = false;
    retry.disabled = false;
    document.documentElement.dataset.startup = 'failed';
  }
  retry.onclick = () => location.reload();
  window.addEventListener('error', event => {
    if (!loaded && event.error) fail(event.error);
  });
  window.addEventListener('unhandledrejection', event => {
    if (!loaded) fail(event.reason);
  });
  status.textContent = 'Loading application';
  output.textContent = 'Loading application modules…';
  document.documentElement.dataset.startup = 'loading';
  timer = setTimeout(() => {
    if (!loaded && !failed) {
      status.textContent = 'Application download is taking longer than expected';
      output.textContent += '\nThe application modules are still loading. Check your connection or use Restart compiler to retry.';
      retry.hidden = false;
    }
  }, 20000);
  import('./app.js').then(() => {
    loaded = true;
    clearTimeout(timer);
    if (!failed) document.documentElement.dataset.startup = 'loaded';
  }).catch(fail);
})();
