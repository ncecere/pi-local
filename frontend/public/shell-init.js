// The desktop app opens /?shell=desktop-mac (cmd/pi-local). Remember it for the session (client-side navigation drops
// the query) and mark <html>, so styles can leave room for the macOS window controls and let the top edge drag the window.
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
