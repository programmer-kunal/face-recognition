/* backend.js — Smart frontend backend (updated)
   Features added:
   - registerFromDataURL(dataURL) to register face from camera frame
   - registerFile(file) to register from file (existing)
   - deleteRefByName(name) to remove a registered person
   - verifyDataURL(dataURL) -> verifies against refs and writes to attendance history
   - loadAttendanceHistory() returns an array [{name, time}, ...] (running history)
   - rebuildRefsUI() and rebuildAttendanceTable() update DOM elements if present
   Storage:
     - refs: face_attendance_refs_v1  -> [{name, dataURL}, ...]
     - attendanceHistory: face_attendance_history_v1 -> [{name, time}, ...]
*/

(function(){
  const STORAGE_KEY = 'face_attendance_refs_v1';
  const HISTORY_KEY = 'face_attendance_history_v1';
  const DIFF_THRESHOLD = 55;

  // utilities
  function q(sel){ return document.querySelector(sel); }
  function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

  // storage helpers
  function loadRefs(){
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch(e){ return []; }
  }
  function saveRefs(arr){ localStorage.setItem(STORAGE_KEY, JSON.stringify(arr)); }
  function loadHistory(){
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch(e){ return []; }
  }
  function saveHistory(arr){ localStorage.setItem(HISTORY_KEY, JSON.stringify(arr)); }

  // image helpers
  function dataURLToImage(dataURL){
    return new Promise((res, rej)=>{
      const img = new Image();
      img.onload = ()=>res(img);
      img.onerror = rej;
      img.src = dataURL;
    });
  }
  function fileToDataURL(file){
    return new Promise((res, rej)=>{
      const fr = new FileReader();
      fr.onload = ()=>res(fr.result);
      fr.onerror = rej;
      fr.readAsDataURL(file);
    });
  }
  function fileToImage(file){ return fileToDataURL(file).then(dataURLToImage); }

  function imageToImageData(img, size=160){
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const ctx = c.getContext('2d');
    const ratio = Math.max(size/img.width, size/img.height);
    const w = img.width * ratio, h = img.height * ratio;
    const dx = (size - w)/2, dy = (size - h)/2;
    ctx.drawImage(img, dx, dy, w, h);
    return ctx.getImageData(0,0,size,size);
  }
  function imageDataDiff(d1, d2){
    if(!d1 || !d2) return Infinity;
    const a1 = d1.data, a2 = d2.data;
    let tot = 0;
    for(let i=0;i<a1.length;i+=4){
      tot += Math.abs(a1[i] - a2[i]);
      tot += Math.abs(a1[i+1] - a2[i+1]);
      tot += Math.abs(a1[i+2] - a2[i+2]);
    }
    const avg = tot / (a1.length/4 * 3);
    return avg;
  }

  // small toast
  function showToast(msg, t=1800){
    let el = document.getElementById('fa_toast');
    if(!el){
      el = document.createElement('div');
      el.id = 'fa_toast';
      el.style.position = 'fixed';
      el.style.right = '18px';
      el.style.bottom = '18px';
      el.style.background = 'rgba(0,0,0,0.8)';
      el.style.color = '#fff';
      el.style.padding = '10px 12px';
      el.style.borderRadius = '8px';
      el.style.zIndex = 99999;
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = 1;
    clearTimeout(el._to);
    el._to = setTimeout(()=> el.style.opacity = 0, t);
  }

  // hidden register input (used by index file register button)
  function ensureHiddenRegisterInput(){
    let input = document.getElementById('fa_register_input');
    if(!input){
      input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.style.display = 'none';
      input.id = 'fa_register_input';
      document.body.appendChild(input);
    }
    return input;
  }

  // Register from file
  async function registerFile(file){
    if(!file) return {ok:false, reason:'no-file'};
    const name = prompt('Enter name for this reference (e.g. Aman)');
    if(!name) { showToast('Cancelled'); return {ok:false, reason:'no-name'}; }
    try {
      const img = await fileToImage(file);
      const data = imageToImageData(img, 160);
      const c = document.createElement('canvas');
      c.width = 160; c.height = 160;
      c.getContext('2d').putImageData(data,0,0);
      const dataURL = c.toDataURL('image/png');
      const refs = loadRefs();
      refs.push({name, dataURL});
      saveRefs(refs);
      showToast(`Registered ${name}`);
      rebuildRefsUI();
      return {ok:true, name};
    } catch (e) {
      console.error(e);
      showToast('Registration failed');
      return {ok:false, reason:'error', e};
    }
  }

  // Register from dataURL (camera capture)
  async function registerFromDataURL(dataURL){
    if(!dataURL) return {ok:false, reason:'no-data'};
    const name = prompt('Enter name for this reference (e.g. Aman)');
    if(!name) { showToast('Cancelled'); return {ok:false, reason:'no-name'}; }
    try {
      const img = await dataURLToImage(dataURL);
      const data = imageToImageData(img, 160);
      const c = document.createElement('canvas');
      c.width = 160; c.height = 160;
      c.getContext('2d').putImageData(data,0,0);
      const stored = c.toDataURL('image/png');
      const refs = loadRefs();
      refs.push({name, dataURL: stored});
      saveRefs(refs);
      showToast(`Registered ${name}`);
      rebuildRefsUI();
      return {ok:true, name};
    } catch(e){
      console.error(e);
      showToast('Registration failed');
      return {ok:false, reason:'error', e};
    }
  }

  // delete ref by name
  async function deleteRefByName(name){
    if(!name) return {ok:false};
    const refs = loadRefs().filter(r=> r.name !== name);
    saveRefs(refs);
    rebuildRefsUI();
    showToast(`Removed ${name}`, 1200);
    return {ok:true};
  }

  // verify dataURL, if matched push into history
  async function verifyDataURL(dataURL){
    if(!dataURL) return {ok:false, reason:'no-data'};
    try {
      const img = await dataURLToImage(dataURL);
      return await verifyImageAndMark(img);
    } catch(e){
      console.error(e);
      showToast('Verification failed');
      return {ok:false, reason:'error', e};
    }
  }

  // core verify logic
  async function verifyImageAndMark(img){
    showToast('Verifying...');
    await sleep(300);
    try {
      const probe = imageToImageData(img, 160);
      const refs = loadRefs();
      if(!refs || refs.length === 0) {
        showToast('No references found');
        return {ok:false, reason:'no-refs'};
      }
      let best = {name:null, diff: Infinity};
      for(const r of refs){
        const ri = await dataURLToImage(r.dataURL);
        const rd = imageToImageData(ri, 160);
        const d = imageDataDiff(probe, rd);
        if(d < best.diff) best = {name: r.name, diff: d};
      }
      if(best.diff <= DIFF_THRESHOLD){
        // push to history
        const hist = loadHistory();
        hist.push({ name: best.name, time: Date.now() });
        saveHistory(hist);
        rebuildAttendanceTable();
        showToast(`Verified: ${best.name}`);
        return {ok:true, name: best.name, diff: best.diff};
      } else {
        showToast('Not matched');
        return {ok:false, reason:'no-match', best};
      }
    } catch (e){
      console.error(e);
      showToast('Verify error');
      return {ok:false, reason:'error', e};
    }
  }

  // rebuild refs UI on index page (if element exists)
  function rebuildRefsUI(){
    const list = document.getElementById('registeredList');
    if(!list) {
      // also update registeredNames span on xedni if exists
      const namesSpan = document.getElementById('registeredNames');
      if (namesSpan){
        const refs = loadRefs();
        namesSpan.textContent = refs.length ? refs.map(r=>r.name).join(', ') : 'None';
      }
      return;
    }
    const refs = loadRefs();
    if(!refs || refs.length === 0){
      list.innerHTML = '<div style="opacity:0.9">No references registered.</div>';
      return;
    }
    list.innerHTML = '';
    refs.forEach((r, idx) => {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.justifyContent = 'space-between';
      row.style.alignItems = 'center';
      row.style.padding = '6px 0';
      row.style.borderBottom = (idx < refs.length-1) ? '1px solid #e6e6e6' : 'none';
      const left = document.createElement('div');
      left.style.display = 'flex';
      left.style.gap = '10px';
      left.style.alignItems = 'center';
      const thumb = document.createElement('img');
      thumb.src = r.dataURL;
      thumb.style.width = '44px';
      thumb.style.height = '44px';
      thumb.style.objectFit = 'cover';
      thumb.style.borderRadius = '6px';
      const name = document.createElement('div');
      name.textContent = r.name;
      name.style.fontWeight = '600';
      left.appendChild(thumb);
      left.appendChild(name);

      const right = document.createElement('div');
      right.style.display = 'flex';
      right.style.gap = '8px';
      const del = document.createElement('button');
      del.textContent = 'Delete';
      del.style.background = '#ff6b6b';
      del.style.border = 'none';
      del.style.color = '#fff';
      del.style.padding = '6px 10px';
      del.style.borderRadius = '6px';
      del.style.cursor = 'pointer';
      del.addEventListener('click', async () => {
        if (!confirm(`Delete registered face for ${r.name}?`)) return;
        await deleteRefByName(r.name);
        // try to call page-level UI refresh if present
        if (window._refreshRegisteredList) window._refreshRegisteredList();
      });
      right.appendChild(del);

      row.appendChild(left);
      row.appendChild(right);
      list.appendChild(row);
    });
  }

  // rebuild attendance table (history)
  function rebuildAttendanceTable(){
    const tbody = document.getElementById('attendanceBody');
    if(!tbody) return;
    const hist = loadHistory();
    tbody.innerHTML = '';
    hist.forEach(entry => {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td'); td1.textContent = entry.name;
      const td2 = document.createElement('td'); td2.innerHTML = '<span class="status-present">Present</span>';
      const td3 = document.createElement('td'); td3.textContent = new Date(entry.time).toLocaleTimeString();
      tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3);
      tbody.appendChild(tr);
    });
    // also notify page refresh helpers
    if (window._refreshHistory) window._refreshHistory();
  }

  // install wiring (create hidden inputs and bind file register)
  function install(){
    ensureHiddenRegisterInput();
    const input = document.getElementById('fa_register_input');
    input.onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      await registerFile(f);
      // call page refresh if needed
      if (window._refreshRegisteredList) window._refreshRegisteredList();
      e.target.value = '';
    };

    // initial rebuilds
    try { rebuildRefsUI(); } catch(e){}
    try { rebuildAttendanceTable(); } catch(e){}
    // listen to storage events to keep pages in sync across tabs
    window.addEventListener('storage', () => {
      rebuildRefsUI(); rebuildAttendanceTable();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();

  // public API
  window.SmartAttendanceBackend = {
    loadRefs,
    loadHistory,
    loadAttendanceHistory: loadHistory, // alias
    loadAttendance: function(){ // legacy: return map of last times per user (computed)
      const hist = loadHistory();
      const last = {};
      hist.forEach(h => last[h.name] = h.time);
      return last;
    },
    registerFile,
    registerFromDataURL,
    deleteRefByName,
    verifyDataURL,
    rebuildRefsUI,
    rebuildAttendanceTable
  };
})();
