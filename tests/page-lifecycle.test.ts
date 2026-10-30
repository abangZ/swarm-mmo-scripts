import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

// Exercise the real entry point and its bundled React instance in an isolated page.
test('persisted page restore remounts exactly one idle panel and preserves uncertain outcomes', async () => {
  const bundle = await build({
    entryPoints: ['src/main.ts'], bundle: true, write: false, format: 'iife', target: 'es2022',
    jsx: 'automatic', loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' },
  });
  const dom = new JSDOM('<body></body>', {
    url: 'https://www.swarm-mmo.com/play', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  const request = mock.fn();
  Object.defineProperty(window.navigator, 'locks', { value: { request } });
  const host = () => window.document.getElementById('swarm-helper-root');
  const rendered = async () => {
    const deadline = Date.now() + 2000;
    while (!host()?.shadowRoot?.getElementById('toggle')) {
      if (Date.now() > deadline) throw new Error('Assistant did not render after page restore');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    return host()!.shadowRoot!;
  };
  try {
    window.eval(bundle.outputFiles[0].text);
    await rendered();
    for (let cycle = 0; cycle < 2; cycle++) {
      const previousHost = host();
      window.localStorage.setItem('swarm-helper-uncertain-v1', `request-${cycle}`);
      window.dispatchEvent(new window.PageTransitionEvent('pagehide', { persisted: true }));
      assert.equal(host(), null);
      window.dispatchEvent(new window.PageTransitionEvent('pageshow', { persisted: true }));
      const root = await rendered();
      assert.notEqual(host(), previousHost);
      assert.equal(root.getElementById('auto-status')!.textContent, '尚未启动');
      assert.equal((root.getElementById('stop') as HTMLButtonElement).disabled, true);
      assert.equal((root.getElementById('start') as HTMLButtonElement).disabled, true);
      assert.equal(window.localStorage.getItem('swarm-helper-uncertain-v1'), `request-${cycle}`);
      assert.equal(request.mock.callCount(), 0);
      const currentHost = host();
      window.dispatchEvent(new window.PageTransitionEvent('pageshow', { persisted: true }));
      assert.equal(host(), currentHost);
      assert.equal(window.document.querySelectorAll('#swarm-helper-root').length, 1);
    }
  } finally {
    window.dispatchEvent(new window.PageTransitionEvent('pagehide'));
    window.close();
  }
});
