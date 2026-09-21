// Backed by Supabase — see README.md for the project and schema.
const SUPABASE_URL = 'https://shkfwuogrldbqldpipxd.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Tyz3dga_yS3hmKugZcFmTQ_GrWohBiV';
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const levels=[['considering','Considering'],['planning','Planning'],['locked','Locked in']];
const eventTypes=['Balance Bolt','Bike','Multi-sport','Run','Swim','Triathlon'];
const BALANCE_BOLT_URL='https://jthoyer.github.io/BalanceBolt/';
// Balance Bolt race names hold the race number, plain ("3") or with the
// "BALANCE BOLT #1" lead-in older rows have — either way the number is the
// only digits in the name, and that's what BalanceBolt's own ?race= param wants.
function boltEmbedUrl(race){
  if(race.url)return race.url;
  const n=(race.name||'').match(/\d+/);
  return n?`${BALANCE_BOLT_URL}?race=${n[0]}`:null;
}
let state=JSON.parse(localStorage.getItem('balance-race-ui')||'null')||{user:'',filter:'',form:{}};
state.filter ||= '';
state.eventTypeFilter ||= '';
state.viewFilter ||= 'club';
state.authDismissedUntil ||= 0;
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
// ---------------------------------------------------------------------------
// Auth. Magic-link sign-in via Supabase Auth. Browsing the calendar and every
// roster stays open to everyone signed out — but saving, editing or removing
// a commitment requires being signed in (requireSignIn, below, and the
// matching RLS policies on entries). It's still the same honour system once
// signed in: any authenticated member can add or edit any entry by typed
// name (see saveEntry) — sign-in isn't tied to ownership, only to being
// someone. A signed-in profile's display_name seeds state.user once, but
// never overwrites a name someone's already typed in this browser.
// ---------------------------------------------------------------------------
let session=null;
let profile=null;
async function loadProfile(){
  const {data,error}=await db.from('profiles').select('display_name').eq('id',session.user.id).single();
  profile=error?null:data;
  if(profile?.display_name&&!state.user){state.user=profile.display_name;persist()}
}
function renderAuth(){
  const widget=$('#authWidget');
  if(session){
    widget.innerHTML=`<span class="auth-name">${profile?.display_name||session.user.email}</span><button type="button" class="text-button" id="signOutButton">Sign out</button>`;
    $('#signOutButton').onclick=()=>db.auth.signOut();
  }else{
    widget.innerHTML=`<button type="button" class="text-button" id="signInButton">Sign in</button>`;
    // Opens the same auth sheet the nudge/gate use, rather than expanding a
    // form inline into the header — that used to squeeze the topbar's other
    // buttons on narrow phones (the "condensing" bug: real document flow,
    // not an overlay, competing for space in .header-actions).
    $('#signInButton').onclick=()=>requireSignIn('Sign in');
  }
}
// heading: an <h2> to show above the email field. cancel: a handler for a
// "Cancel" button shown below the form. Always targets the auth sheet now.
function openSignInForm(host,{heading,cancel}={}){
  host.innerHTML=`${heading?`<h2>${heading}</h2>`:''}<form class="sign-in-form"><input type="email" name="email" placeholder="you@example.com" required autocomplete="email" /><button type="submit" class="send-link-button">Send link</button></form>${cancel?'<button type="button" class="auth-sheet-cancel">Cancel</button>':''}`;
  const form=host.querySelector('form');
  form.addEventListener('submit',async e=>{
    e.preventDefault();
    const email=new FormData(e.target).get('email').trim();
    const btn=e.target.querySelector('button');
    btn.disabled=true;btn.textContent='Sending…';
    const {error}=await db.auth.signInWithOtp({email,options:{emailRedirectTo:location.href}});
    if(error){alert('Could not send sign-in link: '+error.message);btn.disabled=false;btn.textContent='Send link';return}
    showCodeStep(host,email,cancel);
  });
  if(cancel)host.querySelector('.auth-sheet-cancel').onclick=cancel;
}
// Step two: the email carries both a link and a 6-digit code, and this is the
// box for the code. It exists because of how magic links fail on a phone —
// tapping the link inside the Gmail or Outlook app opens an in-app browser,
// which signs *that* browser in and leaves the tab they started in signed
// out, form and all. Typing the code signs them in where they already are.
// Supabase issues one token per request, so the link and the code are the
// same credential: whichever they use, the other stops working.
function showCodeStep(host,email,cancel){
  host.innerHTML=`<h2>Check your email</h2><p class="auth-sheet-hint">We've sent a sign-in link and a 6-digit code to <strong class="sent-to-address"></strong>. Tap the link, or type the code here — whichever is easier.</p><form class="sign-in-form code-form"><input class="code-input" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" placeholder="123456" required aria-label="6-digit code from your email" title="Six digits, from the email" /><button type="submit" class="send-link-button">Sign me in</button></form><p class="auth-sheet-hint auth-sheet-hint-muted">No email yet? Give it a minute, then check your spam folder.</p>${cancel?'<button type="button" class="auth-sheet-cancel">Cancel</button>':''}`;
  // textContent, not interpolation: a typed email must never reach innerHTML.
  host.querySelector('.sent-to-address').textContent=email;
  const form=host.querySelector('form');
  const input=form.querySelector('.code-input');
  // Phones paste the code with whatever spacing the mail app rendered, so
  // strip anything that isn't a digit as they type rather than rejecting it.
  // This is also why there's no maxlength: the attribute truncates a pasted
  // "48 29 15" to "48 29 " before this handler ever sees it, and the strip
  // then leaves four digits. Length is enforced here instead.
  input.addEventListener('input',()=>{input.value=input.value.replace(/\D/g,'').slice(0,6)});
  input.focus();
  form.addEventListener('submit',async e=>{
    e.preventDefault();
    const token=input.value.trim();
    const btn=form.querySelector('button');
    btn.disabled=true;btn.textContent='Signing in…';
    // type:'email' covers both halves of signInWithOtp — a brand-new address
    // (signup) and a returning one (magiclink) — so one call handles both.
    const {error}=await db.auth.verifyOtp({email,token,type:'email'});
    // On success onAuthStateChange closes the sheet and re-renders; there's
    // no page reload here, unlike the link, so nothing else to do.
    if(error){alert('That code didn\'t work: '+error.message);btn.disabled=false;btn.textContent='Sign me in';input.select()}
  });
  if(cancel)host.querySelector('.auth-sheet-cancel').onclick=cancel;
}
// ---------------------------------------------------------------------------
// The auth sheet: every sign-in entry point (the header button, the nudge,
// and the write gate) opens this one overlay — a bottom sheet on desktop,
// full screen on mobile (styles-additions.css), never document flow that
// could squeeze other layout. As a "nudge" it appears once per visit for a
// signed-out browser (unless snoozed) offering Sign in or Just browsing;
// tapping outside it (desktop), the close button, or Just browsing all
// dismiss it the same way — self-dismissing, never blocking. As a "gate"
// requireSignIn() opens it to require sign-in before a write goes through
// (saving, editing or removing a commitment); the close button there just
// backs out.
// ---------------------------------------------------------------------------
let authSheetDismissed=false; // this pageview only, independent of the snooze
let authSheetMode=null; // 'nudge' | 'gate' | null
// Tracks the nudge's checkbox live (via onchange, below) rather than reading
// it at dismiss time, because clicking "Sign in" swaps the checkbox out for
// the email form — so a box checked before that swap must still be honoured
// if the visitor then cancels out of the email step instead of finishing it.
let authSheetSnoozeWanted=false;
function closeAuthSheet(){
  if(authSheetMode==='nudge'){
    if(authSheetSnoozeWanted){state.authDismissedUntil=Date.now()+10*24*60*60*1000;persist()}
    authSheetDismissed=true;
  }
  authSheetMode=null;
  authSheetSnoozeWanted=false;
  $('#authSheetBackdrop').classList.add('hidden');
}
function showAuthSheetNudge(){
  if(session||authSheetDismissed||Date.now()<state.authDismissedUntil)return;
  authSheetMode='nudge';
  authSheetSnoozeWanted=false;
  $('#authSheetBody').innerHTML=`<h2>Sign in to save your name?</h2><p class="auth-sheet-hint">Sign in once and we'll fill your name in every time.</p><div class="auth-sheet-actions"><button type="button" class="primary-button" id="authSheetSignInButton">Sign in</button><button type="button" class="secondary-button" id="authSheetBrowseButton">Just browsing</button></div><label class="auth-sheet-checkbox"><input type="checkbox" id="authSheetSnooze" /><span>Don't ask me to sign in again for 10 days</span></label><p class="auth-sheet-hint auth-sheet-hint-muted">You can close this and come back to it later.</p>`;
  $('#authSheetSnooze').onchange=e=>{authSheetSnoozeWanted=e.target.checked};
  $('#authSheetSignInButton').onclick=()=>openSignInForm($('#authSheetBody'),{heading:'Sign in',cancel:closeAuthSheet});
  $('#authSheetBrowseButton').onclick=closeAuthSheet;
  $('#authSheetBackdrop').classList.remove('hidden');
}
// Called before a write; opens the gate and returns false if signed out
// (callers must return immediately), or returns true if already signed in.
function requireSignIn(title){
  if(session)return true;
  authSheetMode='gate';
  openSignInForm($('#authSheetBody'),{heading:title,cancel:closeAuthSheet});
  $('#authSheetBackdrop').classList.remove('hidden');
  return false;
}
async function initAuth(){
  const {data:{session:s}}=await db.auth.getSession();
  session=s;
  if(session)await loadProfile();
  renderAuth();
  showAuthSheetNudge();
  db.auth.onAuthStateChange(async(_event,s)=>{
    session=s;
    if(session){await loadProfile();closeAuthSheet()}else profile=null;
    renderAuth();
    // Signing in with the code never reloads the page, so the name loadProfile
    // just seeded into state.user would sit unrendered until the next redraw.
    // The link path got this free from the reload.
    render();
  });
}
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
// ---------------------------------------------------------------------------
// Routing. Every race is shareable at <base>race/<slug>.
//
// The site is served from a GitHub Pages *project* path
// (jthoyer.github.io/BalanceTRI-app/), not the domain root, so the base is
// derived from the URL at load rather than hardcoded to '/'. Deriving it from
// the one route shape we have means no repo-name constant to keep in sync —
// see 404.html and the restore script in index.html for the other half of the
// GitHub Pages deep-link story.
// ---------------------------------------------------------------------------
const ROUTE_RE=/^(.*?)\/race\/([^/]+)\/?$/;
function computeBasePath(pathname){
  const m=pathname.match(ROUTE_RE);
  if(m)return (m[1]||'')+'/';
  return pathname.replace(/[^/]*$/,'')||'/';
}
const BASE_PATH=computeBasePath(location.pathname);
function slugFromPath(pathname){
  const m=pathname.match(ROUTE_RE);
  if(!m)return null;
  try{return decodeURIComponent(m[2])}catch{return m[2]}
}
function slugify(value){
  // NFD splits "ä" into "a" + a combining mark; \p{M} then drops the mark, so
  // accented names slug the same way the database's translate() table does.
  return (value||'').toLowerCase().normalize('NFD').replace(/\p{M}/gu,'')
    .replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
}
// Mirrors the database's slugify()/races_assign_slug(). Used only as a fallback
// so the app still routes if a row predates the slug migration (loadRaces
// selects *, so a missing column comes back undefined rather than erroring).
// It cannot reproduce the -2/-3 de-dup suffix, which is why the real column is
// matched first in findRaceBySlug.
function fallbackSlug(race){
  // Balance Bolt race names already say "BALANCE BOLT #1" in the data, so strip
  // that lead-in before re-adding it — otherwise it doubles up, mirroring the
  // same fix in the database's races_assign_slug().
  const base=slugify(race.eventType==='Balance Bolt'?`balance-bolt-${(race.name||'').replace(/^\s*balance\s*bolt\s*/i,'')}`:race.name)||'race';
  const year=(race.date||'').slice(0,4);
  return year?`${base}-${year}`:base;
}
function raceSlug(race){return race.slug||fallbackSlug(race)}
function racePath(race){return `${BASE_PATH}race/${encodeURIComponent(raceSlug(race))}`}
function findRaceBySlug(slug){
  if(!slug)return null;
  const key=slug.toLowerCase();
  return races.find(r=>(r.slug||'').toLowerCase()===key)
      ||races.find(r=>fallbackSlug(r).toLowerCase()===key)
      ||null;
}
function navigate(path,{replace=false}={}){
  if(path===location.pathname)return;
  history[replace?'replaceState':'pushState']({},'',path);
}
// bootstrapped: the first load attempt has finished, so popstate has something
// to route against. deepLinkResolved: a *successful* load has had a chance to
// match the incoming URL — kept separate so that a first load which failed and
// was then retried with Refresh still resolves the deep link.
let bootstrapped=false;
let deepLinkResolved=false;
function routeFromUrl(){
  if(editingId!==null){editingId=null;$('#editScreen').classList.add('hidden')}
  const slug=slugFromPath(location.pathname);
  let missing=false;
  if(slug){
    const race=findRaceBySlug(slug);
    // 'replace' rather than 'none': an exact match is a no-op, but a slug that
    // differs only in case or encoding gets rewritten to its canonical form
    // without adding a history entry.
    if(race){openRaceScreen(race.id,{history:'replace',scroll:false});return}
    // If Supabase is unreachable we have no races to match against, so the slug
    // isn't known to be bad — leave the URL alone and let the list show the
    // fetch error, rather than destroying a link that may be perfectly good.
    if(!loadError){missing=true;navigate(BASE_PATH,{replace:true})}
  }
  if(openId!==null)closeRaceScreen({history:'none'});
  else render();
  if(missing)showToast('That race link no longer works — showing the race list instead.');
}
function openRaceScreen(raceId,opts={}){
  const race=races.find(r=>r.id===raceId);
  if(!race)return false;
  const mine=myEntry(race);
  openId=raceId;
  state.form={events:mine?mine.events.slice():[],otherText:'',otherOpen:false,level:mine?.level||'considering',commitOpen:!!mine,editingName:mine?.name||''};
  persist();
  if(editingId!==null){editingId=null;$('#editScreen').classList.add('hidden')}
  $('#top').classList.add('hidden');
  document.querySelector('.toolbar').classList.add('hidden');
  $('#addPanel').classList.add('hidden');
  $('#upcomingHeading').classList.add('hidden');
  $('#emptyState').classList.add('hidden');
  $('#raceList').classList.add('hidden');
  $('#raceScreen').classList.remove('hidden');
  if(opts.history!=='none')navigate(racePath(race),{replace:opts.history==='replace'});
  if(opts.scroll!==false)window.scrollTo({top:0,behavior:'smooth'});
  render();
  return true;
}
function closeRaceScreen(opts={}){
  openId=null;
  $('#raceScreen').classList.add('hidden');
  $('#top').classList.remove('hidden');
  document.querySelector('.toolbar').classList.remove('hidden');
  $('#raceList').classList.remove('hidden');
  if(opts.history!=='none')navigate(BASE_PATH,{replace:opts.history==='replace'});
  render();
}
// After a reload, keep the URL pointing at the open race — a rename changes the
// slug, so the address bar would otherwise still hold the old one.
function syncOpenRaceUrl(){
  if(openId===null)return;
  const race=races.find(r=>r.id===openId);
  if(race)navigate(racePath(race),{replace:true});
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
      slug:r.slug||null,
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
  // Only a load that actually returned races can resolve a deep link: until
  // then a valid /race/<slug> is indistinguishable from a stale one.
  bootstrapped=true;
  if(!deepLinkResolved){
    if(!loadError)deepLinkResolved=true;
    routeFromUrl();
    return;
  }
  syncOpenRaceUrl();
  render();
}
function render(){const list=$('#raceList');list.innerHTML='';
  document.querySelectorAll('.view-toggle-btn').forEach(b=>b.classList.toggle('selected',b.dataset.view===state.viewFilter));
  $('#updateBannerText').textContent=toast||'';
  $('#updateBanner').classList.toggle('hidden',!toast);
  if(loadError==='fetch-failed'){$('#emptyState').textContent='Could not reach the Supabase backend. Check your connection and try refreshing.';$('#emptyState').classList.remove('hidden');$('#allCount').textContent='0';$('#clubCount').textContent='0';return}
  const today=new Date();const todayStr=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;const futureRaces=races.filter(r=>r.date>=todayStr);$('#allCount').textContent=futureRaces.filter(r=>r.clubFocus!=='Y').length;$('#clubCount').textContent=futureRaces.filter(r=>r.clubFocus==='Y').length;
  const byType=r=>!state.eventTypeFilter||r.eventType===state.eventTypeFilter;
  const sorted=[...races].filter(r=>r.date>=todayStr).filter(r=>state.viewFilter==='club'?r.clubFocus==='Y':true).filter(byType).sort((a,b)=>a.date.localeCompare(b.date));const query=state.filter.trim().toLocaleLowerCase();const shown=query?sorted.filter(r=>r.entries.some(e=>e.name.toLocaleLowerCase().includes(query))):sorted;const filter=$('#athleteFilter');filter.value=state.filter;$('#eventTypeFilter').value=state.eventTypeFilter;const active=[],tips=[];if(query){active.push(`the name “${state.filter.trim()}”`);tips.push('clearing the name search')}if(state.eventTypeFilter){active.push(`the type “${state.eventTypeFilter}”`);tips.push('choosing “All types”')}if(state.viewFilter==='club'){active.push('the club-races view');tips.push('choosing “View all”')}const joinWith=(a,w)=>a.length<2?a[0]:`${a.slice(0,-1).join(', ')} ${w} ${a[a.length-1]}`;$('#emptyState').textContent=active.length?`No upcoming races match ${joinWith(active,'and')}. Try ${joinWith(tips,'or')}.`:'No races here yet. Add a race to get started.';if(!editingId&&!openId){$('#emptyState').classList.toggle('hidden',shown.length>0);$('#upcomingHeading').classList.toggle('hidden',shown.length===0)}let last='';const appendRace=(race,container)=>{const p=dateParts(race.date);if(p.group!==last){const h=document.createElement('div');h.className='month-label';h.textContent=p.group;container.append(h);last=p.group}const node=$('#raceTemplate').content.cloneNode(true);const summary=node.querySelector('.race-summary');summary.classList.toggle('club-focus',race.clubFocus==='Y');summary.setAttribute('aria-label',`View commitments for ${race.name}`);node.querySelector('.date-tile strong').textContent=p.day;node.querySelector('.date-tile span').textContent=p.month;const h2=node.querySelector('.race-info h2');h2.textContent=race.name;if(race.eventType){h2.append(' ');const b=document.createElement('span');b.className='event-type-badge';b.textContent=race.eventType;h2.append(b)}if(race.clubFocus==='Y'){h2.append(' ');const b=document.createElement('span');b.className='club-focus-badge';b.textContent='Club focus';h2.append(b)}const locked=race.entries.filter(e=>e.level==='locked').length;node.querySelector('.race-meta').textContent=`${locked} locked in of ${race.entries.length}`;summary.href=racePath(race);summary.onclick=e=>{
    // A real href is what makes "open in new tab" and "copy link address" work,
    // so hand those cases back to the browser and only intercept the plain
    // left click that means "show me this race here".
    if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
    e.preventDefault();openRaceScreen(race.id);
  };container.append(node)};shown.forEach(race=>appendRace(race,list));if(openId){const openRace=races.find(r=>r.id===openId);if(openRace){const p=dateParts(openRace.date);$('#raceScreenEyebrow').textContent=`${p.day} ${p.month.toUpperCase()} ${p.group.split(' ')[1]}`;$('#raceScreenTitle').textContent=openRace.name;$('#raceScreenEditButton').onclick=()=>openEditScreen(openRace.id);const body=$('#raceScreenBody');body.innerHTML='';body.append(makeDetails(openRace))}else{openId=null;$('#raceScreen').classList.add('hidden');$('#top').classList.remove('hidden');document.querySelector('.toolbar').classList.remove('hidden');$('#raceList').classList.remove('hidden')}}}
function makeDetails(race){const wrap=document.createElement('div');wrap.className='details-card';if(race.balanceBolt==='Y'){const embedUrl=boltEmbedUrl(race);wrap.innerHTML=`${embedUrl?'<div class="card-header">Race website</div><div class="card-body race-website-body"></div>':''}<div class="card-header">Race details</div><div class="card-body race-embed-body"></div>`;if(embedUrl){const a=document.createElement('a');a.className='race-link';a.href=embedUrl;a.textContent='Open sign-up in a new tab';a.target='_blank';a.rel='noopener';a.setAttribute('aria-label',`${race.name} sign-up: ${embedUrl}`);wrap.querySelector('.race-website-body').append(a);const iframe=document.createElement('iframe');iframe.className='race-embed';iframe.src=embedUrl;iframe.loading='lazy';iframe.title=`${race.name} embedded website`;
    // Same origin as this app (both under jthoyer.github.io), so the frame's
    // own scroll height is readable — resize to it instead of clipping at a
    // fixed height or leaving a scrollbar inside a scrollbar.
    const resize=()=>{try{iframe.style.height=iframe.contentDocument.documentElement.scrollHeight+'px'}catch(e){}};
    // BalanceBolt's own topbar (its logo, a "Club calendar" link back to this
    // very app, sync status and refresh) is chrome for when it's visited on
    // its own — all redundant once it's sitting inside our "Race details" card.
    const hideChrome=()=>{try{const doc=iframe.contentDocument;if(doc.querySelector('.topbar')&&!doc.getElementById('embed-chrome-hide')){const style=doc.createElement('style');style.id='embed-chrome-hide';
    // Its .shell gutter (16px each side, from BalanceBolt's own width:min(1100px, calc(100% - 32px)))
    // is chrome too here — our own card already carries the padding (.race-embed-body is
    // padding:0 for this reason), so left alone the two stack and the sign-up form reads as
    // a page inside our page instead of part of it.
    style.textContent='.topbar{display:none}.shell{width:100%;margin:0}';doc.head.append(style)}}catch(e){}};
    iframe.addEventListener('load',()=>{hideChrome();resize();try{new ResizeObserver(resize).observe(iframe.contentDocument.documentElement)}catch(e){}});
    wrap.querySelector('.race-embed-body').append(iframe)}return wrap}if(state.form.commitOpen===undefined){state.form.commitOpen=!!myEntry(race);state.form.editingName=myEntry(race)?.name||''}const entries=race.entries.filter(e=>e.level!=='not');const eventGroups={};entries.forEach(e=>{const key=e.events.length?e.events.join(', '):'Event TBC';(eventGroups[key]||=[]).push(e)});const eventKeys=Object.keys(eventGroups).sort((a,b)=>a.localeCompare(b));eventKeys.forEach(k=>eventGroups[k].sort((a,b)=>a.name.localeCompare(b.name)));const orderedEntries=eventKeys.flatMap(k=>eventGroups[k]);const levelLabel=Object.fromEntries(levels);const rosterBody=orderedEntries.length?eventKeys.map(key=>`<div class="roster-group"><p class="roster-group-label">${key}</p>${eventGroups[key].map(e=>`<div class="roster-entry"><div class="roster-who"><span class="roster-name">${e.name}</span><span class="roster-level level-${e.level}">${levelLabel[e.level]||e.level}</span></div><button type="button" class="roster-edit" aria-label="Edit ${e.name}'s commitment for this race">Edit</button></div>`).join('')}</div>`).join(''):'<p class="helper-text">No commitments yet — be the first.</p>';const editingEntry=state.form.editingName?race.entries.find(e=>e.name===state.form.editingName):null;wrap.innerHTML=`${race.url?'<div class="card-header">Race website</div><div class="card-body race-website-body"></div>':''}<div class="card-header">Club commitments</div><div class="card-body roster-body">${rosterBody}</div><div class="card-header">Your commitment</div><div class="card-body"><button type="button" class="commit-toggle-button ${state.form.commitOpen?'hidden':''}">Add your commitment</button><div class="commitment-fields ${state.form.commitOpen?'':'hidden'}"><p class="choice-label">Your name</p><div class="name-row"><input class="name-input" placeholder="Your name"></div><p class="choice-label">Commitment level</p><div class="level-choices choices"></div><p class="choice-label">Participation type <span class="optional">select all that apply</span></p><div class="event-choices choices"></div><div class="other-row hidden"><input class="other-input" placeholder="Type your event or distance"></div><div class="save-row"><button type="button" class="save-button">Save commitment</button>${editingEntry?'<button type="button" class="remove-commit-button">Remove commitment</button>':''}</div></div></div>`;const commitToggle=wrap.querySelector('.commit-toggle-button'),commitFields=wrap.querySelector('.commitment-fields');commitToggle.onclick=()=>{if(!requireSignIn('Sign in to add your commitment'))return;state.form.commitOpen=true;persist();commitToggle.classList.add('hidden');commitFields.classList.remove('hidden');nameInput.focus()};if(race.url){const a=document.createElement('a');a.className='race-link';a.href=race.url;a.textContent=race.url;a.title=race.url;a.target='_blank';a.rel='noopener';a.setAttribute('aria-label',`${race.name} website: ${race.url}`);wrap.querySelector('.race-website-body').append(a)}wrap.querySelectorAll('.roster-edit').forEach((btn,i)=>{btn.onclick=()=>{if(!requireSignIn('Sign in to edit this entry'))return;const entry=orderedEntries[i];const opts=participationOptions();const known=[],extra=[];entry.events.forEach(ev=>{const k=ev.trim().toLowerCase();const hit=opts.find(o=>o.toLowerCase()===k)||(k==='to'?'TO (Technical official)':k==='team'?'Team':null);if(hit)known.includes(hit)||known.push(hit);else extra.push(ev)});state.form={events:known,otherText:extra.join(', '),otherOpen:!!extra.length,level:entry.level,commitOpen:true,editingName:entry.name};persist();render();const fields=$('.commitment-fields');if(fields){fields.querySelector('.name-input').focus({preventScroll:true});fields.scrollIntoView({behavior:'smooth',block:'center'})}}});const removeCommitButton=wrap.querySelector('.remove-commit-button');if(removeCommitButton)removeCommitButton.onclick=async()=>{if(!requireSignIn('Sign in to remove this entry'))return;if(!confirm(`Remove ${editingEntry.name} from this race?`))return;removeCommitButton.disabled=true;removeCommitButton.textContent='Removing…';try{await removeEntry(race.id,editingEntry.name);state.form={events:[],otherText:'',otherOpen:false,level:'considering',commitOpen:false,editingName:''};persist();await loadRaces()}catch(err){removeCommitButton.disabled=false;removeCommitButton.textContent='Remove commitment';alert('Could not remove: '+err.message)}};const nameInput=wrap.querySelector('.name-input');nameInput.value=state.form.editingName||'';const eventChoices=wrap.querySelector('.event-choices');const otherRow=wrap.querySelector('.other-row');const otherInput=wrap.querySelector('.other-input');otherInput.value=state.form.otherText||'';otherInput.oninput=()=>{state.form.otherText=otherInput.value;persist()};
function participationOptions(){const merged=[...race.events];const ensure=(label,aliases)=>{const idx=merged.findIndex(e=>aliases.includes(e.trim().toLowerCase()));if(idx>=0)merged[idx]=label;else merged.push(label)};ensure('TO (Technical official)',['to','to (technical official)']);ensure('Team',['team']);return merged}
function update(){eventChoices.innerHTML='';participationOptions().forEach(event=>{const b=document.createElement('button');b.type='button';const active=state.form.events.includes(event);b.className='choice '+(active?'selected':'');b.setAttribute('aria-pressed',String(active));b.textContent=event;b.onclick=()=>{state.form.events=active?state.form.events.filter(x=>x!==event):[...state.form.events,event];persist();update()};eventChoices.append(b)});const otherBtn=document.createElement('button');otherBtn.type='button';otherBtn.className='choice '+(state.form.otherOpen?'selected':'');otherBtn.setAttribute('aria-pressed',String(!!state.form.otherOpen));otherBtn.textContent='Other';otherBtn.onclick=()=>{state.form.otherOpen=!state.form.otherOpen;persist();update();if(state.form.otherOpen)otherInput.focus()};eventChoices.append(otherBtn);otherRow.classList.toggle('hidden',!state.form.otherOpen);const lc=wrap.querySelector('.level-choices');lc.innerHTML='';levels.forEach(([key,label])=>{const b=document.createElement('button');b.type='button';b.className=`choice level-${key} ${state.form.level===key?'selected':''}`;b.textContent=label;b.onclick=()=>{state.form.level=key;persist();update()};lc.append(b)});const btn=wrap.querySelector('.save-button');btn.onclick=async()=>{const name=nameInput.value.trim();if(!name){nameInput.focus();return}
    // Snapshot the typed name before the gate, so a signed-out save attempt
    // doesn't lose it if the magic-link round trip reloads the page.
    const previousEditingName=state.form.editingName;if(name!==previousEditingName){state.form.editingName=name;persist()}
    if(!requireSignIn('Sign in to save your commitment'))return;
    const extra=(state.form.otherText||'').trim();const events=[...new Set([...state.form.events,...(extra?[extra]:[])])];if(!events.length){(state.form.otherOpen?otherInput:eventChoices).focus?.();return}btn.disabled=true;btn.textContent='Saving…';try{for(const ev of events){if(!race.events.includes(ev))await addEvent(race.id,ev)}await saveEntry(race.id,name,events,state.form.level);if(previousEditingName&&previousEditingName!==name)await removeEntry(race.id,previousEditingName);state.form.editingName=name;state.user=name;persist();await loadRaces()}catch(err){btn.disabled=false;btn.textContent='Save commitment';alert('Could not save: '+err.message)}}}update();return wrap}
function toggleAdd(open){const panel=$('#addPanel');panel.classList.toggle('hidden',!open);if(open)panel.querySelector('input').focus()}
document.querySelectorAll('.view-toggle-btn').forEach(b=>b.onclick=()=>{state.viewFilter=b.dataset.view;persist();render()});
document.querySelectorAll('#raceForm,#editForm').forEach(f=>{f.eventType.onchange=()=>applyEventTypeFields(f);applyEventTypeFields(f)});
$('#athleteFilter').oninput=e=>{state.filter=e.target.value;persist();render()};$('#eventTypeFilter').onchange=e=>{state.eventTypeFilter=e.target.value;persist();render()};$('#heroAddButton').onclick=()=>{if(editingId)closeEditScreen();toggleAdd(true);$('#addPanel').scrollIntoView({behavior:'smooth',block:'start'})};$('#closeAddButton').onclick=()=>toggleAdd(false);$('#cancelAddButton').onclick=()=>toggleAdd(false);$('#raceForm').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target);const submitBtn=e.target.querySelector('.primary-button');submitBtn.disabled=true;let url=f.get('url').trim();if(url&&!/^https?:\/\//i.test(url))url='https://'+url;try{await addRace({name:f.get('name').trim(),date:f.get('date'),location:'Location TBC',url,events:f.get('events').split(',').map(x=>x.trim()).filter(Boolean),eventType:f.get('eventType'),clubFocus:f.get('clubFocus')?'Y':'N'});e.target.reset();applyEventTypeFields(e.target);toggleAdd(false);await loadRaces()}catch(err){alert('Could not add race: '+err.message)}finally{submitBtn.disabled=false}});
$('#editCancelButton').onclick=closeEditScreen;$('#editBackButton').onclick=closeEditScreen;$('#raceScreenBackButton').onclick=()=>closeRaceScreen();
// Back/forward between the list and a race. Ignored until the first load has
// resolved, because findRaceBySlug has nothing to match against before then.
window.addEventListener('popstate',()=>{if(bootstrapped)routeFromUrl()});
$('#removeRaceButton').onclick=async()=>{const raceId=editingId;if(!raceId)return;const race=races.find(r=>r.id===raceId);if(!confirm(`Remove ${race?.name||'this race'} from the calendar? This can't be undone.`))return;const btn=$('#removeRaceButton');btn.disabled=true;btn.textContent='Removing…';try{await deleteRace(raceId);const wasOpen=openId===raceId;editingId=null;openId=null;if(wasOpen)navigate(BASE_PATH,{replace:true});$('#editScreen').classList.add('hidden');$('#raceScreen').classList.add('hidden');$('#top').classList.remove('hidden');document.querySelector('.toolbar').classList.remove('hidden');$('#raceList').classList.remove('hidden');await loadRaces();showToast(`${race?.name||'Race'} removed`)}catch(err){alert('Could not remove race: '+err.message)}finally{btn.disabled=false;btn.textContent='Remove race'}};$('#editForm').addEventListener('submit',async e=>{e.preventDefault();const raceId=editingId;if(!raceId)return;const f=new FormData(e.target);const submitBtn=e.target.querySelector('.primary-button');submitBtn.disabled=true;let url=f.get('url').trim();if(url&&!/^https?:\/\//i.test(url))url='https://'+url;const name=f.get('name').trim();try{await updateRace(raceId,{name,date:f.get('date'),url,events:f.get('events').split(',').map(x=>x.trim()).filter(Boolean),eventType:f.get('eventType'),clubFocus:f.get('clubFocus')?'Y':'N'});closeEditScreen();await loadRaces();showToast(`${name} updated`)}catch(err){alert('Could not save changes: '+err.message)}finally{submitBtn.disabled=false}});
$('#resetButton').onclick=()=>{loadRaces()};loadRaces();
$('#authSheetBackdrop').addEventListener('click',e=>{if(e.target===e.currentTarget)closeAuthSheet()});
$('#authSheetClose').onclick=closeAuthSheet;
window.addEventListener('scroll',()=>{if(!$('#authSheetBackdrop').classList.contains('hidden'))closeAuthSheet()},{passive:true});
initAuth();
