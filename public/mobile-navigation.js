export function initMobileNavigation() {
  const sidebar=document.querySelector('#sidebar'), main=document.querySelector('main');
  const toggle=document.querySelector('#menu-open'), closeButton=document.querySelector('#menu-close'), backdrop=document.querySelector('#menu-backdrop');
  const mobile=matchMedia('(max-width: 700px)');
  let opened=false;
  function close(restore=true) {
    opened=false; document.body.classList.remove('navigation-open');backdrop.hidden=true;
    toggle.setAttribute('aria-expanded','false');main.inert=false;
    sidebar.inert=mobile.matches;sidebar.removeAttribute('role');sidebar.removeAttribute('aria-modal');
    if(restore && mobile.matches)toggle.focus();
  }
  function open() {
    if(!mobile.matches)return;
    opened=true;sidebar.inert=false;sidebar.setAttribute('role','dialog');sidebar.setAttribute('aria-modal','true');
    document.body.classList.add('navigation-open');backdrop.hidden=false;toggle.setAttribute('aria-expanded','true');
    main.inert=true;requestAnimationFrame(()=>{if(opened)closeButton.focus();});
  }
  document.querySelector('#mobile-search-show').onclick=()=>close();
  toggle.onclick=open;closeButton.onclick=()=>close();backdrop.onclick=()=>close();
  mobile.addEventListener('change',()=>close(false));
  sidebar.addEventListener('click',event=>{
    if(event.target.closest('[data-view],#focus-add,#settings-open,#logout'))close(false);
  },true);
  document.querySelector('#search').addEventListener('keydown',event=>{
    if(event.key==='Enter' && opened){event.preventDefault();close();}
  });
  document.addEventListener('keydown',event=>{
    if(!opened || document.querySelector('dialog[open]'))return;
    if(event.key==='Escape'){event.preventDefault();close();}
    if(event.key==='Tab'){
      const controls=[...sidebar.querySelectorAll('button,input,a[href],select,[tabindex="0"]')].filter(el=>!el.disabled && el.getClientRects().length);
      const first=controls[0],last=controls.at(-1);
      if(!sidebar.contains(document.activeElement)){event.preventDefault();first.focus();}
      else if(event.shiftKey && document.activeElement===first){event.preventDefault();last.focus();}
      else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first.focus();}
    }
  });
  close(false);
  return {open,close};
}
