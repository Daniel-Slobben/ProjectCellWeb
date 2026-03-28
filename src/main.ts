import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import {AppComponent} from './app/app.component';
import {provideZoneChangeDetection} from '@angular/core';

bootstrapApplication(AppComponent, appConfig)
  .then(() => {
    provideZoneChangeDetection()
  })
  .catch((err) => console.error(err));
