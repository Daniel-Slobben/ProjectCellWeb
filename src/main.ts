import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import {AppComponent} from './app/app.component';

// iOS Safari only applies :active on touch when a touchstart listener exists.
document.addEventListener('touchstart', () => {}, {passive: true});

bootstrapApplication(AppComponent, appConfig)
  .catch((err) => console.error(err));
