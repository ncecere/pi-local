import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import script from '../../public/shell-init.js?raw';

const key = 'pi-local:shell';

function session(initial?: string) {
  const values = new Map<string, string>(initial ? [[key, initial]] : []);
  const storage = {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => values.set(name, value),
  };
  function load(search: string) {
    const dataset: { shell?: string } = {};
    runInNewContext(script, {
      URLSearchParams,
      location: { search },
      sessionStorage: storage,
      document: { documentElement: { dataset } },
    });
    return dataset.shell;
  }
  return { load, values };
}

describe('desktop shell initialization', () => {
  it('explicit generic URL overwrites stale macOS storage and styling across navigation', () => {
    const { load, values } = session('desktop-mac');
    expect(load('?shell=desktop')).toBe('desktop');
    expect(values.get(key)).toBe('desktop');
    expect(load('')).toBe('desktop');
  });

  it('preserves explicit macOS styling and remembers it across navigation', () => {
    const { load, values } = session('desktop');
    expect(load('?shell=desktop-mac')).toBe('desktop-mac');
    expect(values.get(key)).toBe('desktop-mac');
    expect(load('')).toBe('desktop-mac');
  });

  it('does not mark an ordinary browser session', () => {
    const { load, values } = session();
    expect(load('')).toBeUndefined();
    expect(values.size).toBe(0);
  });

  it('does not treat an empty URL marker as a new shell', () => {
    expect(session('desktop').load('?shell=')).toBe('desktop');
  });
});
