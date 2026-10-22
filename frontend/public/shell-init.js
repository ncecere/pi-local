// The desktop app sends an explicit shell marker (desktop-mac on macOS, desktop elsewhere). Remember it for the
// session (client-side navigation drops the query); a generic marker replaces stale macOS window-control styling.
(() => {
  try {
    const key = 'pi-local:shell';
    const fromUrl = new URLSearchParams(location.search).get('shell');
    if (fromUrl) sessionStorage.setItem(key, fromUrl);
    const shell = fromUrl || sessionStorage.getItem(key);
    if (shell) document.documentElement.dataset.shell = shell;
  } catch {
    // Storage unavailable: no desktop adjustments.
  }
})();
