import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { headerLinks } from '../src/shared/ui/chrome';

describe('header navigation', () => {
  it('lists the same destinations as the desktop header, including VOR', () => {
    expect(headerLinks().map((link) => link.key)).toEqual(['nav.home', 'nav.temporal', 'nav.vor', 'nav.about']);
    expect(headerLinks().map((link) => link.id)).toEqual(['home', 'temporal', 'vor', 'about']);
  });

  it('keeps the iPad header above the full-screen workspace and at least 44 px', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../src/styles/app.css'), 'utf8');
    const tablet = css.slice(css.indexOf('body.is-tablet .workspace,\nbody.is-tablet .stage { position: absolute; inset: 0; }'));
    expect(tablet).toContain('body.is-tablet .topbar {\n  position: relative;\n  z-index: 8;');
    expect(tablet).toContain('body.is-tablet .workspace { top: var(--topbar-h, 52px); }');
    expect(tablet).toMatch(/body\.is-tablet \.nav-link,\nbody\.is-tablet \.lang-btn \{ min-width: 44px; \}/);
    const menu = readFileSync(resolve(import.meta.dirname, '../src/temporal-bone/main.ts'), 'utf8');
    expect(menu).toContain('headerLinks()');
    const vor = readFileSync(resolve(import.meta.dirname, '../src/vor/main.ts'), 'utf8');
    expect(vor).toContain('headerLinks()');
  });
});
