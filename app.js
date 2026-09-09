// Backed by Supabase — see README.md for the project and schema.
const SUPABASE_URL = 'https://shkfwuogrldbqldpipxd.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Tyz3dga_yS3hmKugZcFmTQ_GrWohBiV';
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const levels=[['considering','Considering'],['planning','Planning'],['locked','Locked in']];
let state=JSON.parse(localStorage.getItem('balance-race-ui')||'null')||{user:'',filter:'',open:null,form:{}};
state.filter ||= '';
state.viewFilter ||= 'club';
let races=[];
let loadError=null;
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
async function saveEntry(raceId,name,event,level){
  const {error}=await db.from('entries').upsert({race_id:raceId,name,event,level},{onConflict:'race_id,name'});
  if(error) throw new Error(error.message);
}
async function addRace(payload){
  const {error}=await db.from('races').insert({
    name:payload.name,
    date:payload.date,
    location:payload.location||'Location TBC',
    url:payload.url||null,
    events:payload.events||[],
    club_focus:payload.clubFocus==='Y',
  });
  if(error) throw new Error(error.message);
}
async function loadRaces(){
  try{
    loadError=null;
    const {data,error}=await db.from('races').select('*, entries(name,event,level)').order('date');
    if(error) throw error;
    races=(data||[]).map(r=>({
      id:r.id,
      name:r.name,
      date:r.date,
      location:r.location,
      url:r.url,
      events:r.events||[],
      clubFocus:r.club_focus?'Y':'N',
      entries:r.entries.map(e=>({...e,event:String(e.event),level:String(e.level)})),
    }));
  }catch(err){
    loadError='fetch-failed';
    races=[];
  }
  render();
}
function render(){const list=$('#raceList');list.innerHTML='';
  if(loadError==='fetch-failed'){$('#emptyState').textContent='Could not reach the Supabase backend. Check your connection and try refreshing.';$('#emptyState').classList.remove('hidden');$('#allCount').textContent='0';$('#clubCount').textContent='0';return}
  const today=new Date();const todayStr=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;const futureRaces=races.filter(r=>r.date>=todayStr);$('#allCount').textContent=futureRaces.filter(r=>r.clubFocus!=='Y').length;$('#clubCount').textContent=futureRaces.filter(r=>r.clubFocus==='Y').length;
  document.querySelectorAll('.view-toggle-btn').forEach(b=>b.classList.toggle('selected',b.dataset.view===state.viewFilter));
  const sorted=[...races].filter(r=>r.date>=todayStr).filter(r=>state.viewFilter==='club'?r.clubFocus==='Y':true).sort((a,b)=>a.date.localeCompare(b.date));const query=state.filter.trim().toLocaleLowerCase();const shown=query?sorted.filter(r=>r.entries.some(e=>e.name.toLocaleLowerCase().includes(query))):sorted;const filter=$('#athleteFilter');filter.value=state.filter;$('#emptyState').textContent=query?`No races found for “${state.filter.trim()}”. Try another name.`:(state.viewFilter==='club'?'No upcoming club-focussed races yet.':'No races here yet. Add a race to get started.');$('#emptyState').classList.toggle('hidden',shown.length>0);$('#upcomingHeading').classList.toggle('hidden',shown.length===0);let last='';const appendRace=(race,container)=>{const p=dateParts(race.date);if(p.group!==last){const h=document.createElement('div');h.className='month-label';h.textContent=p.group;container.append(h);last=p.group}const node=$('#raceTemplate').content.cloneNode(true);const card=node.querySelector('.race-card');const expanded=state.open===race.id;card.classList.toggle('open',expanded);const summary=node.querySelector('.race-summary');summary.classList.toggle('club-focus',race.clubFocus==='Y');summary.setAttribute('aria-expanded',expanded);summary.setAttribute('aria-label',`${expanded?'Hide':'Show'} commitments for ${race.name}`);node.querySelector('.date-tile strong').textContent=p.day;node.querySelector('.date-tile span').textContent=p.month;node.querySelector('.race-info h2').textContent=race.name;node.querySelector('.race-info h2').insertAdjacentHTML('beforeend',race.clubFocus==='Y'?' <span class="club-focus-badge">Club focus</span>':'');const locked=race.entries.filter(e=>e.level==='locked').length;node.querySelector('.race-meta').textContent=`${locked} locked in of ${race.entries.length}`;summary.onclick=()=>{state.open=state.open===race.id?null:race.id;if(state.open){const mine=myEntry(race);const event=mine?.event||race.events[0]||'';state.form={event,level:mine?.level||'considering',otherMode:!!(mine&&!race.events.includes(mine.event))}}persist();render()};const details=node.querySelector('.race-details');if(expanded){details.classList.remove('hidden');details.append(makeDetails(race))}container.append(node)};shown.forEach(race=>appendRace(race,list))}
function makeDetails(race){const wrap=document.createElement('div');wrap.className='details-card';const entries=race.entries.filter(e=>e.level!=='not');const eventGroups={};entries.forEach(e=>{const key=e.event||'Event TBC';(eventGroups[key]||=[]).push(e)});const eventKeys=Object.keys(eventGroups).sort((a,b)=>a.localeCompare(b));eventKeys.forEach(k=>eventGroups[k].sort((a,b)=>a.name.localeCompare(b.name)));const orderedEntries=eventKeys.flatMap(k=>eventGroups[k]);const levelLabel=Object.fromEntries(levels);const rosterBody=orderedEntries.length?eventKeys.map(key=>`<div class="roster-group"><p class="roster-group-label">${key}</p>${eventGroups[key].map(e=>`<div class="roster-entry"><div class="roster-who"><span class="roster-name">${e.name}</span><span class="roster-level level-${e.level}">${levelLabel[e.level]||e.level}</span></div><button type="button" class="roster-remove" aria-label="Remove ${e.name} from this race">Remove</button></div>`).join('')}</div>`).join(''):'<p class="helper-text">No commitments yet — be the first.</p>';wrap.innerHTML=`${race.url?'<div class="card-header">Race website</div><div class="card-body race-website-body"></div>':''}<div class="card-header">Club commitments</div><div class="card-body roster-body">${rosterBody}</div><div class="card-header">Your commitment</div><div class="card-body"><p class="choice-label">Your name</p><div class="name-row"><input class="name-input" placeholder="Your name"></div><p class="choice-label">Commitment level</p><div class="level-choices choices"></div><p class="choice-label">Participation type</p><div class="event-choices choices"></div><div class="other-row hidden"><input class="other-input" placeholder="Type your event or distance"></div><div class="save-row"><button type="button" class="save-button">Save commitment</button></div></div>`;if(race.url){const a=document.createElement('a');a.className='race-link';a.href=race.url;a.textContent=race.url;a.title=race.url;a.target='_blank';a.rel='noopener';a.setAttribute('aria-label',`${race.name} website: ${race.url}`);wrap.querySelector('.race-website-body').append(a)}wrap.querySelectorAll('.roster-remove').forEach((btn,i)=>{btn.onclick=async()=>{const entry=orderedEntries[i];if(!confirm(`Remove ${entry.name} from this race?`))return;btn.disabled=true;btn.textContent='Removing…';try{await removeEntry(race.id,entry.name);await loadRaces()}catch(err){btn.disabled=false;btn.textContent='Remove';alert('Could not remove: '+err.message)}}});const nameInput=wrap.querySelector('.name-input');nameInput.value='';const eventChoices=wrap.querySelector('.event-choices');const otherRow=wrap.querySelector('.other-row');const otherInput=wrap.querySelector('.other-input');otherInput.value=state.form.otherMode?state.form.event||'':'';otherInput.oninput=()=>{state.form.event=otherInput.value;persist()};function update(){eventChoices.innerHTML='';race.events.forEach(event=>{const b=document.createElement('button');b.type='button';b.className='choice '+(!state.form.otherMode&&state.form.event===event?'selected':'');b.textContent=event;b.onclick=()=>{state.form.otherMode=false;state.form.event=event;persist();update()};eventChoices.append(b)});const otherBtn=document.createElement('button');otherBtn.type='button';otherBtn.className='choice '+(state.form.otherMode?'selected':'');otherBtn.textContent='Other';otherBtn.onclick=()=>{state.form.otherMode=true;persist();update();otherInput.focus()};eventChoices.append(otherBtn);otherRow.classList.toggle('hidden',!state.form.otherMode);const lc=wrap.querySelector('.level-choices');lc.innerHTML='';levels.forEach(([key,label])=>{const b=document.createElement('button');b.type='button';b.className=`choice level-${key} ${state.form.level===key?'selected':''}`;b.textContent=label;b.onclick=()=>{state.form.level=key;persist();update()};lc.append(b)});const btn=wrap.querySelector('.save-button');btn.onclick=async()=>{const name=nameInput.value.trim();if(!name){nameInput.focus();return}const event=(state.form.otherMode?otherInput.value:state.form.event).trim();if(!event){(state.form.otherMode?otherInput:eventChoices).focus?.();return}btn.disabled=true;btn.textContent='Saving…';try{if(!race.events.includes(event))await addEvent(race.id,event);await saveEntry(race.id,name,event,state.form.level);state.user=name;persist();await loadRaces()}catch(err){btn.disabled=false;btn.textContent='Save commitment';alert('Could not save: '+err.message)}}}update();return wrap}
function toggleAdd(open){const panel=$('#addPanel');panel.classList.toggle('hidden',!open);if(open)panel.querySelector('input').focus()}
document.querySelectorAll('.view-toggle-btn').forEach(b=>b.onclick=()=>{state.viewFilter=b.dataset.view;persist();render()});
$('#athleteFilter').oninput=e=>{state.filter=e.target.value;persist();render()};$('#heroAddButton').onclick=()=>{toggleAdd(true);$('#addPanel').scrollIntoView({behavior:'smooth',block:'start'})};$('#closeAddButton').onclick=()=>toggleAdd(false);$('#cancelAddButton').onclick=()=>toggleAdd(false);$('#raceForm').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target);const submitBtn=e.target.querySelector('.primary-button');submitBtn.disabled=true;let url=f.get('url').trim();if(url&&!/^https?:\/\//i.test(url))url='https://'+url;try{await addRace({name:f.get('name').trim(),date:f.get('date'),location:'Location TBC',url,events:f.get('events').split(',').map(x=>x.trim()).filter(Boolean),clubFocus:f.get('clubFocus')?'Y':'N'});e.target.reset();toggleAdd(false);await loadRaces()}catch(err){alert('Could not add race: '+err.message)}finally{submitBtn.disabled=false}});$('#resetButton').onclick=()=>loadRaces();loadRaces();
