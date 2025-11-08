export function renderZones(zones: any[]) {
  const section = document.createElement('section');
  section.className = 'zones-section';
  section.innerHTML = '<h2>Zones</h2>';
  const list = document.createElement('div');
  list.className = 'zone-list';
  zones.forEach(z => {
    const card = document.createElement('div');
    card.className = 'zone-card';
    card.innerHTML = `<strong>${z.name}</strong><br/><small>${z.status || ''}</small>`;
    list.append(card);
  });
  section.append(list);
  return section;
}
