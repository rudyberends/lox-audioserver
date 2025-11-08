export function renderHeader() {
  const header = document.createElement('header');
  header.className = 'header';
  header.innerHTML = `
    <h1>Lox AudioServer</h1>
    <div class="toolbar">
      <button id="refresh-btn">Refresh</button>
    </div>`;
  header.querySelector('#refresh-btn')?.addEventListener('click', () => location.reload());
  return header;
}
