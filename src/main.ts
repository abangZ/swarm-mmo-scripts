import { mountPanel } from './app/mount';

function mountIfNeeded(): void {
  if (/^\/play\/?$/.test(location.pathname) && !document.getElementById('swarm-helper-root')) mountPanel();
}

// A bfcache restore resumes this document without rerunning the userscript.
// pagehide disposed the old controller; restore only the UI, never its running state.
window.addEventListener('pageshow', event => {
  if (event.persisted) mountIfNeeded();
});
mountIfNeeded();
