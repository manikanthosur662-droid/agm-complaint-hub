/* script_full.js - frontend integration with server_full.py */
const API_BASE = ""; // same-origin

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const toast = (m,t=2200)=>{ const r=$('#toastRoot'); if(!r) return; const e=document.createElement('div'); e.className='toast'; e.textContent=m; r.appendChild(e); setTimeout(()=>e.remove(),t); };
const readFileAsDataURL = f => new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=rej; r.readAsDataURL(f); });

function saveToken(t){ localStorage.setItem('agm_jwt', t); }
function getToken(){ return localStorage.getItem('agm_jwt'); }
function authHeaders(){ const tk=getToken(); return tk? {'Authorization': 'Bearer ' + tk} : {}; }

// login
async function login(u,p){
  const r = await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});
  if(!r.ok){ const j=await r.json().catch(()=>({})); throw new Error(j.error||'Login failed'); }
  const j = await r.json(); saveToken(j.token); toast('Logged in as '+j.user); $('#loginBtn').style.display='none'; $('#logoutBtn').style.display='inline-block'; return j;
}

// presign upload
async function uploadAttachment(file){
  if(!file) return {url:'',name:''};
  try{
    const res = await fetch('/api/presign',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename:file.name,content_type:file.type})});
    const data = await res.json();
    if(res.ok && data.upload_url){
      await fetch(data.upload_url,{method:'PUT',headers:{'Content-Type': file.type},body:file});
      return {url:data.public_url,name:file.name};
    }
  }catch(e){ console.warn('presign failed',e); }
  const url = await readFileAsDataURL(file);
  return {url,name:file.name};
}

// create complaint
async function createComplaint(payload){
  const r = await fetch('/api/complaints',{method:'POST',headers:{'Content-Type':'application/json', ...authHeaders()},body:JSON.stringify(payload)});
  if(!r.ok) throw new Error((await r.json()).error||r.statusText);
  return await r.json();
}

// load complaints
async function loadComplaints(){
  const r = await fetch('/api/complaints');
  if(!r.ok) return [];
  return await r.json();
}

// resolve
async function resolveComplaint(id){
  const r = await fetch('/api/complaints/'+id+'/resolve',{method:'POST',headers: authHeaders()});
  if(!r.ok){ const j=await r.json().catch(()=>({})); throw new Error(j.error||'Resolve failed'); }
  return await r.json();
}

// SSE chat
async function startChatStream(messages, onChunk, onDone){
  const res = await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages})});
  if(!res.ok){ const t=await res.text(); console.error('chat failed',t); return; }
  const reader = res.body.getReader(); const dec = new TextDecoder('utf-8'); let buffer='';
  while(true){
    const {done,value} = await reader.read();
    if(done) break;
    buffer += dec.decode(value, {stream:true});
    const parts = buffer.split('\n\n'); buffer = parts.pop();
    for(const p of parts){
      const lines = p.split('\n').map(l=>l.trim()).filter(Boolean);
      let ev=null,data=null;
      for(const L of lines){ if(L.startsWith('event:')) ev=L.slice(6).trim(); if(L.startsWith('data:')) data=L.slice(5).trim(); }
      if(ev==='chunk' && data){ try{ const parsed=JSON.parse(data); const txt=parsed.text||''; onChunk && onChunk(txt); }catch(e){console.error(e);} }
      else if(ev==='done'){ onDone && onDone(); }
      else if(ev==='error'){ console.error('assistant error',data); onDone && onDone(); }
    }
  }
}

function escapeHtml(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

let charts = {};
function renderCharts(list){
  const counts = list.reduce((a,c)=>{ a[c.status]=(a[c.status]||0)+1; return a; },{});
  const labels=['Submitted','Under Review','Resolved'], data=labels.map(l=>counts[l]||0);
  if(charts.status) charts.status.destroy();
  charts.status = new Chart($('#statusChart').getContext('2d'), {type:'doughnut', data:{labels,datasets:[{data,backgroundColor:['#6c757d','#ffc107','#28a745']}]}, options:{plugins:{legend:{position:'bottom'}}}});
  const cats = [...new Set(list.map(i=>i.category))]; const vals = cats.map(c=>list.filter(i=>i.category===c).length);
  if(charts.cat) charts.cat.destroy();
  charts.cat = new Chart($('#categoryChart').getContext('2d'), {type:'bar', data:{labels:cats,datasets:[{label:'Count',data:vals}]}, options:{plugins:{legend:{display:false}}, scales:{y:{beginAtZero:true}}}});
}

async function refreshUI(){
  const list = await loadComplaints();
  window._lastComplaints = list;
  $('#cardsContainer').innerHTML='';
  list.forEach(it=>{
    const div=document.createElement('div'); div.className='card-item';
    div.innerHTML=`<div style="display:flex;justify-content:space-between"><div><strong>${escapeHtml(it.title)}</strong><div class="small-muted">${escapeHtml(it.category)} · ${escapeHtml(it.priority)}</div></div><div>${escapeHtml(it.status)}</div></div><p class="small-muted">${escapeHtml(it.description).slice(0,120)}</p><div class="card-actions"><button class="btn ghost view-btn" data-id="${it.id}">View</button><button class="btn primary resolve-btn" data-id="${it.id}">Resolve</button></div>`;
    $('#cardsContainer').appendChild(div);
  });
  $$('.resolve-btn').forEach(b=>b.onclick=async e=>{ try{ await resolveComplaint(e.currentTarget.dataset.id); toast('Resolved'); await refreshUI(); }catch(err){alert('Resolve failed: '+err.message);} });
  $$('.view-btn').forEach(b=>b.onclick=async e=>{ const r=await fetch('/api/complaints/'+e.currentTarget.dataset.id); if(!r.ok) return; const it=await r.json(); alert(`Title: ${it.title}\\nCategory: ${it.category}\\nStatus: ${it.status}\\n\\n${it.description}`); });
  renderCharts(list);
  const st = await fetch('/api/stats/summary').then(r=>r.json()).catch(()=>null);
  if(st){ $('#kpiTotal').textContent=st.total; $('#kpiResolved').textContent=st.resolved; $('#kpiUnder').textContent=st.under; $('#kpiOpen').textContent=st.open; const pct=st.total?Math.round((st.resolved/st.total)*100):0; $('#completionBar').style.width=pct+'%'; }
}

document.addEventListener('DOMContentLoaded', ()=>{
  $$('.nav-item').forEach(btn=>btn.addEventListener('click', e=>{ $$('.nav-item').forEach(n=>n.classList.remove('active')); e.currentTarget.classList.add('active'); const t=e.currentTarget.dataset.target; $$('.page').forEach(p=>p.classList.remove('active-page')); $(`#${t}`).classList.add('active-page'); }));
  $('#submitBtn') && $('#submitBtn').addEventListener('click', async e=>{ e.preventDefault(); const file=$('#attachInput').files[0]; const up = file? await uploadAttachment(file): {url:'',name:''}; const payload={ title:$('#titleInput').value, description:$('#descriptionInput').value, name:$('#nameInput').value||'Anonymous', roll:$('#rollInput').value||'', category:$('#categorySelect').value, priority:$('#prioritySelect').value, tags:($('#tagsInput').value||'').split(',').map(x=>x.trim()).filter(Boolean), attachment_name: up.name||'', attachment_url: up.url||'' }; try{ await createComplaint(payload); toast('Submitted'); $('#titleInput').value=''; $('#descriptionInput').value=''; await refreshUI(); }catch(err){ alert('Submit failed: '+err.message); } });
  $('#importBtn') && $('#importBtn').addEventListener('click', ()=>{ const f=$('#csvInput').files[0]; if(!f) return alert('Choose CSV'); const fr=new FileReader(); fr.onload=e=>{ try{ const rows=e.target.result.trim().split('\\n'); const headers=rows.shift().split(',').map(h=>h.replace(/^"|"$/g,'')); rows.forEach(line=>{ const parts=line.match(/("([^"]*)")|[^,]+/g)||[]; const obj={}; parts.forEach((p,i)=> obj[headers[i]]=p.replace(/^"|"$/g,'').replace(/""/g,'"')); createComplaint({ title: obj.title||'Imported', description: obj.description||'', name: obj.name||'Imported', roll: obj.roll||'', category: obj.category||'Other', priority: obj.priority||'Normal', tags:(obj.tags||'').split(',').map(x=>x.trim()).filter(Boolean), attachment_name:'', attachment_url:'' }).catch(e=>console.warn(e)); }); toast('Imported'); setTimeout(()=>refreshUI(),1200); }catch(err){ alert('CSV parse failed: '+err.message); } }; fr.readAsText(f); });
  $('#exportBtn') && $('#exportBtn').addEventListener('click', async ()=>{ const list=await loadComplaints(); const keys=['id','created_at','name','roll','category','priority','title','description','status','tags','attachment_name']; const lines=[keys.join(',')]; list.forEach(it=>{ const vals=keys.map(k=>`"${String(it[k]||'').replace(/"/g,'""')}"`); lines.push(vals.join(',')); }); const blob=new Blob([lines.join('\\n')],{type:'text/csv'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='complaints_export.csv'; a.click(); });
  $('#searchInput') && $('#searchInput').addEventListener('input', ()=>{ const q=$('#searchInput').value.trim().toLowerCase(); if(!q){ refreshUI(); return; } const filtered=(window._lastComplaints||[]).filter(c=> (c.title+c.description).toLowerCase().includes(q)); $('#cardsContainer').innerHTML=''; filtered.forEach(it=>{ const div=document.createElement('div'); div.className='card-item'; div.innerHTML=`<div style="display:flex;justify-content:space-between"><div><strong>${escapeHtml(it.title)}</strong><div class="small-muted">${escapeHtml(it.category)} · ${escapeHtml(it.priority)}</div></div><div>${escapeHtml(it.status)}</div></div><p class="small-muted">${escapeHtml(it.description).slice(0,120)}</p>`; $('#cardsContainer').appendChild(div); }); });
  $('#clearSearch') && $('#clearSearch').addEventListener('click', ()=>{ $('#searchInput').value=''; refreshUI(); });
  $('#loginBtn') && $('#loginBtn').addEventListener('click', async ()=>{ try{ await login($('#loginUser').value.trim(), $('#loginPass').value); }catch(e){ alert('Login failed: '+e.message); } });
  $('#logoutBtn') && $('#logoutBtn').addEventListener('click', ()=>{ localStorage.removeItem('agm_jwt'); $('#logoutBtn').style.display='none'; $('#loginBtn').style.display='inline-block'; toast('Logged out'); });
  $('#assistantSend') && $('#assistantSend').addEventListener('click', ()=>{ const txt=$('#assistantInput').value.trim(); if(!txt) return; $('#assistantMessages').innerHTML='<div class="msg"><strong>Assistant</strong><div>...</div></div>'; startChatStream([{role:'user',content:txt}], chunk=>{ const prev = $('#assistantMessages').innerHTML; $('#assistantMessages').innerHTML = `<div class="msg"><strong>Assistant</strong><div>${escapeHtml((prev.replace(/<[^>]+>/g,''))+chunk)}</div></div>`; }, ()=>{ $('#assistantInput').value=''; }); });
  $('#themeToggle') && $('#themeToggle').addEventListener('click', ()=>{ document.body.classList.toggle('light-mode'); const ic = $('#themeToggle i'); ic.className = document.body.classList.contains('light-mode') ? 'fa-solid fa-sun' : 'fa-solid fa-moon'; });
  $('#simulateBtn') && $('#simulateBtn').addEventListener('click', ()=>{ if(window._simTimer) return; window._simTimer = setInterval(async ()=>{ const all = await loadComplaints(); if(!all.length) return; const idx = Math.floor(Math.random()*all.length); const statuses = ['Submitted','Under Review','Resolved']; const s = statuses[Math.floor(Math.random()*statuses.length)]; const id = all[idx].id; try{ const tk=getToken(); if(tk){ await fetch('/api/complaints/'+id+'/status',{method:'POST',headers:{'Content-Type':'application/json',...authHeaders()},body:JSON.stringify({status:s})}); } }catch(e){} refreshUI(); }, 2200); toast('Simulation started'); });
  $('#stopSimBtn') && $('#stopSimBtn').addEventListener('click', ()=>{ clearInterval(window._simTimer); window._simTimer=null; toast('Simulation stopped'); });
  $('#quickLogin') && $('#quickLogin').addEventListener('change', async e=>{ if(!e.target.value) return; const [u,p] = e.target.value.split('|'); $('#loginUser').value=u; $('#loginPass').value=p; $('#loginBtn').click(); });
  setInterval(async ()=>{ try{ const r=await fetch('/api/health'); if(r.ok){ $('#serverIcon').className='dot green'; $('#serverText').textContent='Connected'; }else{ $('#serverIcon').className='dot yellow'; $('#serverText').textContent='Slow'; } }catch(e){ $('#serverIcon').className='dot red'; $('#serverText').textContent='Offline'; } }, 3000);
  // initial load
  (async ()=>{ await refreshUI(); window._lastComplaints = await loadComplaints(); })();
});
