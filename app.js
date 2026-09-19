// Backed by Supabase — see README.md for the project and schema.
const SUPABASE_URL = 'https://shkfwuogrldbqldpipxd.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Tyz3dga_yS3hmKugZcFmTQ_GrWohBiV';
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const levels=[['considering','Considering'],['planning','Planning'],['locked','Locked in']];
const eventTypes=['Balance Bolt','Bike','Multi-sport','Run','Swim','Triathlon'];
let state=JSON.parse(localStorage.getItem('balance-race-ui')||'null')||{user:'',filter:'',form:{}};
state.filter ||= '';
state.eventTypeFilter ||= '';
state.viewFilter ||= 'club';
if(!Array.isArray(state.form?.events)){
  const legacyEvent=state.form?.event;
  state.form={events:legacyEvent?[legacyEvent]:[],otherText:'',otherOpen:false,level:state.form?.level||'considering'};
}
let races=[];
let loadError=null;
let editingId=null;
let openId=null;
let toast=null;
let toastTimer=null;
function showToast(msg){toast=msg;render();clearTimeout(toastTimer);toastTimer=setTimeout(()=>{toast=null;render()},4000)}
const $=s=>document.querySelector(s); const persist=()=>localStorage.setItem('balance-race-ui',JSON.stringify(state));
function dateParts(date){const d=new Date(date+'T12:00:00');return {day:String(d.getDate()).padStart(2,'0'),month:d.toLocaleString('en-AU',{month:'short'}),group:d.toLocaleString('en-AU',{month:'long',year:'numeric'})}}
function myEntry(race){return race.entries.find(e=>e.name===state.user)}
async function removeEntry(raceId,name){
  const {error}=await db.from('entries').delete().eq('race_id',raceId).eq('name',name);
  if(error) throw new Error(error.message);
}
async function addEvent(raceId,event){
  const race=races.find(r=>r.id===raceId);
  const events=[...new Set([...(race?.events||[]),event])];
  const {error}=await db.from('races').update({events}).eq('id',raceId);
  if(error) throw new Error(error.message);
}
async function saveEntry(raceId,name,events,level){
  const {error}=await db.from('entries').upsert({race_id:raceId,name,events,level},{onConflict:'race_id,name'});
  if(error) throw new Error(error.message);
}
async function addRace(payload){
  const {error}=await db.from('races').insert({
    name:payload.name,
    date:payload.date,
    location:payload.location||'Location TBC',
    url:payload.url||null,
    events:payload.events||[],
    event_type:payload.eventType||null,
    club_focus:payload.eventType==='Balance Bolt'||payload.clubFocus==='Y',
    balance_bolt:payload.eventType==='Balance Bolt',
  });
  if(error) throw new Error(error.message);
}
async function deleteRace(raceId){
  // .select() makes the deleted rows come back, so a delete that matches
  // nothing (e.g. a missing row-level-security delete policy, which returns
  // success with zero rows rather than an error) surfaces instead of looking
  // like it worked.
  const {data,error}=await db.from('races').delete().eq('id',raceId).select('id');
  if(error) throw new Error(error.message);
  if(!data||!data.length) throw new Error('the race was not removed. The database rejected the delete — check that a delete policy exists on the races table.');
}
async function updateRace(raceId,payload){
  const {error}=await db.from('races').update({
    name:payload.name,
    date:payload.date,
    url:payload.url||null,
    events:payload.events||[],
    event_type:payload.eventType||null,
    club_focus:payload.eventType==='Balance Bolt'||payload.clubFocus==='Y',
    balance_bolt:payload.eventType==='Balance Bolt',
  }).eq('id',raceId);
  if(error) throw new Error(error.message);
}
function openRaceScreen(raceId){
  const race=races.find(r=>r.id===raceId);
  if(!race)return;
  const mine=myEntry(race);
  openId=raceId;
  state.form={events:mine?mine.events.slice():[],otherText:'',otherOpen:false,level:mine?.level||'considering',commitOpen:!!mine,editingName:mine?.name||''};
  persist();
  $('#top').classList.add('hidden');
  document.querySelector('.toolbar').classList.add('hidden');
  $('#addPanel').classList.add('hidden');
  $('#upcomingHeading').classList.add('hidden');
  $('#emptyState').classList.add('hidden');
  $('#raceList').classList.add('hidden');
  $('#raceScreen').classList.remove('hidden');
  window.scrollTo({top:0,behavior:'smooth'});
  render();
}
function closeRaceScreen(){
  openId=null;
  $('#raceScreen').classList.add('hidden');
  $('#top').classList.remove('hidden');
  document.querySelector('.toolbar').classList.remove('hidden');
  $('#raceList').classList.remove('hidden');
  render();
}
// Balance Bolt races only need a date and a race number, and they are always club
// focus races — so the other fields are hidden and the name field is relabelled.
// Shared by #raceForm and #editForm, whose field markup is identical.
function applyEventTypeFields(form){
  const bolt=form.eventType.value==='Balance Bolt';
  form.querySelectorAll('.field-url,.field-events,.checkbox-field').forEach(el=>el.classList.toggle('hidden',bolt));
  const nameField=form.querySelector('.field-name');
  nameField.querySelector('.field-label').textContent=bolt?'Race #':'Race name';
  nameField.querySelector('input').placeholder=bolt?'e.g. 3':'e.g. Melbourne Marathon';
}
function openEditScreen(raceId){
  const race=races.find(r=>r.id===raceId);
  if(!race)return;
  editingId=raceId;
  $('#editBackLabel').textContent=`Back to ${race.name}`;
  $('#editScreenTitle').textContent=race.name;
  const f=$('#editForm');
  f.name.value=race.name;
  f.date.value=race.date;
  f.url.value=race.url||'';
  f.events.value=race.events.join(', ');
  f.eventType.value=eventTypes.includes(race.eventType)?race.eventType:'';
  f.clubFocus.checked=race.clubFocus==='Y';
  applyEventTypeFields(f);
  $('#top').classList.add('hidden');
  document.querySelector('.toolbar').classList.add('hidden');
  $('#addPanel').classList.add('hidden');
  $('#upcomingHeading').classList.add('hidden');
  $('#emptyState').classList.add('hidden');
  $('#raceList').classList.add('hidden');
  $('#raceScreen').classList.add('hidden');
  $('#editScreen').classList.remove('hidden');
  window.scrollTo({top:0,behavior:'smooth'});
}
function closeEditScreen(){
  editingId=null;
  $('#editScreen').classList.add('hidden');
  if(openId){$('#raceScreen').classList.remove('hidden')}else{$('#top').classList.remove('hidden');document.querySelector('.toolbar').classList.remove('hidden');$('#raceList').classList.remove('hidden')}
  render();
}
async function loadRaces(){
  try{
    loadError=null;
    const {data,error}=await db.from('races').select('*, entries(name,events,level)').order('date');
    if(error) throw error;
    races=(data||[]).map(r=>({
      id:r.id,
      name:r.name,
      date:r.date,
      location:r.location,
      url:r.url,
      events:r.events||[],
      eventType:r.event_type||'',
      clubFocus:r.club_focus?'Y':'N',
      balanceBolt:r.event_type==='Balance Bolt'?'Y':'N',
      entries:r.entries.map(e=>({...e,events:(e.events||[]).map(String),level:String(e.level)})),
    }));
  }catch(err){
    loadError='fetch-failed';
    races=[];
  }
  render();
}
function render(){const list=$('#raceList');list.innerHTML='';
  document.querySelectorAll('.view-toggle-btn').forEach(b=>b.classList.toggle('selected',b.dataset.view===state.viewFilter));
  $('#updateBannerText').textContent=toast||'';
  $('#updateBanner').classList.toggle('hidden',!toast);
  if(loadError==='fetch-failed'){$('#emptyState').textContent='Could not reach the Supabase backend. Check your connection and try refreshing.';$('#emptyState').classList.remove('hidden');$('#allCount').textContent='0';$('#clubCount').textContent='0';return}
  const today=new Date();const todayStr=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;const futureRaces=races.filter(r=>r.date>=todayStr);$('#allCount').textContent=futureRaces.filter(r=>r.clubFocus!=='Y').length;$('#clubCount').textContent=futureRaces.filter(r=>r.clubFocus==='Y').length;
  const byType=r=>!state.eventTypeFilter||r.eventType===state.eventTypeFilter;
  const sorted=[...races].filter(r=>r.date>=todayStr).filter(r=>state.viewFilter==='club'?r.clubFocus==='Y':true).filter(byType).sort((a,b)=>a.date.localeCompare(b.date));const query=state.filter.trim().toLocaleLowerCase();const shown=query?sorted.filter(r=>r.entries.some(e=>e.name.toLocaleLowerCase().includes(query))):sorted;const filter=$('#athleteFilter');filter.value=state.filter;$('#eventTypeFilter').value=state.eventTypeFilter;const active=[],tips=[];if(query){active.push(`the name “${state.filter.trim()}”`);tips.push('clearing the name search')}if(state.eventTypeFilter){active.push(`the type “${state.eventTypeFilter}”`);tips.push('choosing “All types”')}if(state.viewFilter==='club'){active.push('the club-races view');tips.push('choosing “View all”')}const joinWith=(a,w)=>a.length<2?a[0]:`${a.slice(0,-1).join(', ')} ${w} ${a[a.length-1]}`;$('#emptyState').textContent=active.length?`No upcoming races match ${joinWith(active,'and')}. Try ${joinWith(tips,'or')}.`:'No races here yet. Add a race to get started.';if(!editingId&&!openId){$('#emptyState').classList.toggle('hidden',shown.length>0);$('#upcomingHeading').classList.toggle('hidden',shown.length===0)}let last='';const appendRace=(race,container)=>{const p=dateParts(race.date);if(p.group!==last){const h=document.createElement('div');h.className='month-label';h.textContent=p.group;container.append(h);last=p.group}const node=$('#raceTemplate').content.cloneNode(true);const summary=node.querySelector('.race-summary');summary.classList.toggle('club-focus',race.clubFocus==='Y');summary.setAttribute('aria-label',`View commitments for ${race.name}`);node.querySelector('.date-tile strong').textContent=p.day;node.querySelector('.date-tile span').textContent=p.month;const h2=node.querySelector('.race-info h2');h2.textContent=race.name;if(race.eventType){h2.append(' ');const b=document.createElement('span');b.className='event-type-badge';b.textContent=race.eventType;h2.append(b)}if(race.clubFocus==='Y'){h2.append(' ');const b=document.createElement('span');b.className='club-focus-badge';b.textContent='Club focus';h2.append(b)}const locked=race.entries.filter(e=>e.level==='locked').length;node.querySelector('.race-meta').textContent=`${locked} locked in of ${race.entries.length}`;summary.onclick=()=>openRaceScreen(race.id);container.append(node)};shown.forEach(race=>appendRace(race,list));if(openId){const openRace=races.find(r=>r.id===openId);if(openRace){const p=dateParts(openRace.date);$('#raceScreenEyebrow').textContent=`${p.day} ${p.month.toUpperCase()} ${p.group.split(' ')[1]}`;$('#raceScreenTitle').textContent=openRace.name;$('#raceScreenEditButton').onclick=()=>openEditScreen(openRace.id);const body=$('#raceScreenBody');body.innerHTML='';body.append(makeDetails(openRace))}else{openId=null;$('#raceScreen').classList.add('hidden');$('#top').classList.remove('hidden');document.querySelector('.toolbar').classList.remove('hidden');$('#raceList').classList.remove('hidden')}}}
function makeDetails(race){const wrap=document.createElement('div');wrap.className='details-card';if(race.balanceBolt==='Y'){return wrap}if(state.form.commitOpen===undefined){state.form.commitOpen=!!myEntry(race);state.form.editingName=myEntry(race)?.name||''}const entries=race.entries.filter(e=>e.level!=='not');const eventGroups={};entries.forEach(e=>{const key=e.events.length?e.events.join(', '):'Event TBC';(eventGroups[key]||=[]).push(e)});const eventKeys=Object.keys(eventGroups).sort((a,b)=>a.localeCompare(b));eventKeys.forEach(k=>eventGroups[k].sort((a,b)=>a.name.localeCompare(b.name)));const orderedEntries=eventKeys.flatMap(k=>eventGroups[k]);const levelLabel=Object.fromEntries(levels);const rosterBody=orderedEntries.length?eventKeys.map(key=>`<div class="roster-group"><p class="roster-group-label">${key}</p>${eventGroups[key].map(e=>`<div class="roster-entry"><div class="roster-who"><span class="roster-name">${e.name}</span><span class="roster-level level-${e.level}">${levelLabel[e.level]||e.level}</span></div><button type="button" class="roster-edit" aria-label="Edit ${e.name}'s commitment for this race">Edit</button></div>`).join('')}</div>`).join(''):'<p class="helper-text">No commitments yet — be the first.</p>';const editingEntry=state.form.editingName?race.entries.find(e=>e.name===state.form.editingName):null;wrap.innerHTML=`${race.url?'<div class="card-header">Race website</div><div class="card-body race-website-body"></div>':''}<div class="card-header">Club commitments</div><div class="card-body roster-body">${rosterBody}</div><div class="card-header">Your commitment</div><div class="card-body"><button type="button" class="commit-toggle-button ${state.form.commitOpen?'hidden':''}">Add your commitment</button><div class="commitment-fields ${state.form.commitOpen?'':'hidden'}"><p class="choice-label">Your name</p><div class="name-row"><input class="name-input" placeholder="Your name"></div><p class="choice-label">Commitment level</p><div class="level-choices choices"></div><p class="choice-label">Participation type <span class="optional">select all that apply</span></p><div class="event-choices choices"></div><div class="other-row hidden"><input class="other-input" placeholder="Type your event or distance"></div><div class="save-row"><button type="button" class="save-button">Save commitment</button>${editingEntry?'<button type="button" class="remove-commit-button">Remove commitment</button>':''}</div></div></div>`;const commitToggle=wrap.querySelector('.commit-toggle-button'),commitFields=wrap.querySelector('.commitment-fields');commitToggle.onclick=()=>{state.form.commitOpen=true;persist();commitToggle.classList.add('hidden');commitFields.classList.remove('hidden');nameInput.focus()};if(race.url){const a=document.createElement('a');a.className='race-link';a.href=race.url;a.textContent=race.url;a.title=race.url;a.target='_blank';a.rel='noopener';a.setAttribute('aria-label',`${race.name} website: ${race.url}`);wrap.querySelector('.race-website-body').append(a)}wrap.querySelectorAll('.roster-edit').forEach((btn,i)=>{btn.onclick=()=>{const entry=orderedEntries[i];const opts=participationOptions();const known=[],extra=[];entry.events.forEach(ev=>{const k=ev.trim().toLowerCase();const hit=opts.find(o=>o.toLowerCase()===k)||(k==='to'?'TO (Technical official)':k==='team'?'Team':null);if(hit)known.includes(hit)||known.push(hit);else extra.push(ev)});state.form={events:known,otherText:extra.join(', '),otherOpen:!!extra.length,level:entry.level,commitOpen:true,editingName:entry.name};persist();render();const fields=$('.commitment-fields');if(fields){fields.querySelector('.name-input').focus({preventScroll:true});fields.scrollIntoView({behavior:'smooth',block:'center'})}}});const removeCommitButton=wrap.querySelector('.remove-commit-button');if(removeCommitButton)removeCommitButton.onclick=async()=>{if(!confirm(`Remove ${editingEntry.name} from this race?`))return;removeCommitButton.disabled=true;removeCommitButton.textContent='Removing…';try{await removeEntry(race.id,editingEntry.name);state.form={events:[],otherText:'',otherOpen:false,level:'considering',commitOpen:false,editingName:''};persist();await loadRaces()}catch(err){removeCommitButton.disabled=false;removeCommitButton.textContent='Remove commitment';alert('Could not remove: '+err.message)}};const nameInput=wrap.querySelector('.name-input');nameInput.value=state.form.editingName||'';const eventChoices=wrap.querySelector('.event-choices');const otherRow=wrap.querySelector('.other-row');const otherInput=wrap.querySelector('.other-input');otherInput.value=state.form.otherText||'';otherInput.oninput=()=>{state.form.otherText=otherInput.value;persist()};
function participationOptions(){const merged=[...race.events];const ensure=(label,aliases)=>{const idx=merged.findIndex(e=>aliases.includes(e.trim().toLowerCase()));if(idx>=0)merged[idx]=label;else merged.push(label)};ensure('TO (Technical official)',['to','to (technical official)']);ensure('Team',['team']);return merged}
function update(){eventChoices.innerHTML='';participationOptions().forEach(event=>{const b=document.createElement('button');b.type='button';const active=state.form.events.includes(event);b.className='choice '+(active?'selected':'');b.setAttribute('aria-pressed',String(active));b.textContent=event;b.onclick=()=>{state.form.events=active?state.form.events.filter(x=>x!==event):[...state.form.events,event];persist();update()};eventChoices.append(b)});const otherBtn=document.createElement('button');otherBtn.type='button';otherBtn.className='choice '+(state.form.otherOpen?'selected':'');otherBtn.setAttribute('aria-pressed',String(!!state.form.otherOpen));otherBtn.textContent='Other';otherBtn.onclick=()=>{state.form.otherOpen=!state.form.otherOpen;persist();update();if(state.form.otherOpen)otherInput.focus()};eventChoices.append(otherBtn);otherRow.classList.toggle('hidden',!state.form.otherOpen);const lc=wrap.querySelector('.level-choices');lc.innerHTML='';levels.forEach(([key,label])=>{const b=document.createElement('button');b.type='button';b.className=`choice level-${key} ${state.form.level===key?'selected':''}`;b.textContent=label;b.onclick=()=>{state.form.level=key;persist();update()};lc.append(b)});const btn=wrap.querySelector('.save-button');btn.onclick=async()=>{const name=nameInput.value.trim();if(!name){nameInput.focus();return}const extra=(state.form.otherText||'').trim();const events=[...new Set([...state.form.events,...(extra?[extra]:[])])];if(!events.length){(state.form.otherOpen?otherInput:eventChoices).focus?.();return}btn.disabled=true;btn.textContent='Saving…';try{for(const ev of events){if(!race.events.includes(ev))await addEvent(race.id,ev)}await saveEntry(race.id,name,events,state.form.level);if(state.form.editingName&&state.form.editingName!==name)await removeEntry(race.id,state.form.editingName);state.form.editingName=name;state.user=name;persist();await loadRaces()}catch(err){btn.disabled=false;btn.textContent='Save commitment';alert('Could not save: '+err.message)}}}update();return wrap}
function toggleAdd(open){const panel=$('#addPanel');panel.classList.toggle('hidden',!open);if(open)panel.querySelector('input').focus()}
document.querySelectorAll('.view-toggle-btn').forEach(b=>b.onclick=()=>{state.viewFilter=b.dataset.view;persist();render()});
document.querySelectorAll('#raceForm,#editForm').forEach(f=>{f.eventType.onchange=()=>applyEventTypeFields(f);applyEventTypeFields(f)});
$('#athleteFilter').oninput=e=>{state.filter=e.target.value;persist();render()};$('#eventTypeFilter').onchange=e=>{state.eventTypeFilter=e.target.value;persist();render()};$('#heroAddButton').onclick=()=>{if(editingId)closeEditScreen();toggleAdd(true);$('#addPanel').scrollIntoView({behavior:'smooth',block:'start'})};$('#closeAddButton').onclick=()=>toggleAdd(false);$('#cancelAddButton').onclick=()=>toggleAdd(false);$('#raceForm').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target);const submitBtn=e.target.querySelector('.primary-button');submitBtn.disabled=true;let url=f.get('url').trim();if(url&&!/^https?:\/\//i.test(url))url='https://'+url;try{await addRace({name:f.get('name').trim(),date:f.get('date'),location:'Location TBC',url,events:f.get('events').split(',').map(x=>x.trim()).filter(Boolean),eventType:f.get('eventType'),clubFocus:f.get('clubFocus')?'Y':'N'});e.target.reset();applyEventTypeFields(e.target);toggleAdd(false);await loadRaces()}catch(err){alert('Could not add race: '+err.message)}finally{submitBtn.disabled=false}});
$('#editCancelButton').onclick=closeEditScreen;$('#editBackButton').onclick=closeEditScreen;$('#raceScreenBackButton').onclick=closeRaceScreen;
$('#removeRaceButton').onclick=async()=>{const raceId=editingId;if(!raceId)return;const race=races.find(r=>r.id===raceId);if(!confirm(`Remove ${race?.name||'this race'} from the calendar? This can't be undone.`))return;const btn=$('#removeRaceButton');btn.disabled=true;btn.textContent='Removing…';try{await deleteRace(raceId);editingId=null;openId=null;$('#editScreen').classList.add('hidden');$('#raceScreen').classList.add('hidden');$('#top').classList.remove('hidden');document.querySelector('.toolbar').classList.remove('hidden');$('#raceList').classList.remove('hidden');await loadRaces();showToast(`${race?.name||'Race'} removed`)}catch(err){alert('Could not remove race: '+err.message)}finally{btn.disabled=false;btn.textContent='Remove race'}};$('#editForm').addEventListener('submit',async e=>{e.preventDefault();const raceId=editingId;if(!raceId)return;const f=new FormData(e.target);const submitBtn=e.target.querySelector('.primary-button');submitBtn.disabled=true;let url=f.get('url').trim();if(url&&!/^https?:\/\//i.test(url))url='https://'+url;const name=f.get('name').trim();try{await updateRace(raceId,{name,date:f.get('date'),url,events:f.get('events').split(',').map(x=>x.trim()).filter(Boolean),eventType:f.get('eventType'),clubFocus:f.get('clubFocus')?'Y':'N'});closeEditScreen();await loadRaces();showToast(`${name} updated`)}catch(err){alert('Could not save changes: '+err.message)}finally{submitBtn.disabled=false}});
$('#resetButton').onclick=()=>{loadRaces()};loadRaces();
