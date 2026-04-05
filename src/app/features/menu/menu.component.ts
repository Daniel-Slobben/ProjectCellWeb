import {Component, Input, OnInit} from '@angular/core';
import {Menu} from './Menu';
import {Router} from '@angular/router';

@Component({selector: 'app-menu', templateUrl: './menu.component.html', styleUrls: ['./menu.component.css']})
export class MenuComponent implements OnInit {
  @Input()
  menus: Menu[] = [];
  @Input()
  atTop: boolean = false;
  selectedMenu: Menu | undefined;

  constructor(private readonly router: Router) {
  }

  ngOnInit(): void {
    if (this.menus.length === 0) {
      return;
    }
    this.selectedMenu = this.menus[0];
  }

  changeMenu(menu: Menu) {
    this.selectedMenu = menu;
    this.router.navigate([menu.url]);
  }
}
