export function initTransfer({ api, reload, notify }) {
  const fileInput = document.querySelector('#import-file'), button = document.querySelector('#import-submit');
  const preview = document.querySelector('#import-preview'), error = document.querySelector('#import-error');
  let documentData = null, sequence = 0, importing = false;
  const summary = result => `Новых задач: ${result.added}. Уже есть: ${result.skipped}. Записей истории: ${result.history}.${result.projects || result.sections ? ` Проектов: ${result.projects}. Разделов: ${result.sections}.` : ''}`;
  fileInput.addEventListener('change', async () => {
    const current = ++sequence; documentData = null; button.disabled = true; error.textContent = ''; preview.textContent = '';
    const file = fileInput.files[0]; if (!file) return;
    if (file.size > 10 * 1024 * 1024) { error.textContent = 'Файл больше 10 МБ.'; return; }
    preview.textContent = 'Проверяем файл…';
    try {
      let data;
      try { data = JSON.parse((await file.text()).replace(/^\uFEFF/, '')); } catch { throw new Error('Не удалось прочитать JSON. Выберите файл экспорта OpenDoist.'); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Ожидается JSON экспорта OpenDoist.');
      if (current !== sequence) return;
      const result = await api('/import/preview', { method: 'POST', body: data });
      if (current !== sequence) return;
      documentData = data; preview.textContent = summary(result); button.disabled = !result.added && !result.projects && !result.sections;
    } catch (e) { if (current === sequence) { preview.textContent = ''; error.textContent = e.message; } }
  });
  button.addEventListener('click', async () => {
    if (!documentData || importing) return;
    importing = true; button.disabled = true; fileInput.disabled = true; error.textContent = '';
    try {
      const result = await api('/import', { method: 'POST', body: documentData });
      documentData = null; fileInput.value = ''; preview.textContent = `Импорт завершён. ${summary(result)}`;
      notify(`Добавлено задач: ${result.added}`); await reload();
    } catch (e) { error.textContent = e.message; button.disabled = !documentData; }
    finally { importing = false; fileInput.disabled = false; }
  });
  document.querySelector('#settings-dialog').addEventListener('close', () => {
    if (importing) return;
    sequence++; documentData = null; fileInput.value = ''; button.disabled = true; preview.textContent = ''; error.textContent = '';
  });
}
