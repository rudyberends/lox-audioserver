import * as Api from '../core/api';
import { Store } from '../core/store';
import { renderHeader } from './renderHeader';
import { renderZones } from './renderZones';
import { renderGroups } from './renderGroups';
import { renderFooter } from './renderFooter';

export async function initApp() {
  const app = document.getElementById('app');
  if (!app) return;

  app.append(renderHeader());

  const main = document.createElement('main');
  main.className = 'main-content';
  app.append(main);

  try {
    const [zones, groups, config] = await Promise.all([
      Api.getZones(),
      Api.getGroups(),
      Api.getConfig()
    ]);
    Store.set({ zones, groups, config });
  } catch (err) {
    console.error('Error loading initial data', err);
  }

  const state = Store.get();
  main.append(renderZones(state.zones));
  main.append(renderGroups(state.groups));
  app.append(renderFooter());
}
