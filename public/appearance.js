// Loaded before CSS so the saved theme is applied before the first paint.
(() => {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = { theme: 'system', accent: '#c95736' };
  const normalize = value => ({
    theme: ['light', 'dark', 'system'].includes(value?.theme) ? value.theme : 'system',
    accent: /^#[0-9a-f]{6}$/i.test(value?.accent || '') ? value.accent.toLowerCase() : '#c95736',
  });
  const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const luminance = channels => channels.map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  const contrast = (a, b) => (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
  function render() {
    const dark = preference.theme === 'dark' || (preference.theme === 'system' && media.matches);
    const root = document.documentElement;
    root.dataset.theme = dark ? 'dark' : 'light';
    const channels = rgb(preference.accent), light = luminance(channels);
    root.style.setProperty('--accent', preference.accent);
    root.style.setProperty('--on-accent', contrast(light, 0) > contrast(light, 1) ? '#000000' : '#ffffff');
    // Keep accent-colored text legible even for very light/dark custom colors.
    const surface = luminance(rgb(dark ? '#252b26' : '#f1f2ec'));
    const target = dark ? [255, 255, 255] : [0, 0, 0];
    let ink = channels;
    for (let amount = 0; amount <= 1 && contrast(luminance(ink), surface) < 4.5; amount += .05) ink = channels.map((v, i) => Math.round(v * (1 - amount) + target[i] * amount));
    root.style.setProperty('--accent-ink', `rgb(${ink.join(',')})`);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#191e1a' : '#fbfbf8');
  }
  function apply(value) { preference = normalize(value); render(); }
  try { apply(JSON.parse(localStorage.getItem('opendoist.settings'))); } catch { apply({}); }
  media.addEventListener('change', render);
  window.OpenDoistAppearance = { apply, normalize };
})();
