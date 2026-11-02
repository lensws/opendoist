const $ = s => document.querySelector(s);
export function initBackups({api}) {
  const fields=['enabled','target','frequency','folder','endpoint','region','bucket','prefix','forcePathStyle'];
  let polling;
  function visibility() { $('#backup-folder-fields').hidden=$('#backup-target').value!=='folder'; $('#backup-s3-fields').hidden=$('#backup-target').value!=='s3'; }
  function status(config) {
    const date=value=>value ? new Date(value).toLocaleString('ru') : '—';
    $('#backup-status').textContent = `${config.running ? 'Создаём копию…\n' : ''}Последняя успешная копия: ${date(config.lastSuccess)}\nСледующая: ${config.enabled ? date(config.nextRun) : 'по расписанию выключено'}${config.lastLocation ? '\n'+config.lastLocation : ''}`;
    $('#backup-error').textContent=config.lastError || ''; $('#backup-run').disabled=config.running;
  }
  async function refresh(fill=false) {
    const {config}=await api('/backups'); status(config);
    if(fill) { for(const field of fields) { const input=$(`#backup-${field}`); if(input.type==='checkbox') input.checked=config[field]; else input.value=config[field]; } $('#backup-accessKeyId').value=''; $('#backup-secretAccessKey').value=''; $('#backup-credentials-note').textContent=config.hasCredentials ? 'Ключи сохранены. Пустые поля оставят их без изменений.' : 'Ключи остаются на сервере.'; visibility(); }
  }
  $('#backups-open').onclick=async()=>{ $('#backups-dialog').showModal(); try { await refresh(true); } catch(e) { $('#backup-error').textContent=e.message; } clearInterval(polling); polling=setInterval(()=>refresh().catch(()=>{}),3000); };
  $('#backups-dialog').addEventListener('close',()=>clearInterval(polling));
  $('#backup-target').onchange=visibility;
  $('#backup-form').onsubmit=async e=>{e.preventDefault(); const button=e.submitter; button.disabled=true; const body={}; for(const field of [...fields,'accessKeyId','secretAccessKey']) { const input=$(`#backup-${field}`); body[field]=input.type==='checkbox' ? input.checked : input.value; } try { await api('/backups',{method:'PATCH',body}); await refresh(true); } catch(e) { $('#backup-error').textContent=e.message; } finally { button.disabled=false; } };
  $('#backup-run').onclick=async()=>{ $('#backup-run').disabled=true; try { const {config}=await api('/backups/run',{method:'POST',body:{}}); status(config); } catch(e) { $('#backup-error').textContent=e.message; $('#backup-run').disabled=false; } };
}
