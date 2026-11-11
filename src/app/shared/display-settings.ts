import {effect, Injectable, signal} from '@angular/core';

export interface Theme {
  name: string;
  alive: string;
  dead: string;
}

// Two per row in the menu: a light theme, then its dark sibling. Alive and dead share a hue and differ in
// lightness, the pairs people like best, at a contrast around 9-15:1 rather than the harsher 21:1 of Classic.
// Paper and Amber set a cool colour against a warm one instead, which people also like as figure on ground.
export const THEMES: Theme[] = [
  {name: 'Classic', alive: '#000000', dead: '#ffffff'},
  {name: 'Night', alive: '#e6e6e6', dead: '#121212'},
  {name: 'Ocean', alive: '#0b3d91', dead: '#e6f2ff'},
  {name: 'Deep Sea', alive: '#7fb3ff', dead: '#06142e'},
  {name: 'Forest', alive: '#0d5117', dead: '#ecf9ee'},
  {name: 'Matrix', alive: '#00ff41', dead: '#041107'},
  {name: 'Paper', alive: '#002b36', dead: '#fdf6e3'},
  {name: 'Amber', alive: '#ffb000', dead: '#191724'},
  {name: 'Lavender', alive: '#4f2980', dead: '#f6f3fe'},
  {name: 'Dusk', alive: '#cba6f7', dead: '#11111b'},
];

const storageKey = 'display-settings';

/** Perceived brightness of '#rrggbb', 0 to 255. */
function brightness(hex: string): number {
  const rgb = parseInt(hex.slice(1), 16);
  return 0.299 * (rgb >> 16) + 0.587 * ((rgb >> 8) & 0xff) + 0.114 * (rgb & 0xff);
}

/** Whether the dead colour is the darker one: light life on a dark ground. */
function isDark(alive: string, dead: string): boolean {
  return brightness(dead) < brightness(alive);
}

/** The gamma a theme starts at, lower on dark themes than on light ones. */
function defaultGamma(theme: Theme): number {
  return isDark(theme.alive, theme.dead) ? 0.3 : 0.6;
}

/** How the grid is drawn, set in the Settings menu and kept in the browser between visits. */
@Injectable({providedIn: 'root'})
export class DisplaySettings {
  readonly borders = signal(false);
  readonly smoothing = signal(true);
  readonly alive = signal(THEMES[1].alive);
  readonly dead = signal(THEMES[1].dead);
  // Zoomed out, how far a patch's share of alive cells moves it towards the alive colour: lower shows sparse life more.
  readonly gamma = signal(defaultGamma(THEMES[1]));

  constructor() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
      for (const name of ['borders', 'smoothing', 'alive', 'dead', 'gamma'] as const) {
        if (saved[name] !== undefined) (this[name] as any).set(saved[name]);
      }
    } catch {
      // No storage, or nothing usable in it: keep the defaults.
    }

    effect(() => {
      const root = document.documentElement.style;
      root.setProperty('--alive', this.alive());
      root.setProperty('--dead', this.dead());

      const settings = {
        borders: this.borders(), smoothing: this.smoothing(),
        alive: this.alive(), dead: this.dead(), gamma: this.gamma(),
      };
      try {
        localStorage.setItem(storageKey, JSON.stringify(settings));
      } catch {
        // Settings then last until the page is closed.
      }
    });
  }

  applyTheme(theme: Theme): void {
    this.alive.set(theme.alive);
    this.dead.set(theme.dead);
    this.gamma.set(defaultGamma(theme));
  }
}
