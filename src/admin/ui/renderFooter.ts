export function renderFooter() {
  const footer = document.createElement('footer');
  footer.className = 'footer';
  footer.innerHTML = '<p>Lox AudioServer Admin UI</p>';
  return footer;
}
