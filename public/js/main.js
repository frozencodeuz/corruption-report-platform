document.addEventListener('DOMContentLoaded', () => {
  const fileInput = document.querySelector('input[type="file"]');
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      const zone = fileInput.closest('.file-dropzone');
      const small = zone?.querySelector('small');
      const count = fileInput.files.length;
      if (small) small.textContent = count > 0 ? `${count} ta файл танланди.` : small.dataset.defaultText || small.textContent;
      if (zone) zone.classList.toggle('has-files', count > 0);
    });
  }

  document.querySelectorAll('textarea[minlength]').forEach((textarea) => {
    const help = textarea.parentElement?.querySelector('.field-help');
    if (!help) return;
    const min = Number(textarea.getAttribute('minlength') || 0);
    const update = () => {
      const left = Math.max(min - textarea.value.trim().length, 0);
      help.textContent = left > 0 ? `Камида яна ${left} белги ёзинг.` : 'Матн етарли. Аниқ фактлар киритилганини текширинг.';
    };
    textarea.addEventListener('input', update);
    update();
  });
});
