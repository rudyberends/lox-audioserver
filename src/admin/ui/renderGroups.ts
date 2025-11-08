export function renderGroups(groups: any[]) {
  const section = document.createElement('section');
  section.className = 'groups-section';
  section.innerHTML = '<h2>Groups</h2>';
  const list = document.createElement('ul');
  groups.forEach(g => {
    const li = document.createElement('li');
    li.textContent = `${g.name} (${(g.members || []).length} members)`;
    list.append(li);
  });
  section.append(list);
  return section;
}
