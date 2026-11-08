import {effect, Injectable, signal} from '@angular/core';

export interface Theme {
  name: string;
  alive: string;
  dead: string;
}

export const THEMES: Theme[] = [
  {name: 'Classic', alive: '#000000', dead: '#ffffff'},
  {name: 'Ocean', alive: '#0b3d91', dead: '#e6f2ff'},
  {name: 'Forest', alive: '#1b5e20', dead: '#f1f8e9'},
  {name: 'Night', alive: '#ffffff', dead: '#000000'},
  {name: 'Deep Sea', alive: '#7fb3ff', dead: '#06142e'},
  {name: 'Matrix', alive: '#00ff41', dead: '#0d0208'},
  {name: 'Amber', alive: '#ffb000', dead: '#1a1200'},
];

const storageKey = 'display-settings';

/** Perceived brightness of '#rrggbb', 0 to 255. */
function brightness(hex: string): number {
  const rgb = parseInt(hex.slice(1), 16);
  return 0.299 * (rgb >> 16) + 0.587 * ((rgb >> 8) & 0xff) + 0.114 * (rgb & 0xff);
}

/** How the grid is drawn, set in the Settings menu and kept in the browser between visits. */
@Injectable({providedIn: 'root'})
export class DisplaySettings {
  readonly borders = signal(false);
  readonly smoothing = signal(true);
  readonly alive = signal(THEMES[0].alive);
  readonly dead = signal(THEMES[0].dead);

  constructor() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
      for (const name of ['borders', 'smoothing', 'alive', 'dead'] as const) {
        if (saved[name] !== undefined) (this[name] as any).set(saved[name]);
      }
    } catch {
      // No storage, or nothing usable in it: keep the defaults.
    }

    effect(() => {
      const root = document.documentElement.style;
      root.setProperty('--alive', this.alive());
      root.setProperty('--dead', this.dead());
      const darkDead = brightness(this.dead()) < brightness(this.alive());
      root.setProperty('--bar', darkDead ? 'var(--dead)' : 'var(--alive)');
      root.setProperty('--bar-text', darkDead ? 'var(--alive)' : 'var(--dead)');

      const settings = {
        borders: this.borders(), smoothing: this.smoothing(),
        alive: this.alive(), dead: this.dead(),
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
  }
}
