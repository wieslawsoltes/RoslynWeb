// This independent entry point can report failed module downloads to the user.
(() => {
  const status = document.getElementById('status');
  const error = document.getElementById('error');
  const retry = document.getElementById('restart');
  let loaded = false;
  const timer = setTimeout(() => {
    if (!loaded) status.textContent = 'Application modules are taking longer than expected. Open Compiler & runtime to restart.';
  }, 20000);
  retry.onclick = () => location.reload();
  import('./dxf.js').then(() => { loaded = true; clearTimeout(timer); }).catch(reason => {
    clearTimeout(timer);
    status.textContent = 'Application failed to start';
    error.hidden = false;
    error.textContent = `${reason?.message || reason}\nOpen Compiler & runtime and choose Restart runtime to retry.`;
    document.querySelector('.runtime-options').open = true;
    document.documentElement.dataset.startup = 'failed';
  });
})();
