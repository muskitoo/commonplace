import { initializeApp } from "firebase/app";
import { initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, signOut } from "firebase/auth";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, onSnapshot, setDoc, deleteDoc, writeBatch } from "firebase/firestore";

const APP_VERSION = "1.1.0";
(function(){
"use strict";
const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const clone = o => JSON.parse(JSON.stringify(o));
const uniq = a => [...new Set(a)];

const KINDS = {quote:"Quote", thought:"Thought", takeaway:"Takeaway"};
const SRC = {book:"Book", podcast:"Podcast", article:"Article", video:"Video", conversation:"Conversation", mind:"My own head", other:"Other"};
const SRC_LABELS = {
  book:{title:"Book title", author:"Author", loc:"Page or chapter"},
  podcast:{title:"Podcast or episode", author:"Host or guest", loc:"Timestamp"},
  article:{title:"Article title", author:"Writer or publication", loc:"Section"},
  video:{title:"Video title", author:"Channel or speaker", loc:"Timestamp"},
  conversation:{title:"Who with", author:"Context", loc:"When"},
  mind:{title:"Prompted by (optional)", author:"Where you were", loc:"When"},
  other:{title:"Title", author:"Author", loc:"Location"}
};
const TEXT_LABELS = {quote:"The quote", thought:"Your thought", takeaway:"The takeaway"};

const state = {
  notes:new Map(), folders:new Map(), folderId:null, capFolders:new Set(), downloads:null,
  meta:{reflectedDates:[], todayPick:null},
  ready:false, mode:"loading", warn:"", readOnly:false, sync:"", user:null,
  view:"reflect", noteId:null, editingId:null, linkTo:null,
  sessionPick:null,
  filters:{q:"", kind:"all", source:"", tag:"", folder:"", sort:"new"},
  timer:{total:300, left:300, running:false, last:0, h:null},
  ai:{sample:null, qFor:null, questions:null, loading:false, err:"", sugg:null}
};

/* ---------- dates & ids ---------- */
const dkey = d => { const x = new Date(d); return x.getFullYear()+"-"+String(x.getMonth()+1).padStart(2,"0")+"-"+String(x.getDate()).padStart(2,"0"); };
const todayKey = () => dkey(Date.now());
const fmtDate = t => new Date(t).toLocaleDateString("en-GB",{day:"numeric", month:"short", year:"numeric"});
const fmtShort = t => { const d=new Date(t), now=new Date(); return d.toLocaleDateString("en-GB", d.getFullYear()===now.getFullYear()? {day:"numeric",month:"short"} : {day:"numeric",month:"short",year:"numeric"}); };
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2,8);
const numStr = n => "No. " + String(n.num || 0).padStart(4,"0");
function nextNum(){ let m=0; state.notes.forEach(n => { if((n.num||0)>m) m=n.num; }); return m+1; }

/* ---------- storage ---------- */
const chains = {};
function queue(key, fn){ const p = (chains[key] || Promise.resolve()).then(fn, fn); chains[key] = p.catch(()=>{}); return p; }
function lsGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
function lsSet(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }
function normMeta(m){ return {reflectedDates: Array.isArray(m?.reflectedDates)? m.reflectedDates.filter(x=>typeof x==="string") : [], todayPick: m?.todayPick && typeof m.todayPick.id==="string" ? {date:String(m.todayPick.date), id:m.todayPick.id} : null}; }
function normNote(v, id){
  return {
    id, num: Number(v.num)||0, kind: KINDS[v.kind]? v.kind : "thought",
    text: String(v.text||""), take: String(v.take||""),
    source: {type: SRC[v.source?.type]? v.source.type : "other", title:String(v.source?.title||""), author:String(v.source?.author||""), loc:String(v.source?.loc||"")},
    tags: Array.isArray(v.tags)? v.tags.map(String) : [],
    links: Array.isArray(v.links)? v.links.map(String) : [],
    expansions: Array.isArray(v.expansions)? v.expansions.filter(e=>e && e.text).map(e=>({at:Number(e.at)||0, text:String(e.text), via:String(e.via||"manual")})) : [],
    createdAt:Number(v.createdAt)||0, updatedAt:Number(v.updatedAt)||0,
    lastReflectedAt:Number(v.lastReflectedAt)||0, reflectCount:Number(v.reflectCount)||0,
    example: !!v.example, copyOf: Number(v.copyOf)||0
  };
}

const FOLDER_COLORS = {tan:"#D5B893", rose:"#E2B3BC", leaf:"#CFCB8F", sky:"#BCC4D8", lavender:"#D3CADB", peony:"#F7DDD5"};
const FOLDER_LABELS = {tan:"Tan", rose:"Dusty rose", leaf:"Leaf", sky:"Sky", lavender:"Lavender", peony:"Peony"};
function normFolder(v, id){
  return {id, name:String(v.name||"Untitled folder"), thesis:String(v.thesis||""), color: FOLDER_COLORS[v.color] ? v.color : "tan",
    noteIds: Array.isArray(v.noteIds) ? uniq(v.noteIds.map(String)) : [], createdAt:Number(v.createdAt)||0, updatedAt:Number(v.updatedAt)||0};
}
const Store = {
  db:null, auth:null, uid:null, unsubs:[],
  init(){
    const cfg = window.FIREBASE_CONFIG;
    if(!cfg || !cfg.apiKey || /PASTE/i.test(cfg.apiKey)){ showGate("setup"); return; }
    try{
      const app = initializeApp(cfg);
      this.auth = initializeAuth(app, {persistence:[indexedDBLocalPersistence, browserLocalPersistence]});
      try{ this.db = initializeFirestore(app, {localCache: persistentLocalCache({tabManager: persistentMultipleTabManager()})}); }
      catch(e){ this.db = initializeFirestore(app, {}); }
    }catch(e){ showGate("setup", "Your Firebase settings couldn’t be read: " + (e && e.message || e)); return; }
    onAuthStateChanged(this.auth, user => { if(user) this.start(user); else { this.stop(); showGate("auth"); render(); } });
  },
  start(user){
    if(this.uid === user.uid) return;
    this.stop();
    this.uid = user.uid;
    state.user = {uid:user.uid, email:user.email || ""};
    state.mode = "db";
    if(Lock.enabled()) Lock.lock();
    hideGate();
    const db = this.db, uid = user.uid;
    this.unsubs.push(onSnapshot(collection(db, "users", uid, "notes"), {includeMetadataChanges:true}, snap => {
      const m = new Map();
      snap.docs.forEach(d => { const v = d.data(); if(v) m.set(d.id, normNote(v, d.id)); });
      state.notes = m; state.ready = true; state.warn = "";
      state.sync = snap.metadata.hasPendingWrites ? "saving" : (snap.metadata.fromCache ? "offline" : "synced");
      render();
    }, err => { state.warn = "Your cards couldn’t be loaded (" + (err && err.code || "error") + "). Check the Firestore rules in the README, then reload."; state.ready = true; render(); }));
    this.unsubs.push(onSnapshot(collection(db, "users", uid, "folders"), snap => {
      const m = new Map();
      snap.docs.forEach(d => { const v = d.data(); if(v) m.set(d.id, normFolder(v, d.id)); });
      state.folders = m; render();
    }, () => {}));
    this.unsubs.push(onSnapshot(doc(db, "users", uid, "meta", "state"), s => { if(s.exists()) state.meta = normMeta(s.data()); render(); }, () => {}));
    render();
  },
  stop(){
    this.unsubs.forEach(u => { try{ u(); }catch(e){} });
    this.unsubs = []; this.uid = null;
    state.notes = new Map(); state.folders = new Map(); state.meta = normMeta({}); state.ready = false; state.user = null; state.sync = "";
  },
  ref(kind, id){ return doc(this.db, "users", this.uid, kind, id); },
  // Firestore applies writes to the local cache at once and syncs in the background,
  // so the app never waits on the network (writes made offline upload later).
  fire(p){ p.catch(onWriteErr); return Promise.resolve(); },
  saveNote(n){
    n.updatedAt = Date.now(); state.notes.set(n.id, n); render();
    if(!this.uid) return Promise.resolve();
    const body = clone(n); delete body.id;
    return this.fire(setDoc(this.ref("notes", n.id), body));
  },
  deleteNote(id){ state.notes.delete(id); render(); if(!this.uid) return Promise.resolve(); return this.fire(deleteDoc(this.ref("notes", id))); },
  saveFolder(f){
    f.updatedAt = Date.now(); state.folders.set(f.id, f); render();
    if(!this.uid) return Promise.resolve();
    const body = clone(f); delete body.id;
    return this.fire(setDoc(this.ref("folders", f.id), body));
  },
  deleteFolder(id){ state.folders.delete(id); render(); if(!this.uid) return Promise.resolve(); return this.fire(deleteDoc(this.ref("folders", id))); },
  saveMeta(){ if(!this.uid) return Promise.resolve(); return this.fire(setDoc(this.ref("meta", "state"), clone(state.meta))); },
  importAll(notes, folders){
    // keep card numbers unique: an imported card whose number is already used by a different card gets the next free number
    const used = new Map(); state.notes.forEach(n => used.set(n.num, n.id));
    let next = Math.max(0, ...used.keys()) + 1;
    notes.sort((a,b) => a.num - b.num).forEach(n => {
      const owner = used.get(n.num);
      if(!n.num || (owner && owner !== n.id)){ n.num = next++; }
      used.set(n.num, n.id); if(n.num >= next) next = n.num + 1;
    });
    const ops = [];
    notes.forEach(n => { const b = clone(n); delete b.id; ops.push(["notes", n.id, b]); state.notes.set(n.id, n); });
    folders.forEach(f => { const b = clone(f); delete b.id; ops.push(["folders", f.id, b]); state.folders.set(f.id, f); });
    for(let i = 0; i < ops.length; i += 400){
      const batch = writeBatch(this.db);
      ops.slice(i, i+400).forEach(([k, id, b]) => batch.set(this.ref(k, id), b));
      batch.commit().catch(onWriteErr);
    }
    render();
  }
};
function onWriteErr(e){
  const code = (e && e.code) || "";
  if(code === "permission-denied") toast("Couldn’t save: the database refused it. Check the Firestore rules in the README.");
  else if(code === "resource-exhausted") toast("You’ve hit today’s free Firebase limit. Changes will save tomorrow.");
  else toast("Couldn’t save that change (" + (code || "error") + ").");
}

/* ---------- helpers ---------- */
const get = id => state.notes.get(id);
const foldersOf = nid => [...state.folders.values()].filter(f => f.noteIds.includes(nid)).sort((a,b) => a.name.localeCompare(b.name));
const fcol = f => FOLDER_COLORS[f.color] || FOLDER_COLORS.tan;
function folderChip(f, attrs){ return `<button type="button" class="chip" ${attrs} style="--fcx:${fcol(f)}"><span class="sw-dot"></span>${esc(f.name)}</button>`; }
function folderLine(n){ const fs = foldersOf(n.id); if(!fs.length) return ""; return `<div class="row" style="gap:6px">${fs.map(f => folderChip(f, `data-gofolder="${esc(f.id)}"`)).join("")}</div>`; }
async function addToFolder(fid, nid){ const f = state.folders.get(fid); if(!f || f.noteIds.includes(nid)) return; const c = clone(f); c.noteIds = [...c.noteIds, nid]; await Store.saveFolder(c); }
async function removeFromFolder(fid, nid){ const f = state.folders.get(fid); if(!f) return; const c = clone(f); c.noteIds = c.noteIds.filter(x => x !== nid); await Store.saveFolder(c); }
async function moveInFolder(fid, i, dir){
  const f = state.folders.get(fid); if(!f) return;
  const ids = f.noteIds.filter(id => state.notes.has(id)); const j = i + dir;
  if(j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  const c = clone(f); c.noteIds = ids; await Store.saveFolder(c);
}
function srcLine(n, html){
  const s = n.source || {};
  if(!s.title && !s.author && !s.loc) return s.type === "mind" ? (html? "My own head" : "") : "";
  const parts = [];
  if(s.title) parts.push(html? "<b>"+esc(s.title)+"</b>" : s.title);
  if(s.author) parts.push(html? esc(s.author) : s.author);
  let out = parts.join(", ");
  if(s.loc) out += (out? " · " : "") + (html? esc(s.loc) : s.loc);
  return (html? esc(SRC[s.type]||"Source") : (SRC[s.type]||"Source")) + " · " + out;
}
const srcKey = n => (n.source?.title || "").trim().toLowerCase();
function parseTags(v){ return uniq(String(v||"").split(",").map(t => t.trim().replace(/^#/,"").toLowerCase()).filter(Boolean)); }
function allTags(){ const c = {}; state.notes.forEach(n => (n.tags||[]).forEach(t => c[t]=(c[t]||0)+1)); return Object.entries(c).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])); }
function sources(){
  const m = new Map();
  state.notes.forEach(n => { const k = srcKey(n); if(!k) return; const e = m.get(k) || {key:k, title:n.source.title, author:n.source.author, type:n.source.type, count:0, last:0}; e.count++; if(n.createdAt > e.last){ e.last = n.createdAt; if(n.source.author) e.author = n.source.author; } m.set(k, e); });
  return [...m.values()].sort((a,b) => b.count - a.count || b.last - a.last);
}
function streak(){
  const set = new Set(state.meta.reflectedDates);
  const d = new Date(); if(!set.has(dkey(d))) d.setDate(d.getDate()-1);
  let c = 0; while(set.has(dkey(d))){ c++; d.setDate(d.getDate()-1); }
  return c;
}
function seeded(str){ let h = 1779033703 ^ str.length; for(let i=0;i<str.length;i++){ h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = h<<13 | h>>>19; } let a = h>>>0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a>>>15, 1|a); t = t + Math.imul(t ^ t>>>7, 61|t) ^ t; return ((t ^ t>>>14)>>>0)/4294967296; }; }
function weightedPick(arr, rnd){
  if(!arr.length) return null;
  const now = Date.now();
  const w = arr.map(n => { const ref = n.lastReflectedAt || n.createdAt || now; const days = Math.max(0,(now-ref)/864e5); return (n.lastReflectedAt? 1 : 2.5) * (1 + Math.min(days, 90)); });
  const total = w.reduce((a,b)=>a+b,0); let r = rnd()*total;
  for(let i=0;i<arr.length;i++){ r -= w[i]; if(r <= 0) return arr[i]; }
  return arr[arr.length-1];
}
function currentPick(){
  if(!state.notes.size) return null;
  const t = todayKey(), p = state.meta.todayPick;
  if(p && p.date === t && state.notes.has(p.id)) return get(p.id);
  const sp = state.sessionPick;
  if(sp && sp.date === t && state.notes.has(sp.id)) return get(sp.id);
  const arr = [...state.notes.values()].sort((a,b) => a.id < b.id ? -1 : 1);
  const n = weightedPick(arr, seeded(t));
  state.sessionPick = {date:t, id:n.id};
  return n;
}
function setPick(id){
  const t = todayKey();
  if(state.meta.todayPick && state.meta.todayPick.date === t && state.meta.todayPick.id === id) return;
  state.meta = Object.assign(clone(state.meta), {todayPick:{date:t, id}});
  Store.saveMeta();
}

/* ---------- rendering pieces ---------- */
function cardFace(n, opts={}){
  const tags = (n.tags||[]).length ? `<div class="tags">${n.tags.map(t => `<button type="button" class="tag" data-tag="${esc(t)}">#${esc(t)}</button>`).join("")}</div>` : "";
  const src = srcLine(n, true);
  const exps = (n.expansions||[]);
  const marg = opts.marg && exps.length ? `<div class="marg"><p class="label">Added since</p>${exps.map(e => `<div class="marg-item"><span class="when">${esc(fmtShort(e.at))}${e.via==="reflect"?" · reflect":""}</span><span class="what">${esc(e.text)}</span></div>`).join("")}</div>` : "";
  return `<div class="card-head"><span class="mono"><span class="kdot"></span><span class="no">${numStr(n)}</span> · ${esc(KINDS[n.kind])}${n.example?" · example":""}${n.copyOf?" · copy of No. "+String(n.copyOf).padStart(4,"0"):""}</span><span class="mono">Filed ${esc(fmtDate(n.createdAt))}</span></div>
    <div class="redrule"></div>
    <div class="card-body">
      <p class="n-text ${n.kind==="quote"?"quote":""}">${esc(n.text)}</p>
      ${src ? `<p class="n-src">${src}</p>` : ""}
      ${n.take ? `<div class="n-take"><p class="label" style="margin-bottom:4px">My take</p><p style="white-space:pre-wrap">${esc(n.take)}</p></div>` : ""}
      ${tags}
      ${opts.folders ? folderLine(n) : ""}
      ${marg}
    </div>`;
}
function rowHtml(n, extra="", after=""){
  return `<div class="link-row k-${n.kind}"><div class="body" data-open="${esc(n.id)}" role="link" tabindex="0"><p class="mono"><span class="no">${numStr(n)}</span> · ${esc(KINDS[n.kind])}${srcKey(n)? " · "+esc(n.source.title):""}</p><p ${n.kind==="quote"?'style="font-style:italic"':""}>${esc(n.text)}</p>${extra}</div>${after}</div>`;
}

function render(){
  renderMast();
  if(state.view === "reflect") renderReflect();
  else if(state.view === "capture") renderCapture();
  else if(state.view === "library") renderLibrary();
  else if(state.view === "note") renderNote();
  else if(state.view === "folders") renderFolders();
  else if(state.view === "folder") renderFolder();
}
function renderMast(){
  const n = state.notes.size;
  const syncLabel = {synced:"synced", saving:"saving…", offline:"offline · saved on this device"}[state.sync] || "";
  $("#m-count").innerHTML = !state.ready ? "Opening your cards…" : esc(n === 1 ? "1 card filed" : n + " cards filed") + (syncLabel ? ` <span class="sync ${state.sync==="synced"?"ok":state.sync==="offline"?"off":""}">· ${esc(syncLabel)}</span>` : "");
  const b = $("#banner"); const msgs = [];
  if(state.warn) msgs.push(`<p class="warn">${esc(state.warn)}</p>`);
  if(state.readOnly) msgs.push(`<p class="warn">You can read these cards but not change them.</p>`);
  b.innerHTML = msgs.join(""); b.hidden = !msgs.length;
  $$(".tabs a").forEach(a => a.setAttribute("aria-current", (a.dataset.tab === state.view || (state.view==="note" && a.dataset.tab==="library") || (state.view==="folder" && a.dataset.tab==="folders")) ? "page" : "false"));
}

/* ----- reflect ----- */
function renderReflect(){
  $("#r-date").textContent = new Date().toLocaleDateString("en-GB",{weekday:"long", day:"numeric", month:"long"});
  $("#r-loading").hidden = state.ready;
  const n = state.ready ? currentPick() : null;
  $("#r-empty").hidden = !state.ready || !!n;
  if(!n) $("#r-drawer").hidden = true;
  $("#r-main").hidden = !n;
  const s = streak(), total = state.meta.reflectedDates.length;
  $("#r-stats").innerHTML = state.ready && state.notes.size ? `<span><b>${s}</b> day streak</span><span><b>${total}</b> ${total===1?"day":"days"} reflected</span>` : "";
  if(!n) return;
  if(state.ai.qFor !== n.id){ state.ai.qFor = n.id; state.ai.questions = null; state.ai.err = ""; }
  renderDrawer(n);
  $("#r-card").innerHTML = cardFace(n, {marg:true, folders:true});
  $("#r-card-wrap").className = "card reflect-card k-" + n.kind + (T.running? " timing":"") + (T.left<=0? " timeup":"");
  const doneToday = n.lastReflectedAt && dkey(n.lastReflectedAt) === todayKey();
  $("#r-stamp").innerHTML = doneToday ? `<span class="stamp">Reflected ${esc(new Date().toLocaleDateString("en-GB",{day:"numeric",month:"short"}))}</span>` : "";
  $("#r-ask").hidden = !state.ai.sample;
  $("#r-draw").hidden = state.notes.size < 2;
  $("#r-connect").hidden = state.notes.size < 2;
  renderQuestions();
  updateTimerUI();
}
function renderQuestions(){
  const box = $("#r-questions");
  if(state.ai.loading){ box.innerHTML = `<p class="hint">Claude is reading this card…</p>`; return; }
  if(state.ai.err){ box.innerHTML = `<p class="err">${esc(state.ai.err)}</p>`; return; }
  const qs = state.ai.questions;
  if(!qs || !qs.length){ box.innerHTML = ""; return; }
  box.innerHTML = `<p class="label">Something to chew on · tap one to start writing from it</p>` + qs.map((q,i) => `<button type="button" class="q" data-q="${i}">${esc(q)}</button>`).join("");
}

/* drawer graphic */
let drawerShown = null, dwTimers = [];
function renderDrawer(n){
  const wrap = $("#r-drawer");
  const show = state.notes.size >= 3;
  wrap.hidden = !show;
  if(!show){ drawerShown = null; return; }
  const all = [...state.notes.values()].sort((a,b) => a.num - b.num);
  $("#dw-label").textContent = numStr(all[0]) + " – " + String(all[all.length-1].num).padStart(4,"0");
  if(drawerShown === n.id) return;
  drawerShown = n.id;
  const count = Math.max(7, Math.min(14, all.length));
  const pos = Math.max(0, all.findIndex(x => x.id === n.id));
  let pickIdx = Math.round(pos / Math.max(1, all.length-1) * (count-1));
  pickIdx = Math.min(pickIdx, count - 3);
  const tabs = [6, 36, 66, 20, 52, 80, 30];
  $("#dw-cards").innerHTML = Array.from({length:count}, (_, i) => {
    const k = i === pickIdx ? n.kind : all[Math.floor(i / count * all.length)].kind;
    return `<span class="dw-card d-${k}" style="top:${i*4}px;z-index:${i+1}"><span class="dw-tab" style="left:${tabs[i % tabs.length]}%"></span>${i === pickIdx ? `<span class="dw-num">${numStr(n)}</span>` : ""}</span>`;
  }).join("");
  animateDrawer(pickIdx, count);
}
function animateDrawer(pickIdx, count){
  dwTimers.forEach(clearTimeout); dwTimers = [];
  const els = $$("#dw-cards .dw-card");
  if(!els[pickIdx]) return;
  if(matchMedia("(prefers-reduced-motion: reduce)").matches){ els[pickIdx].classList.add("lift"); return; }
  let t = 380;
  for(let i = count-1; i > pickIdx; i--){ const e = els[i]; dwTimers.push(setTimeout(() => e.classList.add("flipped"), t)); t += 120; }
  t += 160; dwTimers.push(setTimeout(() => els[pickIdx].classList.add("lift"), t));
  t += 750; dwTimers.push(setTimeout(() => els.forEach((e,i) => { if(i !== pickIdx) e.classList.remove("flipped"); }), t));
}

/* timer */
const T = state.timer;
function updateTimerUI(){
  const secs = Math.ceil(T.left);
  $("#r-time").textContent = Math.floor(secs/60) + ":" + String(secs%60).padStart(2,"0");
  $("#r-bar").style.transform = "scaleX(" + (T.left / T.total) + ")";
  $("#r-start").textContent = T.running ? "Pause" : (T.left <= 0 ? "Another 5 minutes" : (T.left < T.total ? "Resume" : "Start 5 minutes"));
  const w = $("#r-card-wrap");
  w.classList.toggle("timing", T.running);
  w.classList.toggle("timeup", T.left <= 0);
}
function tick(){
  const now = Date.now();
  if(T.running){
    T.left = Math.max(0, T.left - (now - T.last)/1000); T.last = now;
    if(T.left <= 0){ T.running = false; clearInterval(T.h); T.h = null; toast("Five minutes. Add what you have to the card."); }
  }
  updateTimerUI();
}
function toggleTimer(){
  const n = currentPick(); if(!n) return;
  if(T.left <= 0) T.left = T.total;
  T.running = !T.running; T.last = Date.now();
  if(T.running){ if(!T.h) T.h = setInterval(tick, 250); setPick(n.id); $("#r-text").focus(); }
  else { clearInterval(T.h); T.h = null; }
  updateTimerUI();
}
function resetTimer(){ T.running = false; clearInterval(T.h); T.h = null; T.left = T.total; updateTimerUI(); }

function saveReflection(requireText){
  if(state.readOnly) return toast("This copy is view-only.");
  const n = currentPick(); if(!n) return;
  const txt = $("#r-text").value.trim();
  if(requireText && !txt){ toast("Write something first, or choose “Just pondered it”."); $("#r-text").focus(); return; }
  const c = clone(n), now = Date.now(), t = todayKey();
  if(txt) c.expansions = [...c.expansions, {at:now, text:txt, via:"reflect"}];
  c.lastReflectedAt = now; c.reflectCount = (c.reflectCount||0) + 1;
  const m = clone(state.meta);
  m.todayPick = {date:t, id:c.id};
  if(!m.reflectedDates.includes(t)) m.reflectedDates = [...m.reflectedDates, t].slice(-1000);
  state.meta = m;
  $("#r-text").value = ""; autosize($("#r-text")); lsSet("cp.draft.r", "");
  resetTimer();
  Store.saveNote(c).then(() => Store.saveMeta());
  toast(txt ? "Added to " + numStr(c) + "." : "Marked " + numStr(c) + " as pondered.");
}
function drawAnother(){
  const cur = currentPick(); if(!cur) return;
  const others = [...state.notes.values()].filter(n => n.id !== cur.id);
  if(!others.length) return;
  const n = weightedPick(others, Math.random);
  state.sessionPick = {date:todayKey(), id:n.id};
  setPick(n.id);
  resetTimer(); render();
}
async function askQuestions(){
  const n = currentPick(), s = state.ai.sample; if(!n || !s || state.ai.loading) return;
  state.ai.loading = true; state.ai.err = ""; renderQuestions();
  const linked = (n.links||[]).map(get).filter(Boolean).slice(0,5);
  const prompt = `You are a thoughtful reading companion. Someone keeps a commonplace book of quotes, thoughts and takeaways, and is spending five minutes reflecting on one card today.

The card (${KINDS[n.kind]}):
"""${n.text.slice(0,2000)}"""
${srcLine(n) ? "Source: " + srcLine(n) : ""}
${n.take ? "Their first reaction: " + n.take.slice(0,600) : ""}
${n.expansions.length ? "What they have added on earlier days:\n" + n.expansions.slice(-3).map(e => "- " + e.text.slice(0,400)).join("\n") : ""}
${linked.length ? "Cards they have connected it to:\n" + linked.map(l => "- " + l.text.slice(0,240)).join("\n") : ""}

Write exactly 3 short questions, each under 25 words, to help them think further:
1. one that applies the idea to their own life or work right now,
2. one that tests or pushes back on it,
3. one that links it to another idea, field or situation.
Be specific to this card, plain and warm. Do not repeat anything they have already written.
Return JSON only, in this shape: {"questions":["...","...","..."]}`;
  try{
    const v = await s.json(prompt);
    const qs = Array.isArray(v && v.questions) ? v.questions.filter(q => typeof q === "string" && q.trim()).slice(0,3) : [];
    state.ai.questions = qs;
    if(!qs.length) state.ai.err = "Claude didn’t come back with questions. Try again.";
  }catch(e){
    if(e && e.code === "not_granted"){ state.ai.sample = null; state.ai.err = ""; }
    else state.ai.err = (e && e.code === "rate_limited") ? "Too many requests just now. Try again in a minute." : "Couldn’t get questions right now. Try again.";
  }
  state.ai.loading = false;
  if(state.view === "reflect") renderReflect();
}

/* ----- capture ----- */
function renderCapture(){
  const ed = state.editingId && get(state.editingId);
  $("#c-eyebrow").textContent = ed ? "Editing " + numStr(ed) : "New card";
  $("#c-h").textContent = ed ? "Edit this card" : "File something worth keeping";
  $("#c-submit").textContent = ed ? "Save changes" : "File this card";
  $("#c-cancel").hidden = !ed;
  $("#c-recent-wrap").hidden = !!ed || !state.notes.size;
  const lt = state.linkTo && get(state.linkTo);
  $("#c-linkto").innerHTML = lt && !ed ? `<div class="linkto"><span>This card will be connected to ${numStr(lt)}</span><button class="btn small ghost" type="button" data-act="unlinkto">Don’t connect</button></div>` : "";
  $("#titles").innerHTML = sources().slice(0,60).map(s => `<option value="${esc(s.title)}"></option>`).join("");
  const have = parseTags($("#c-tags").value);
  $("#c-tag-suggest").innerHTML = allTags().filter(([t]) => !have.includes(t)).slice(0,12).map(([t]) => `<button type="button" class="tag" data-addtag="${esc(t)}">+ ${esc(t)}</button>`).join("");
  const recent = [...state.notes.values()].sort((a,b) => b.createdAt - a.createdAt).slice(0,4);
  $("#c-recent").innerHTML = recent.map(n => rowHtml(n)).join("");
  $("#c-folders-field").hidden = !!ed;
  renderCapFolders();
  syncLabels();
}
function syncLabels(){
  const f = $("#c-form");
  const kind = f.kind.value || "quote", src = f.src.value || "book";
  $("#c-text-label").textContent = TEXT_LABELS[kind];
  const L = SRC_LABELS[src] || SRC_LABELS.other;
  $("#c-title-label").textContent = L.title; $("#c-author-label").textContent = L.author; $("#c-loc-label").textContent = L.loc;
}
function setRadio(name, val){ const r = $(`#c-form input[name="${name}"][value="${val}"]`); if(r) r.checked = true; }
function fillForm(n){
  setRadio("kind", n.kind); setRadio("src", n.source.type === "other" ? "book" : n.source.type);
  $("#c-text").value = n.text; $("#c-take").value = n.take;
  $("#c-title").value = n.source.title; $("#c-author").value = n.source.author; $("#c-loc").value = n.source.loc;
  $("#c-tags").value = (n.tags||[]).join(", ");
  $("#c-err").hidden = true;
}
function clearForm(keepSource){
  $("#c-text").value = ""; $("#c-take").value = ""; $("#c-err").hidden = true;
  if(!keepSource){ $("#c-title").value = ""; $("#c-author").value = ""; $("#c-loc").value = ""; $("#c-tags").value = ""; }
  resetParsedHint();
}
function resetParsedHint(){ const h = $("#c-parsed"); h.className = "hint"; h.textContent = "Tip: in Apple Books, select a passage, tap Share, then Copy, and paste it here. The title and author fill in for you."; }
function readForm(){
  const f = $("#c-form");
  return {
    kind: f.kind.value || "quote",
    text: $("#c-text").value.trim(), take: $("#c-take").value.trim(),
    source: {type: f.src.value || "book", title: $("#c-title").value.trim(), author: $("#c-author").value.trim(), loc: $("#c-loc").value.trim()},
    tags: parseTags($("#c-tags").value)
  };
}
async function submitForm(e){
  e.preventDefault();
  if(state.readOnly) return toast("This copy is view-only.");
  const v = readForm();
  if(!v.text){ const er = $("#c-err"); er.textContent = "Add the " + TEXT_LABELS[v.kind].replace(/^(The|Your) /,"").toLowerCase() + " before filing."; er.hidden = false; $("#c-text").focus(); return; }
  if(state.editingId && get(state.editingId)){
    const c = Object.assign(clone(get(state.editingId)), v);
    const id = c.id; state.editingId = null; clearForm(false);
    await Store.saveNote(c);
    toast("Saved " + numStr(c) + ".");
    location.hash = "note-" + id;
    return;
  }
  const now = Date.now();
  const n = Object.assign({id:newId(), num:nextNum(), links:[], expansions:[], createdAt:now, updatedAt:now, lastReflectedAt:0, reflectCount:0, example:false}, v);
  const linkTo = state.linkTo && get(state.linkTo) ? state.linkTo : null;
  state.linkTo = null;
  clearForm(true); lsSet("cp.draft.c", "");
  await Store.saveNote(n);
  if(linkTo) await link(n.id, linkTo);
  const fids = [...state.capFolders].filter(id => state.folders.has(id));
  for(const fid of fids) await addToFolder(fid, n.id);
  const fnames = fids.map(id => state.folders.get(id).name);
  toast("Filed as " + numStr(n) + (fnames.length ? " in " + fnames.join(", ") : "") + (linkTo ? " and connected." : "."));
  if(linkTo) location.hash = "note-" + linkTo; else $("#c-text").focus();
}
function parseAppleBooks(t){
  if(!/Excerpt From/i.test(t)) return null;
  const strip = s => s.trim().replace(/^[“"‘']+/, "").replace(/[”"’']+$/, "").trim();
  let m = t.match(/^([\s\S]*?)\s*Excerpt From:\s*(.+?)\s*[“"](.+?)[”"]\s*(?:Apple Books|iBooks)/i);
  if(m) return {text:strip(m[1]), author:m[2].trim().replace(/\.$/,""), title:m[3].trim().replace(/\.$/,"")};
  m = t.match(/^([\s\S]*?)\s*Excerpt From\s*:?\s*\n+\s*([^\n]+)\s*\n+\s*([^\n]*)/i);
  if(m){ const a = /material may be protected/i.test(m[3]) ? "" : m[3].trim(); return {text:strip(m[1]), title:m[2].trim(), author:a}; }
  return null;
}
function tryParse(){
  const ta = $("#c-text"); const p = parseAppleBooks(ta.value);
  if(!p || !p.text) return;
  ta.value = p.text; setRadio("kind","quote"); setRadio("src","book");
  if(p.title) $("#c-title").value = p.title;
  if(p.author) $("#c-author").value = p.author;
  if(p.title || p.author) $("#c-loc").value = "";
  const h = $("#c-parsed"); h.className = "hint ok"; h.textContent = "Filled in from Apple Books: " + [p.title, p.author].filter(Boolean).join(", ") + ". Add a page number if you want one.";
  syncLabels();
}

/* ----- library ----- */
function filtered(){
  const f = state.filters;
  let arr = [...state.notes.values()];
  if(f.kind !== "all") arr = arr.filter(n => n.kind === f.kind);
  if(f.source) arr = arr.filter(n => srcKey(n) === f.source);
  if(f.tag) arr = arr.filter(n => (n.tags||[]).includes(f.tag));
  if(f.folder){ const fo = state.folders.get(f.folder); const set = new Set(fo ? fo.noteIds : []); arr = arr.filter(n => set.has(n.id)); }
  if(f.q){
    const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
    arr = arr.filter(n => { const hay = [n.text, n.take, n.source.title, n.source.author, n.tags.join(" "), n.expansions.map(e=>e.text).join(" "), numStr(n)].join(" ").toLowerCase(); return words.every(w => hay.includes(w)); });
  }
  const s = {
    new:(a,b) => b.createdAt - a.createdAt,
    old:(a,b) => a.createdAt - b.createdAt,
    stale:(a,b) => (a.lastReflectedAt||a.createdAt) - (b.lastReflectedAt||b.createdAt),
    linked:(a,b) => b.links.length - a.links.length || b.createdAt - a.createdAt,
    grown:(a,b) => b.expansions.length - a.expansions.length || b.createdAt - a.createdAt
  }[f.sort] || ((a,b)=>b.createdAt-a.createdAt);
  return arr.sort(s);
}
function renderLibrary(){
  const f = state.filters;
  const src = sources();
  if(f.source && !src.some(s => s.key === f.source)) f.source = "";
  $("#l-shelf").innerHTML = src.length ? `<button type="button" class="spine" data-src="" aria-pressed="${!f.source}"><span class="t">Every source</span><span class="c">${state.notes.size} cards</span></button>` +
    src.slice(0,30).map(s => `<button type="button" class="spine" data-src="${esc(s.key)}" aria-pressed="${f.source===s.key}" title="${esc(s.title)}"><span class="t">${esc(s.title)}</span><span class="c">${esc(SRC[s.type]||"")} · ${s.count}${s.author? " · "+esc(s.author):""}</span></button>`).join("") : "";
  $("#l-shelf").hidden = !src.length;
  const tags = allTags();
  if(f.tag && !tags.some(([t]) => t === f.tag)) f.tag = "";
  $("#l-tag").innerHTML = `<option value="">All tags</option>` + tags.map(([t,c]) => `<option value="${esc(t)}" ${f.tag===t?"selected":""}>#${esc(t)} (${c})</option>`).join("");
  $("#l-tag").hidden = !tags.length;
  if(f.folder && !state.folders.has(f.folder)) f.folder = "";
  const fl = [...state.folders.values()].sort((a,b) => a.name.localeCompare(b.name));
  $("#l-folder").innerHTML = `<option value="">All folders</option>` + fl.map(x => `<option value="${esc(x.id)}" ${f.folder===x.id?"selected":""}>${esc(x.name)} (${x.noteIds.filter(id=>state.notes.has(id)).length})</option>`).join("");
  $("#l-folder").hidden = !fl.length;
  const arr = filtered();
  $("#l-count").textContent = state.ready ? (arr.length === state.notes.size ? "" : arr.length + " of " + state.notes.size + " cards") : "";
  const grid = $("#l-grid");
  if(!state.ready){ grid.innerHTML = `<p class="loading">Opening the catalogue…</p>`; return; }
  if(!state.notes.size){ grid.innerHTML = `<div class="card empty" style="grid-column:1/-1"><h3>No cards yet</h3><p>Everything you file shows up here, ready to search, filter by source or tag, and connect.</p><div class="row"><a class="btn primary" href="#capture">File your first card</a><button class="btn" type="button" data-act="examples">Add 3 example cards</button></div></div>`; return; }
  if(!arr.length){ grid.innerHTML = `<p class="hint" style="grid-column:1/-1">No cards match. <button class="btn small ghost" type="button" data-act="clearfilters">Clear filters</button></p>`; return; }
  grid.innerHTML = arr.map(n => {
    const meta = [];
    if(n.expansions.length) meta.push(`<span class="hot">+${n.expansions.length} added</span>`);
    if(n.links.length) meta.push(`<span>${n.links.length} connected</span>`);
    const nf = foldersOf(n.id).length; if(nf) meta.push(`<span>in ${nf} ${nf===1?"folder":"folders"}</span>`);
    n.tags.slice(0,3).forEach(t => meta.push(`<span>#${esc(t)}</span>`));
    return `<button type="button" class="lcard k-${n.kind}" data-open="${esc(n.id)}">
      <span class="lc-head mono"><span class="no">${numStr(n)}</span><span>${esc(KINDS[n.kind])}</span></span>
      <span class="lc-text ${n.kind==="quote"?"quote":""}">${esc(n.text)}</span>
      ${srcKey(n) ? `<span class="lc-src">${esc(n.source.title)}${n.source.author? ", "+esc(n.source.author):""}</span>` : ""}
      ${meta.length ? `<span class="lc-meta">${meta.join("")}</span>` : ""}
    </button>`;
  }).join("");
}

/* ----- note ----- */
function renderNote(){
  const n = get(state.noteId);
  const missing = state.ready && !n;
  $("#n-missing").hidden = !missing;
  $("#n-rest").hidden = !n;
  $$("#n-reflect, #n-edit, #n-dup, #n-delete").forEach(b => b.hidden = !n);
  if(!n){ $("#n-card").innerHTML = state.ready ? "" : `<p class="loading">Finding the card…</p>`; return; }
  $("#n-card").innerHTML = `<article class="card k-${n.kind}">${cardFace(n, {marg:true})}</article>`;
  $("#n-tags").innerHTML = n.tags.length ? n.tags.map(t => `<span class="chip">#${esc(t)}<button type="button" class="x" data-rmtag="${esc(t)}" aria-label="Remove tag ${esc(t)}">×</button></span>`).join("") : `<span class="hint">No tags yet.</span>`;
  $("#taglist").innerHTML = allTags().filter(([t]) => !n.tags.includes(t)).map(([t]) => `<option value="${esc(t)}"></option>`).join("");
  const nfs = foldersOf(n.id);
  $("#n-folders").innerHTML = nfs.length ? nfs.map(f => folderChip(f, `data-gofolder="${esc(f.id)}"`)).join("") : `<span class="hint">Not in any folder yet.</span>`;
  const linked = n.links.map(get).filter(Boolean);
  $("#n-links").innerHTML = linked.length ? linked.map(l => rowHtml(l, "", `<button class="btn small ghost" type="button" data-unlink="${esc(l.id)}" aria-label="Disconnect ${numStr(l)}">Disconnect</button>`)).join("")
    : `<p class="hint">No connections yet. Link this card to others that support it, argue with it, or show it in action.</p>`;
  $("#n-suggest-wrap").hidden = !state.ai.sample || state.notes.size < 3;
  const sg = state.ai.sugg;
  const list = $("#n-suggest-list");
  if(!sg || sg.for !== n.id){ list.innerHTML = `<p class="hint">Claude can read through your other cards and point out ones that connect to this.</p>`; }
  else if(sg.loading){ list.innerHTML = `<p class="hint">Reading your cards…</p>`; }
  else if(sg.err){ list.innerHTML = `<p class="err">${esc(sg.err)}</p>`; }
  else {
    const items = sg.items.filter(it => get(it.id) && !n.links.includes(it.id));
    list.innerHTML = items.length ? items.map(it => rowHtml(get(it.id), `<p class="why">${esc(it.why)}</p>`, `<button class="btn small" type="button" data-linkid="${esc(it.id)}">Connect</button>`)).join("")
      : `<p class="hint">Nothing strong enough to suggest right now. As your box fills up, try again.</p>`;
  }
}
async function link(a, b){
  if(a === b) return;
  const A = get(a), B = get(b); if(!A || !B) return;
  const ca = clone(A), cb = clone(B);
  ca.links = uniq([...ca.links, b]); cb.links = uniq([...cb.links, a]);
  await Store.saveNote(ca); await Store.saveNote(cb);
}
async function unlink(a, b){
  const A = get(a), B = get(b);
  if(A){ const c = clone(A); c.links = c.links.filter(x => x !== b); await Store.saveNote(c); }
  if(B){ const c = clone(B); c.links = c.links.filter(x => x !== a); await Store.saveNote(c); }
}
async function deleteNote(id){
  const n = get(id); if(!n) return;
  for(const lid of n.links){ const L = get(lid); if(L){ const c = clone(L); c.links = c.links.filter(x => x !== id); await Store.saveNote(c); } }
  for(const f of foldersOf(id)) await removeFromFolder(f.id, id);
  await Store.deleteNote(id);
  toast("Deleted " + numStr(n) + ".");
}
async function suggestLinks(){
  const n = get(state.noteId), s = state.ai.sample; if(!n || !s) return;
  const others = [...state.notes.values()].filter(o => o.id !== n.id && !n.links.includes(o.id)).sort((a,b)=>b.createdAt-a.createdAt).slice(0,180);
  if(!others.length){ toast("Every other card is already connected."); return; }
  state.ai.sugg = {for:n.id, loading:true, items:[], err:""}; renderNote();
  const prompt = `You help someone find connections between cards in their commonplace book.

MAIN CARD (${KINDS[n.kind]}): """${n.text.slice(0,1500)}"""
${n.take ? "Their take: " + n.take.slice(0,400) : ""}
${n.expansions.length ? "Added later: " + n.expansions.slice(-3).map(e=>e.text.slice(0,300)).join(" / ") : ""}

OTHER CARDS (id | kind | source | text):
${others.map(o => `${o.id} | ${o.kind} | ${(o.source.title||"-").slice(0,60)} | ${o.text.replace(/\s+/g," ").slice(0,220)}${o.tags.length? " #"+o.tags.join(" #"):""}`).join("\n")}

Pick up to 4 other cards that connect meaningfully to the main card: they support it, contradict it, give a concrete example of it, or extend it. Skip weak or merely topical matches; return fewer, or none, if nothing fits well. For each, write one sentence under 20 words telling the reader how they connect.
Return JSON only, in this shape: {"links":[{"id":"<id from the list>","why":"..."}]}`;
  try{
    const v = await s.json(prompt);
    const items = (Array.isArray(v && v.links) ? v.links : []).filter(x => x && typeof x.id === "string" && get(x.id) && x.id !== n.id).slice(0,4).map(x => ({id:x.id, why:String(x.why||"")}));
    state.ai.sugg = {for:n.id, loading:false, items, err:""};
  }catch(e){
    if(e && e.code === "not_granted") state.ai.sample = null;
    state.ai.sugg = {for:n.id, loading:false, items:[], err: (e && e.code === "rate_limited") ? "Too many requests just now. Try again in a minute." : "Couldn’t look for connections right now. Try again."};
  }
  if(state.view === "note") renderNote();
}

/* ---------- modal ---------- */
let modalClose = null;
function openModal(title, bodyHtml, actions, onOpen){
  $("#m-title").textContent = title;
  $("#m-body").innerHTML = bodyHtml;
  const box = $("#m-actions"); box.innerHTML = "";
  actions.forEach(a => { const b = document.createElement("button"); b.type = "button"; b.className = "btn " + (a.cls||""); b.textContent = a.label; b.onclick = () => { if(a.run) a.run(); if(a.close !== false) closeModal(); }; box.appendChild(b); });
  $("#modal").hidden = false;
  const prev = document.activeElement;
  modalClose = () => { $("#modal").hidden = true; if(prev && prev.focus) prev.focus(); };
  if(onOpen) onOpen(); else (box.lastElementChild || box).focus();
}
function closeModal(){ if(modalClose){ const f = modalClose; modalClose = null; f(); } }
function confirmBox(title, text, yesLabel, onYes){
  openModal(title, `<p>${esc(text)}</p>`, [{label:"Cancel", cls:"ghost"}, {label:yesLabel, cls:"accent", run:onYes}]);
}
function openPicker(fromId){
  const from = get(fromId); if(!from) return;
  openModal("Connect " + numStr(from) + " to…", `<input type="search" id="m-q" placeholder="Search your cards" aria-label="Search cards"><div class="pick-list" id="m-list" style="margin-top:12px"></div>`, [{label:"Done", cls:""}], () => {
    const draw = () => {
      const q = ($("#m-q").value || "").toLowerCase().trim();
      const cur = get(fromId); if(!cur) return;
      const arr = [...state.notes.values()].filter(n => n.id !== fromId && !cur.links.includes(n.id))
        .filter(n => !q || [n.text, n.take, n.source.title, n.source.author, n.tags.join(" "), numStr(n)].join(" ").toLowerCase().includes(q))
        .sort((a,b) => b.createdAt - a.createdAt).slice(0,40);
      $("#m-list").innerHTML = arr.length ? arr.map(n => `<button type="button" class="pick k-${n.kind}" data-pick="${esc(n.id)}"><span class="mono"><span style="color:var(--red)">${numStr(n)}</span> · ${esc(KINDS[n.kind])}${srcKey(n)? " · "+esc(n.source.title):""}</span><p ${n.kind==="quote"?'style="font-style:italic"':""}>${esc(n.text)}</p></button>`).join("") : `<p class="hint">No other cards to connect${q? " match that search":""}.</p>`;
    };
    $("#m-q").addEventListener("input", draw);
    $("#m-list").addEventListener("click", async e => {
      const b = e.target.closest("[data-pick]"); if(!b) return;
      await link(fromId, b.dataset.pick);
      toast("Connected " + numStr(get(fromId)) + " and " + numStr(get(b.dataset.pick)) + ".");
      draw();
    });
    draw(); $("#m-q").focus();
  });
}

/* ---------- export ---------- */
function toMarkdown(){
  const arr = [...state.notes.values()].sort((a,b) => a.num - b.num);
  let out = "# Commonplace\nExported " + fmtDate(Date.now()) + " · " + arr.length + " cards\n";
  arr.forEach(n => {
    out += "\n## " + numStr(n) + " · " + KINDS[n.kind] + "\n\n";
    out += (n.kind === "quote" ? n.text.split("\n").map(l => "> " + l).join("\n") : n.text) + "\n";
    const s = srcLine(n); if(s) out += "\n*" + s + "*\n";
    if(n.take) out += "\n**My take:** " + n.take + "\n";
    if(n.expansions.length) out += "\n**Added since:**\n" + n.expansions.map(e => "- " + dkey(e.at) + ": " + e.text.replace(/\n/g, " ")).join("\n") + "\n";
    const l = n.links.map(get).filter(Boolean); if(l.length) out += "\n**Connected to:** " + l.map(numStr).join(", ") + "\n";
    if(n.tags.length) out += "\n" + n.tags.map(t => "#" + t.replace(/\s+/g,"-")).join(" ") + "\n";
  });
  return out;
}
function toJSON(){ const notes = [...state.notes.values()], folders = [...state.folders.values()]; return JSON.stringify({app:"commonplace", version:2, exportedAt:new Date().toISOString(), meta:state.meta, notes, folders}, null, 2); }
async function copyOut(text, what){
  try{ await navigator.clipboard.writeText(text); toast(what + " copied to your clipboard."); }
  catch(e){
    openModal(what, `<p class="hint" style="margin-bottom:8px">Copying was blocked here. Select all of the text below and copy it.</p><textarea id="m-copy" style="min-height:260px;font-family:var(--mono);font-size:12px" readonly></textarea>`, [{label:"Close"}], () => { const t = $("#m-copy"); t.value = text; t.focus(); t.select(); });
  }
}

/* ---------- examples ---------- */
async function addExamples(){
  if(state.readOnly) return toast("This copy is view-only.");
  const now = Date.now(); let num = nextNum();
  const base = {links:[], expansions:[], lastReflectedAt:0, reflectCount:0, example:true, take:"", tags:[]};
  const a = Object.assign({}, base, {id:newId(), num:num++, kind:"quote", createdAt:now-3*864e5, updatedAt:now,
    text:"We suffer more often in imagination than in reality.", take:"Most of what I dread this week hasn’t happened yet.",
    source:{type:"book", title:"Letters from a Stoic", author:"Seneca", loc:"Letter 13"}, tags:["stoicism","worry"]});
  const b = Object.assign({}, base, {id:newId()+"b", num:num++, kind:"thought", createdAt:now-2*864e5, updatedAt:now,
    text:"I finish books and forget them within a month. Maybe the goal isn’t reading more, it’s keeping a few lines and coming back to them.",
    source:{type:"mind", title:"", author:"", loc:""}, tags:["reading","memory"]});
  const c = Object.assign({}, base, {id:newId()+"c", num:num++, kind:"takeaway", createdAt:now-864e5, updatedAt:now,
    text:"Spaced repetition: revisiting an idea just before you’d forget it makes it stick far longer than rereading it many times in one sitting.",
    source:{type:"podcast", title:"Example podcast", author:"", loc:"Ep. 12, 34:10"}, tags:["memory","learning"]});
  b.links = [c.id]; c.links = [b.id];
  await Store.saveNote(a); await Store.saveNote(b); await Store.saveNote(c);
  toast("Added 3 example cards. Delete them any time.");
}

/* ---------- toast ---------- */
let toastT = null;
function toast(msg){ const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3200); }

/* ---------- textarea autosize ---------- */
function autosize(ta){ ta.style.height = "auto"; ta.style.height = Math.max(ta.scrollHeight, 32*5) + "px"; }

/* ---------- routing ---------- */
function route(){
  const h = decodeURIComponent(location.hash.slice(1));
  let view = "reflect", noteId = null, folderId = null;
  if(h.startsWith("note-")){ view = "note"; noteId = h.slice(5); }
  else if(h.startsWith("folder-")){ view = "folder"; folderId = h.slice(7); }
  else if(["reflect","capture","library","folders"].includes(h)) view = h;
  if(state.view === "capture" && view !== "capture" && state.editingId){ state.editingId = null; clearForm(false); }
  if(view !== "capture" && state.linkTo && state.view === "capture"){ state.linkTo = null; }
  if(view === "reflect") drawerShown = null;
  state.view = view; state.noteId = noteId; state.folderId = folderId;
  $$(".view").forEach(v => v.classList.toggle("on", v.id === "view-" + view));
  if(view === "note") $("#n-expand").value = "";
  render();
  window.scrollTo(0,0);
}

/* ---------- events ---------- */
document.addEventListener("click", e => {
  const t = e.target;
  const open = t.closest("[data-open]");
  if(open && !t.closest("[data-unlink],[data-linkid]")){ location.hash = "note-" + open.dataset.open; return; }
  const tag = t.closest("[data-tag]");
  if(tag){ state.filters = Object.assign(state.filters, {tag:tag.dataset.tag, source:"", q:"", kind:"all"}); $("#l-q").value = ""; $("#lk-all").checked = true; location.hash = "library"; if(state.view==="library") render(); return; }
  const add = t.closest("[data-addtag]");
  if(add){ const cur = parseTags($("#c-tags").value); $("#c-tags").value = uniq([...cur, add.dataset.addtag]).join(", "); renderCapture(); return; }
  const src = t.closest("[data-src]");
  if(src){ state.filters.source = src.dataset.src; renderLibrary(); return; }
  const ul = t.closest("[data-unlink]");
  if(ul){ unlink(state.noteId, ul.dataset.unlink); return; }
  const li = t.closest("[data-linkid]");
  if(li){ link(state.noteId, li.dataset.linkid).then(() => toast("Connected.")); return; }
  const q = t.closest("[data-q]");
  if(q){ const qs = state.ai.questions || []; const text = qs[+q.dataset.q]; if(text){ const ta = $("#r-text"); ta.value = (ta.value ? ta.value.replace(/\s*$/,"") + "\n\n" : "") + "› " + text + "\n"; autosize(ta); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } return; }
  const act = t.closest("[data-act]");
  if(act){
    const a = act.dataset.act;
    if(a === "examples") addExamples();
    else if(a === "export-md") copyOut(toMarkdown(), "Markdown");
    else if(a === "export-json") copyOut(toJSON(), "Backup");
    else if(a === "unlinkto"){ state.linkTo = null; renderCapture(); }
    else if(a === "clearfilters"){ state.filters = {q:"", kind:"all", source:"", tag:"", sort:state.filters.sort}; $("#l-q").value = ""; $("#lk-all").checked = true; renderLibrary(); }
  }
});
document.addEventListener("keydown", e => {
  if(e.key === "Escape" && !$("#modal").hidden){ closeModal(); return; }
  if((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches(".link-row .body[data-open]")){ e.preventDefault(); location.hash = "note-" + e.target.dataset.open; }
});
$("#modal").addEventListener("click", e => { if(e.target.id === "modal") closeModal(); });

$("#r-start").addEventListener("click", toggleTimer);
$("#r-save").addEventListener("click", () => saveReflection(true));
$("#r-ponder").addEventListener("click", () => saveReflection(false));
$("#r-draw").addEventListener("click", drawAnother);
$("#r-open").addEventListener("click", () => { const n = currentPick(); if(n) location.hash = "note-" + n.id; });
$("#r-connect").addEventListener("click", () => { const n = currentPick(); if(n){ setPick(n.id); openPicker(n.id); } });
$("#r-ask").addEventListener("click", askQuestions);
$("#r-drawer").addEventListener("click", () => { drawerShown = null; renderReflect(); });
let rDraftT = null;
$("#r-text").addEventListener("input", e => { autosize(e.target); clearTimeout(rDraftT); rDraftT = setTimeout(() => lsSet("cp.draft.r", e.target.value), 500); });

$("#c-form").addEventListener("submit", submitForm);
$("#c-form").addEventListener("change", e => { if(e.target.name === "kind" || e.target.name === "src") syncLabels(); });
let cDraftT = null;
$("#c-text").addEventListener("input", e => { tryParse(); if(!state.editingId){ clearTimeout(cDraftT); cDraftT = setTimeout(() => lsSet("cp.draft.c", $("#c-text").value), 500); } $("#c-err").hidden = true; });
$("#c-title").addEventListener("change", () => {
  const k = $("#c-title").value.trim().toLowerCase(); const s = sources().find(x => x.key === k);
  if(s){ if(!$("#c-author").value.trim()) $("#c-author").value = s.author || ""; setRadio("src", s.type === "other" ? "book" : s.type); syncLabels(); }
});
$("#c-tags").addEventListener("input", () => { clearTimeout(cDraftT); cDraftT = setTimeout(renderCapture, 400); });
$("#c-clear").addEventListener("click", () => { $("#c-title").value = ""; $("#c-author").value = ""; $("#c-loc").value = ""; $("#c-tags").value = ""; renderCapture(); });
$("#c-cancel").addEventListener("click", () => { const id = state.editingId; state.editingId = null; clearForm(false); location.hash = id ? "note-" + id : "library"; });

let qT = null;
$("#l-q").addEventListener("input", e => { clearTimeout(qT); qT = setTimeout(() => { state.filters.q = e.target.value.trim(); renderLibrary(); }, 150); });
$("#l-kinds").addEventListener("change", e => { state.filters.kind = e.target.value; renderLibrary(); });
$("#l-tag").addEventListener("change", e => { state.filters.tag = e.target.value; renderLibrary(); });
$("#l-sort").addEventListener("change", e => { state.filters.sort = e.target.value; renderLibrary(); });

$("#n-edit").addEventListener("click", () => { const n = get(state.noteId); if(!n) return; state.editingId = n.id; state.linkTo = null; fillForm(n); location.hash = "capture"; });
$("#n-delete").addEventListener("click", () => { const n = get(state.noteId); if(!n) return; confirmBox("Delete " + numStr(n) + "?", "The card, everything added to it, and its connections will be removed. This can’t be undone.", "Delete card", () => { deleteNote(n.id); location.hash = "library"; }); });
$("#n-reflect").addEventListener("click", () => { const n = get(state.noteId); if(!n) return; state.sessionPick = {date:todayKey(), id:n.id}; setPick(n.id); resetTimer(); location.hash = "reflect"; });
$("#n-expand-save").addEventListener("click", () => {
  if(state.readOnly) return toast("This copy is view-only.");
  const n = get(state.noteId); const v = $("#n-expand").value.trim(); if(!n) return;
  if(!v){ $("#n-expand").focus(); return; }
  const c = clone(n); c.expansions = [...c.expansions, {at:Date.now(), text:v, via:"manual"}];
  $("#n-expand").value = ""; Store.saveNote(c); toast("Added to " + numStr(c) + ".");
});
$("#n-link").addEventListener("click", () => openPicker(state.noteId));
$("#n-newlinked").addEventListener("click", () => { state.linkTo = state.noteId; state.editingId = null; clearForm(true); setRadio("kind","thought"); syncLabels(); location.hash = "capture"; });
$("#n-suggest").addEventListener("click", suggestLinks);

/* ---------- folders ---------- */
function renderCapFolders(){
  for(const id of [...state.capFolders]) if(!state.folders.has(id)) state.capFolders.delete(id);
  const arr = [...state.folders.values()].sort((a,b) => a.name.localeCompare(b.name));
  $("#c-folders").innerHTML = arr.map(f => folderChip(f, `data-capfolder="${esc(f.id)}" aria-pressed="${state.capFolders.has(f.id)}"`)).join("") + `<button type="button" class="chip" data-newfolder="cap">+ New folder</button>`;
}
function folderTile(f){
  const cards = f.noteIds.map(get).filter(Boolean);
  const peek = cards.slice(0,3).map(n => `<span class="pk d-${n.kind}"></span>`).join("");
  return `<button type="button" class="ftile" data-folder="${esc(f.id)}" style="--fc:${fcol(f)}"><span class="f-tab"></span><span class="f-peek">${peek}</span><span class="f-body"><span class="f-name">${esc(f.name)}</span>${f.thesis ? `<span class="f-thesis">${esc(f.thesis)}</span>` : ""}<span class="f-count">${cards.length} ${cards.length===1?"card":"cards"}</span></span></button>`;
}
function renderFolders(){
  const g = $("#f-grid");
  if(!state.ready){ g.innerHTML = `<p class="loading">Opening your folders…</p>`; return; }
  const arr = [...state.folders.values()].sort((a,b) => b.updatedAt - a.updatedAt);
  g.innerHTML = arr.length ? arr.map(folderTile).join("") :
    `<div class="card empty" style="grid-column:1/-1"><h3>No folders yet</h3><p>A folder gathers cards around one idea or thesis, like “Attention is the real currency” or “Notes towards an essay on rest”. A card can sit in as many folders as you like.</p><div class="row"><button class="btn primary" type="button" data-newfolder="1">Make your first folder</button></div></div>`;
}
function renderFolder(){
  const f = state.folders.get(state.folderId);
  $("#fd-missing").hidden = !state.ready || !!f;
  $("#fd-main").hidden = !f;
  $("#fd-tools").hidden = !f;
  if(!f){ if(!state.ready) $("#fd-head").innerHTML = ""; return; }
  $("#view-folder").style.setProperty("--fc", fcol(f));
  const cards = f.noteIds.map(get).filter(Boolean);
  $("#fd-head").innerHTML = `<p class="label" style="color:#4a5a73">Folder · ${cards.length} ${cards.length===1?"card":"cards"}</p><h2 style="color:#25344F;margin-top:4px">${esc(f.name)}</h2>` +
    (f.thesis ? `<p class="fd-thesis">${esc(f.thesis)}</p>` : `<p class="fd-thesis" style="opacity:.6;font-size:17px">No thesis yet. Edit the folder to write down the idea these cards build towards.</p>`);
  $("#fd-list").innerHTML = cards.length ? cards.map((n,i) => `<li class="fd-item"><span class="fd-n">${i+1}</span>${rowHtml(n, "", `<span class="fd-ctrl"><button class="btn small ghost" type="button" data-fdmove="${i}" data-dir="-1" ${i===0?"disabled":""} aria-label="Move ${numStr(n)} up">↑</button><button class="btn small ghost" type="button" data-fdmove="${i}" data-dir="1" ${i===cards.length-1?"disabled":""} aria-label="Move ${numStr(n)} down">↓</button><button class="btn small ghost" type="button" data-fdremove="${esc(n.id)}" aria-label="Take ${numStr(n)} out of this folder">✕</button></span>`)}</li>`).join("")
    : `<p class="hint">This folder is empty. Add cards from your library, or write a new one straight into it.</p>`;
}
function openFolderEditor(f, onCreated){
  const color = f ? f.color : Object.keys(FOLDER_COLORS)[state.folders.size % 6];
  const sw = Object.entries(FOLDER_COLORS).map(([k,v]) => `<span class="sw"><input type="radio" name="fecol" id="fe-c-${k}" value="${k}" ${k===color?"checked":""}><label for="fe-c-${k}" style="--c:${v}" title="${FOLDER_LABELS[k]}"><span style="position:absolute;left:-9999px">${FOLDER_LABELS[k]}</span></label></span>`).join("");
  openModal(f ? "Edit folder" : "New folder", `<div class="stack" style="gap:16px">
      <div class="field"><label for="fe-name">Folder name</label><input type="text" id="fe-name" placeholder="e.g. Attention is a choice" autocomplete="off"></div>
      <div class="field"><label for="fe-thesis">Thesis or central idea <span style="text-transform:none;letter-spacing:0">(optional)</span></label><textarea id="fe-thesis" placeholder="What are these cards building towards?"></textarea></div>
      <fieldset class="field"><legend class="fs-legend" style="margin-bottom:8px">Colour</legend><div class="row" style="gap:10px">${sw}</div></fieldset>
      <p class="err" id="fe-err" hidden></p></div>`,
    [{label:"Cancel", cls:"ghost"}, {label: f ? "Save folder" : "Create folder", cls:"accent", close:false, run: async () => {
      if(state.readOnly){ closeModal(); return toast("This copy is view-only."); }
      const name = $("#fe-name").value.trim();
      if(!name){ const e = $("#fe-err"); e.textContent = "Give the folder a name."; e.hidden = false; $("#fe-name").focus(); return; }
      const thesis = $("#fe-thesis").value.trim();
      const col = ($("#m-body input[name=fecol]:checked") || {}).value || "tan";
      closeModal();
      if(f){ const c = Object.assign(clone(state.folders.get(f.id) || f), {name, thesis, color:col}); await Store.saveFolder(c); toast("Folder saved."); }
      else {
        const now = Date.now(); const nf = {id:newId(), name, thesis, color:col, noteIds:[], createdAt:now, updatedAt:now};
        await Store.saveFolder(nf); toast("Created “" + name + "”.");
        if(onCreated) onCreated(nf); else location.hash = "folder-" + nf.id;
      }
    }}],
    () => { $("#fe-name").value = f ? f.name : ""; $("#fe-thesis").value = f ? f.thesis : ""; $("#fe-name").focus(); });
}
function openFolderPicker(nid){
  const n = get(nid); if(!n) return;
  openModal("Add " + numStr(n) + " to folders", `<p class="hint" style="margin-bottom:10px">Tap to add or take out. The card stays in your library either way.</p><div class="pick-list" id="m-flist"></div>`,
    [{label:"New folder", close:false, run:() => { closeModal(); openFolderEditor(null, f => { addToFolder(f.id, nid); toast("Created “" + f.name + "” with " + numStr(n) + " in it."); }); }}, {label:"Done", cls:"primary"}],
    () => {
      const draw = () => {
        const arr = [...state.folders.values()].sort((a,b) => a.name.localeCompare(b.name));
        $("#m-flist").innerHTML = arr.length ? arr.map(f => { const inF = f.noteIds.includes(nid); return `<button type="button" class="pick" data-togfolder="${esc(f.id)}" aria-pressed="${inF}" style="border-left:6px solid ${fcol(f)}"><span class="mono" style="${inF?"color:var(--ink)":""}">${inF ? "✓ In this folder" : "Add to this folder"}</span><p style="font-style:italic">${esc(f.name)}</p></button>`; }).join("") : `<p class="hint">No folders yet. Make one with the button below.</p>`;
      };
      $("#m-flist").addEventListener("click", async e => {
        const b = e.target.closest("[data-togfolder]"); if(!b) return;
        const f = state.folders.get(b.dataset.togfolder); if(!f) return;
        if(f.noteIds.includes(nid)) await removeFromFolder(f.id, nid); else await addToFolder(f.id, nid);
        draw();
      });
      draw();
    });
}
function openFolderCardPicker(fid){
  const f0 = state.folders.get(fid); if(!f0) return;
  openModal("Add cards to “" + f0.name + "”", `<input type="search" id="m-q" placeholder="Search your cards" aria-label="Search cards"><p class="hint" style="margin-top:8px">Tap a card to add it. It stays in your library and any other folders.</p><div class="pick-list" id="m-list" style="margin-top:10px"></div>`, [{label:"Done", cls:"primary"}], () => {
    const draw = () => {
      const f = state.folders.get(fid); if(!f) return;
      const q = ($("#m-q").value || "").toLowerCase().trim();
      const arr = [...state.notes.values()]
        .filter(n => !q || [n.text, n.take, n.source.title, n.source.author, n.tags.join(" "), numStr(n)].join(" ").toLowerCase().includes(q))
        .sort((a,b) => b.createdAt - a.createdAt).slice(0,60);
      $("#m-list").innerHTML = arr.length ? arr.map(n => { const inF = f.noteIds.includes(n.id); return `<button type="button" class="pick k-${n.kind}" data-fpick="${esc(n.id)}" aria-pressed="${inF}"><span class="mono">${inF ? "✓ In folder · " : ""}<span style="color:var(--k)">${numStr(n)}</span> · ${esc(KINDS[n.kind])}${srcKey(n) ? " · " + esc(n.source.title) : ""}</span><p ${n.kind==="quote"?'style="font-style:italic"':""}>${esc(n.text)}</p></button>`; }).join("") : `<p class="hint">No cards match.</p>`;
    };
    $("#m-q").addEventListener("input", draw);
    $("#m-list").addEventListener("click", async e => {
      const b = e.target.closest("[data-fpick]"); if(!b) return;
      const f = state.folders.get(fid); if(!f) return;
      if(f.noteIds.includes(b.dataset.fpick)) await removeFromFolder(fid, b.dataset.fpick); else await addToFolder(fid, b.dataset.fpick);
      draw();
    });
    draw(); $("#m-q").focus();
  });
}
function folderMarkdown(f){
  const cards = f.noteIds.map(get).filter(Boolean);
  let out = "# " + f.name + "\n\n" + (f.thesis ? "> " + f.thesis.split("\n").join("\n> ") + "\n\n" : "") + "*" + cards.length + " cards · compiled " + fmtDate(Date.now()) + "*\n";
  cards.forEach((n,i) => {
    out += "\n## " + (i+1) + ". " + numStr(n) + " · " + KINDS[n.kind] + "\n\n";
    out += (n.kind === "quote" ? n.text.split("\n").map(l => "> " + l).join("\n") : n.text) + "\n";
    const s = srcLine(n); if(s) out += "\n*" + s + "*\n";
    if(n.take) out += "\n**My take:** " + n.take + "\n";
    if(n.expansions.length) out += "\n**Added since:**\n" + n.expansions.map(e => "- " + fmtDate(e.at) + ": " + e.text.replace(/\n/g, " ")).join("\n") + "\n";
    if(n.tags.length) out += "\n" + n.tags.map(t => "#" + t.replace(/\s+/g,"-")).join(" ") + "\n";
  });
  return out;
}

/* ---------- PDF ---------- */
let jsPDFp = null;
function loadJsPDF(){
  if(window.jspdf && window.jspdf.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
  if(!jsPDFp) jsPDFp = new Promise((res, rej) => {
    const sc = document.createElement("script");
    sc.src = "vendor/jspdf.umd.min.js";
    sc.onload = () => window.jspdf ? res(window.jspdf.jsPDF) : rej(new Error("load"));
    sc.onerror = () => { jsPDFp = null; rej(new Error("load")); };
    document.head.appendChild(sc);
  });
  return jsPDFp;
}
const pdfClean = t => String(t || "").replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"').replace(/–/g, "-").replace(/—/g, " - ").replace(/…/g, "...").replace(/[   ]/g, " ").replace(/→/g, "->").replace(/[^\x09\x0A\x0D\x20-\x7E\xA1-\xFF]/g, "");
const hexRgb = h => [1,3,5].map(i => parseInt(h.slice(i, i+2), 16));
async function buildFolderPdf(f){
  const JsPDF = await loadJsPDF();
  const doc = new JsPDF({unit:"pt", format:"a4"});
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
  const M = 66, CW = W - 2*M, BOTTOM = H - 70;
  const INK = [37,52,79], MUTED = [97,120,145], RULE = [201,208,224];
  const KC = {quote:[138,52,64], thought:[101,97,63], takeaway:[74,98,131]};
  const fc = hexRgb(fcol(f));
  let y = M;
  const setF = (font, style, size, color) => { doc.setFont(font, style); doc.setFontSize(size); doc.setTextColor(color[0], color[1], color[2]); };
  const ensure = h => { if(y + h > BOTTOM){ doc.addPage(); y = M; } };
  const para = (text, font, style, size, color, lh, indent = 0) => {
    setF(font, style, size, color);
    pdfClean(text).split("\n").forEach(p => {
      const lines = p.trim() ? doc.splitTextToSize(p, CW - indent) : [""];
      lines.forEach(line => { ensure(lh); doc.text(line, M + indent, y + size*0.8); y += lh; });
    });
  };
  const label = (text, color) => { ensure(28); setF("courier", "normal", 8, color || MUTED); doc.text(text, M, y + 7); y += 14; };
  const cards = f.noteIds.map(get).filter(Boolean);

  // cover
  doc.setFillColor(fc[0], fc[1], fc[2]); doc.rect(0, 0, W, 16, "F");
  setF("courier", "normal", 9, MUTED); doc.text("COMMONPLACE  /  FOLDER", M, M + 24);
  y = M + 76;
  para(f.name, "times", "bold", 30, INK, 36);
  y += 16;
  if(f.thesis){
    const y0 = y;
    para(f.thesis, "times", "italic", 16, INK, 23, 18);
    doc.setDrawColor(fc[0], fc[1], fc[2]); doc.setLineWidth(3.5); doc.line(M + 2, y0 + 2, M + 2, Math.max(y0 + 18, y - 5));
    y += 16;
  }
  setF("courier", "normal", 9, MUTED);
  doc.text((cards.length + " " + (cards.length===1 ? "CARD" : "CARDS") + "  /  COMPILED " + pdfClean(fmtDate(Date.now())).toUpperCase()), M, y + 8);
  y += 40;
  doc.setDrawColor(RULE[0], RULE[1], RULE[2]); doc.setLineWidth(.75); doc.line(M, y, W - M, y); y += 20;
  label("CONTENTS");
  y += 4;
  cards.forEach((n, i) => {
    ensure(18);
    const kc = KC[n.kind] || INK;
    setF("courier", "normal", 8.5, kc); doc.text(String(i+1) + ".  " + numStr(n).toUpperCase(), M, y + 8);
    setF("times", "normal", 11, INK);
    const flat = pdfClean(n.text.replace(/\s+/g, " "));
    const first = doc.splitTextToSize(flat, CW - 112)[0] || "";
    doc.text(first + (flat.length > first.length ? "..." : ""), M + 108, y + 8);
    y += 18;
  });

  // cards, written out in order
  doc.addPage(); y = M;
  cards.forEach((n, i) => {
    ensure(80);
    const kc = KC[n.kind] || INK;
    setF("courier", "normal", 8.5, kc);
    doc.text((i+1) + "  /  " + numStr(n).toUpperCase() + "  /  " + KINDS[n.kind].toUpperCase(), M, y + 7);
    y += 14; doc.setDrawColor(kc[0], kc[1], kc[2]); doc.setLineWidth(1.2); doc.line(M, y, W - M, y); y += 14;
    para(n.kind === "quote" ? "“" + n.text + "”" : n.text, "times", n.kind === "quote" ? "italic" : "normal", 13.5, INK, 20);
    const src = srcLine(n);
    if(src){ y += 4; para(src, "courier", "normal", 8.5, MUTED, 12); }
    if(n.take){ y += 10; label("MY TAKE"); para(n.take, "times", "normal", 11.5, INK, 16.5); }
    if(n.expansions.length){
      y += 10; label("ADDED SINCE");
      n.expansions.forEach(e => {
        ensure(16); setF("courier", "normal", 8, kc); doc.text(pdfClean(fmtDate(e.at)).toUpperCase(), M, y + 8);
        para(e.text, "times", "normal", 11, INK, 15.5, 92); y += 5;
      });
    }
    const linked = n.links.map(get).filter(Boolean);
    const meta = [];
    if(linked.length) meta.push("Connected to " + linked.map(numStr).join(", "));
    if(n.tags.length) meta.push(n.tags.map(t => "#" + t).join("  "));
    if(meta.length){ y += 8; para(meta.join("   /   "), "courier", "normal", 8, MUTED, 12); }
    y += 32;
  });

  const pages = doc.getNumberOfPages();
  for(let pg = 1; pg <= pages; pg++){
    doc.setPage(pg); setF("courier", "normal", 8, MUTED);
    doc.text(pdfClean(f.name).slice(0, 70), M, H - 36);
    doc.text(pg + " / " + pages, W - M, H - 36, {align:"right"});
  }
  return doc.output("blob");
}
async function exportFolderPdf(){
  const f = state.folders.get(state.folderId); if(!f) return;
  if(!f.noteIds.some(id => state.notes.has(id))) return toast("Add some cards to this folder first.");
  const btn = $("#fd-pdf"); btn.disabled = true; btn.textContent = "Building PDF…";
  let blob = null;
  try{ blob = await buildFolderPdf(f); }
  catch(e){ toast("Couldn’t build the PDF. Check your connection and try again."); }
  btn.disabled = false; btn.textContent = "Export as PDF";
  if(!blob) return;
  const name = (pdfClean(f.name).replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "folder") + ".pdf";
  const pages = (await countPdfPages(blob));
  offerFile(blob, name, "Your PDF is ready", "“" + f.name + "”, " + f.noteIds.filter(id => state.notes.has(id)).length + " cards" + (pages ? ", " + pages + (pages===1?" page":" pages") : "") + ". Share it, print it, or save it to Files.");
}
async function duplicateNote(){
  if(state.readOnly) return toast("This copy is view-only.");
  const n = get(state.noteId); if(!n) return;
  const now = Date.now();
  const c = Object.assign(clone(n), {id:newId(), num:nextNum(), links:[], createdAt:now, updatedAt:now, lastReflectedAt:0, reflectCount:0, example:false, copyOf:n.num});
  await Store.saveNote(c);
  toast("Made " + numStr(c) + ", a copy of " + numStr(n) + ".");
  location.hash = "note-" + c.id;
}
function addTagToNote(){
  if(state.readOnly) return toast("This copy is view-only.");
  const n = get(state.noteId); const add = parseTags($("#n-tag-in").value); if(!n || !add.length) return;
  const c = clone(n); c.tags = uniq([...c.tags, ...add]); $("#n-tag-in").value = ""; Store.saveNote(c);
}

document.addEventListener("click", e => {
  const t = e.target;
  const fo = t.closest("[data-folder]"); if(fo){ location.hash = "folder-" + fo.dataset.folder; return; }
  const gf = t.closest("[data-gofolder]"); if(gf){ location.hash = "folder-" + gf.dataset.gofolder; return; }
  const cf = t.closest("[data-capfolder]"); if(cf){ const id = cf.dataset.capfolder; if(state.capFolders.has(id)) state.capFolders.delete(id); else state.capFolders.add(id); renderCapFolders(); return; }
  const nf = t.closest("[data-newfolder]"); if(nf){ const cap = nf.dataset.newfolder === "cap"; openFolderEditor(null, cap ? (f => { state.capFolders.add(f.id); renderCapFolders(); }) : null); return; }
  const mv = t.closest("[data-fdmove]"); if(mv){ moveInFolder(state.folderId, +mv.dataset.fdmove, +mv.dataset.dir); return; }
  const rm = t.closest("[data-fdremove]"); if(rm){ removeFromFolder(state.folderId, rm.dataset.fdremove).then(() => toast("Taken out of this folder. It’s still in your library.")); return; }
  const rt = t.closest("[data-rmtag]"); if(rt){ const n = get(state.noteId); if(n){ const c = clone(n); c.tags = c.tags.filter(x => x !== rt.dataset.rmtag); Store.saveNote(c); } return; }
});
$("#fd-add").addEventListener("click", () => openFolderCardPicker(state.folderId));
$("#fd-new").addEventListener("click", () => { state.capFolders = new Set([state.folderId]); state.linkTo = null; state.editingId = null; clearForm(true); location.hash = "capture"; });
$("#fd-edit").addEventListener("click", () => { const f = state.folders.get(state.folderId); if(f) openFolderEditor(f); });
$("#fd-delete").addEventListener("click", () => { const f = state.folders.get(state.folderId); if(!f) return; confirmBox("Delete “" + f.name + "”?", "Only the folder goes. Every card in it stays in your library and in any other folders.", "Delete folder", () => { Store.deleteFolder(f.id); location.hash = "folders"; }); });
$("#fd-pdf").addEventListener("click", exportFolderPdf);
$("#fd-md").addEventListener("click", () => { const f = state.folders.get(state.folderId); if(f) copyOut(folderMarkdown(f), "Folder"); });
$("#n-dup").addEventListener("click", duplicateNote);
$("#n-folder-add").addEventListener("click", () => openFolderPicker(state.noteId));
$("#n-tag-add").addEventListener("click", addTagToNote);
$("#n-tag-in").addEventListener("keydown", e => { if(e.key === "Enter"){ e.preventDefault(); addTagToNote(); } });
$("#l-folder").addEventListener("change", e => { state.filters.folder = e.target.value; renderLibrary(); });

/* ---------- standalone app: gate, account, files ---------- */
let gateMode = "signin";
function showGate(which, err){
  $("#gate").hidden = false;
  $("#gate-loading").hidden = true;
  $("#gate-auth").hidden = which !== "auth";
  $("#gate-setup").hidden = which !== "setup";
  if(which === "setup" && err){ $("#gate-setup-err").textContent = err; $("#gate-setup-err").hidden = false; }
}
function hideGate(){ $("#gate").hidden = true; }
function setGateMode(m){
  gateMode = m;
  $("#g-submit").textContent = m === "signup" ? "Create account" : "Sign in";
  $("#g-toggle").textContent = m === "signup" ? "Have an account? Sign in" : "New here? Create an account";
  $("#g-pass").setAttribute("autocomplete", m === "signup" ? "new-password" : "current-password");
  $("#gate-sub").textContent = m === "signup" ? "Create your account. Use a password of at least 6 characters; you’ll sign in with it on each device." : "Sign in to your card box. Your cards stay in sync across your iPad, iPhone and Mac, and work offline too.";
  $("#g-err").hidden = true;
}
function authMessage(e){
  const c = (e && e.code) || "";
  return ({
    "auth/invalid-credential":"That email and password don’t match. Try again, or reset your password.",
    "auth/wrong-password":"That email and password don’t match. Try again, or reset your password.",
    "auth/user-not-found":"There’s no account with that email yet. Choose “Create an account”.",
    "auth/invalid-email":"That doesn’t look like an email address.",
    "auth/missing-password":"Enter your password.",
    "auth/weak-password":"Use a password of at least 6 characters.",
    "auth/email-already-in-use":"There’s already an account with that email. Sign in instead.",
    "auth/network-request-failed":"No connection. Connect to the internet to sign in the first time.",
    "auth/too-many-requests":"Too many attempts. Wait a few minutes and try again.",
    "auth/operation-not-allowed":"Email sign-in isn’t switched on in Firebase yet. See step 2 of the README.",
    "auth/admin-restricted-operation":"New accounts are switched off for this app."
  })[c] || ("Couldn’t sign in (" + (c || "error") + ").");
}
$("#gate-form").addEventListener("submit", async e => {
  e.preventDefault();
  const email = $("#g-email").value.trim(), pass = $("#g-pass").value;
  const err = $("#g-err"); err.hidden = true;
  if(!email || !pass){ err.textContent = "Enter your email and password."; err.hidden = false; return; }
  const btn = $("#g-submit"); btn.disabled = true;
  try{
    if(gateMode === "signup") await createUserWithEmailAndPassword(Store.auth, email, pass);
    else await signInWithEmailAndPassword(Store.auth, email, pass);
    $("#g-pass").value = "";
  }catch(ex){ err.textContent = authMessage(ex); err.hidden = false; }
  btn.disabled = false;
});
$("#g-toggle").addEventListener("click", () => setGateMode(gateMode === "signup" ? "signin" : "signup"));
$("#g-forgot").addEventListener("click", async () => {
  const email = $("#g-email").value.trim(); const err = $("#g-err");
  if(!email){ err.textContent = "Type your email above first, then tap “Forgot password”."; err.hidden = false; return; }
  try{ await sendPasswordResetEmail(Store.auth, email); err.textContent = "Check your inbox for a link to reset your password."; err.hidden = false; }
  catch(ex){ err.textContent = authMessage(ex); err.hidden = false; }
});

function download(blob, name){
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function offerFile(blob, name, title, blurb){
  const file = new File([blob], name, {type: blob.type || "application/octet-stream"});
  let canShare = false; try{ canShare = !!(navigator.canShare && navigator.canShare({files:[file]})); }catch(e){}
  openModal(title, `<p>${esc(blurb)}</p>`, [{label:"Close", cls:"ghost"}, {label: canShare ? "Share or save…" : "Download", cls:"accent", run: () => {
    if(canShare) navigator.share({files:[file], title:name}).catch(e => { if(!e || e.name !== "AbortError") download(blob, name); });
    else download(blob, name);
  }}]);
}
async function countPdfPages(blob){ try{ const t = await blob.slice(0, Math.min(blob.size, 4e6)).text(); const m = t.match(/\/Type\s*\/Page[^s]/g); return m ? m.length : 0; }catch(e){ return 0; } }

const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");
function openAccount(){
  const u = state.user || {};
  openModal("Account and backups", `<div class="stack" style="gap:16px">
      <div class="kv"><span class="label">Signed in as</span><span>${esc(u.email || "")}</span></div>
      <div class="stack" style="gap:8px">
        <span class="label">Backups</span>
        <div class="row"><button class="btn small" type="button" id="ac-backup">Save a backup file</button><button class="btn small" type="button" id="ac-import">Import cards</button></div>
        <p class="hint">Import a backup from this app or from the claude.ai version (Library → Copy backup). Importing the same backup twice updates cards rather than doubling them.</p>
      </div>
      <div class="stack" style="gap:8px" id="ac-lock"></div>
      <div class="kv"><span class="label">Your user ID (for locking the database, see README)</span><code>${esc(u.uid || "")}</code></div>
      <p class="hint">Commonplace ${APP_VERSION} · ${plural(state.notes.size,"card")} · ${plural(state.folders.size,"folder")}</p>
    </div>`, [{label:"Sign out", cls:"ghost", run: () => signOut(Store.auth)}, {label:"Done", cls:"primary"}], () => {
      $("#ac-backup").addEventListener("click", () => { const blob = new Blob([toJSON()], {type:"application/json"}); closeModal(); offerFile(blob, "commonplace-backup-" + todayKey() + ".json", "Backup ready", plural(state.notes.size,"card") + " and " + plural(state.folders.size,"folder") + ". Save it to Files or iCloud Drive to keep it safe."); });
      $("#ac-import").addEventListener("click", () => { closeModal(); openImport(); });
      Lock.renderSettings();
    });
}
function parseBackup(text){
  const d = JSON.parse(text);
  const list = x => Array.isArray(x) ? x : Object.entries(x || {}).map(([id, v]) => Object.assign({}, v, {id}));
  const safeId = id => String(id).replace(/[\/\s]/g, "-").slice(0, 120);
  const notes = list(d.notes).filter(n => n && n.id && n.text).map(n => normNote(n, safeId(n.id)));
  const folders = list(d.folders).filter(f => f && f.id).map(f => normFolder(f, safeId(f.id)));
  return {notes, folders, meta: d.meta ? normMeta(d.meta) : null};
}
function openImport(){
  openModal("Import cards", `<div class="stack" style="gap:12px">
      <p>Choose a backup file, or paste a backup you copied from the claude.ai version.</p>
      <input type="file" id="im-file" accept=".json,application/json,text/plain" aria-label="Backup file">
      <label for="im-text" class="label">Or paste it here</label>
      <textarea id="im-text" style="min-height:140px;font-family:var(--mono);font-size:12px" placeholder='{"app":"commonplace", …}'></textarea>
      <p class="err" id="im-err" hidden></p>
    </div>`, [{label:"Cancel", cls:"ghost"}, {label:"Import", cls:"accent", close:false, run: async () => {
      const err = $("#im-err"); err.hidden = true;
      let text = $("#im-text").value.trim();
      const f = $("#im-file").files && $("#im-file").files[0];
      if(f) text = await f.text();
      if(!text){ err.textContent = "Choose a file or paste a backup first."; err.hidden = false; return; }
      let data;
      try{ data = parseBackup(text); }catch(e){ err.textContent = "That isn’t a Commonplace backup I can read."; err.hidden = false; return; }
      if(!data.notes.length && !data.folders.length){ err.textContent = "That backup has no cards in it."; err.hidden = false; return; }
      closeModal();
      Store.importAll(data.notes, data.folders);
      if(data.meta){
        const m = clone(state.meta);
        m.reflectedDates = uniq([...m.reflectedDates, ...data.meta.reflectedDates]).sort().slice(-1000);
        state.meta = m; Store.saveMeta();
      }
      toast("Imported " + plural(data.notes.length,"card") + (data.folders.length ? " and " + plural(data.folders.length,"folder") : "") + ".");
    }}]);
}
$("#acct-btn").addEventListener("click", openAccount);

/* ---------- Face ID / Touch ID lock ----------
   A privacy lock for this device. It uses a passkey (WebAuthn) kept in your iCloud Keychain:
   opening the app asks Face ID or Touch ID before showing your cards. Your Firebase sign-in stays in place underneath. */
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const rand = n => crypto.getRandomValues(new Uint8Array(n));
const Lock = {
  locked:false, hiddenAt:0,
  key(){ return "cp.lock." + (state.user ? state.user.uid : ""); },
  settings(){ try{ return JSON.parse(lsGet(this.key()) || "null"); }catch(e){ return null; } },
  enabled(){ const s = this.settings(); return !!(s && s.on); },
  async available(){
    try{ return !!(window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); }catch(e){ return false; }
  },
  lock(){
    this.locked = true;
    $("#lock-err").hidden = true; $("#lock-pw").hidden = true; $("#lock-pw-toggle").hidden = false;
    $("#lock-email").textContent = (state.user && state.user.email) || "your account";
    $("#lock").hidden = false;
    document.querySelector("main").setAttribute("aria-hidden", "true");
    if(T.running) toggleTimer();
    closeModal();
  },
  unlock(){
    this.locked = false; $("#lock").hidden = true; $("#lock-pass").value = "";
    document.querySelector("main").removeAttribute("aria-hidden");
  },
  async verify(){
    const err = $("#lock-err"); err.hidden = true;
    const btn = $("#lock-go"); btn.disabled = true;
    try{
      const cred = await navigator.credentials.get({publicKey:{
        challenge: rand(32), rpId: location.hostname, userVerification: "required", timeout: 60000,
        allowCredentials: []   // any Commonplace passkey for this account, so one made on another device works too
      }});
      const flags = new Uint8Array(cred.response.authenticatorData)[32];
      const handle = cred.response.userHandle ? new TextDecoder().decode(cred.response.userHandle) : "";
      if(!(flags & 0x04)) throw {name:"NotVerified"};
      if(state.user && handle && handle !== state.user.uid) throw {name:"WrongAccount"};
      this.unlock();
    }catch(e){
      const n = e && e.name;
      err.textContent = n === "NotAllowedError" ? "Didn’t unlock. Tap Unlock to try again, or use your password."
        : n === "WrongAccount" ? "That passkey belongs to a different Commonplace account. Use your password instead."
        : "Face ID or Touch ID isn’t available right now. Use your password instead.";
      err.hidden = false;
    }
    btn.disabled = false;
  },
  async turnOn(){
    if(!(await this.available())){ toast("This device can’t use Face ID or Touch ID here."); return false; }
    try{
      await navigator.credentials.create({publicKey:{
        challenge: rand(32),
        rp: {name:"Commonplace", id: location.hostname},
        user: {id: new TextEncoder().encode(state.user.uid), name: state.user.email || "Commonplace", displayName: "Commonplace"},
        pubKeyCredParams: [{type:"public-key", alg:-7}, {type:"public-key", alg:-257}],
        authenticatorSelection: {authenticatorAttachment:"platform", userVerification:"required", residentKey:"required"},
        timeout: 60000, attestation: "none"
      }});
    }catch(e){
      if(e && e.name === "InvalidStateError"){ /* this device already has the passkey: fine */ }
      else { toast(e && e.name === "NotAllowedError" ? "Lock not turned on." : "Couldn’t set up Face ID or Touch ID here."); return false; }
    }
    const cur = this.settings() || {};
    lsSet(this.key(), JSON.stringify({on:true, after: cur.after ?? 5}));
    toast("Lock turned on for this device.");
    return true;
  },
  turnOff(){ const cur = this.settings() || {}; lsSet(this.key(), JSON.stringify({on:false, after: cur.after ?? 5})); toast("Lock turned off for this device."); },
  setAfter(min){ const cur = this.settings() || {on:false}; cur.after = min; lsSet(this.key(), JSON.stringify(cur)); },
  async renderSettings(){
    const box = $("#ac-lock"); if(!box) return;
    const avail = await this.available();
    const s = this.settings() || {on:false, after:5};
    if(!avail){ box.innerHTML = `<span class="label">Face ID / Touch ID lock</span><p class="hint">This device or browser can’t use Face ID or Touch ID for web apps.</p>`; return; }
    box.innerHTML = `<span class="label">Face ID / Touch ID lock · this device</span>
      <div class="row">
        <button class="btn small ${s.on ? "" : "accent"}" type="button" id="lk-toggle">${s.on ? "Turn lock off" : "Turn lock on"}</button>
        <label class="hint" for="lk-after" style="display:flex;gap:8px;align-items:center">Lock again after
          <select id="lk-after" style="width:auto;font-size:14px;padding:6px 8px">
            ${[[0,"leaving the app"],[5,"5 minutes away"],[30,"30 minutes away"],[240,"4 hours away"]].map(([v,l]) => `<option value="${v}" ${(s.after ?? 5)===v?"selected":""}>${l}</option>`).join("")}
          </select></label>
      </div>
      <p class="hint">${s.on ? "On. Opening Commonplace on this device asks for Face ID or Touch ID." : "When on, opening Commonplace on this device asks for Face ID or Touch ID. Turn it on separately on each device."}</p>`;
    $("#lk-toggle").addEventListener("click", async () => { if(this.enabled()) this.turnOff(); else await this.turnOn(); this.renderSettings(); });
    $("#lk-after").addEventListener("change", e => this.setAfter(+e.target.value));
  }
};
$("#lock-go").addEventListener("click", () => Lock.verify());
$("#lock-pw-toggle").addEventListener("click", () => { $("#lock-pw").hidden = false; $("#lock-pw-toggle").hidden = true; $("#lock-pass").focus(); });
$("#lock-pw").addEventListener("submit", async e => {
  e.preventDefault();
  const err = $("#lock-err"); err.hidden = true;
  const pass = $("#lock-pass").value; if(!pass || !state.user) return;
  $("#lock-pw-go").disabled = true;
  try{ await signInWithEmailAndPassword(Store.auth, state.user.email, pass); Lock.unlock(); }
  catch(ex){ err.textContent = authMessage(ex); err.hidden = false; }
  $("#lock-pw-go").disabled = false;
});
document.addEventListener("visibilitychange", () => {
  if(!state.user || !Lock.enabled()) return;
  if(document.visibilityState === "hidden"){ Lock.hiddenAt = Date.now(); if((Lock.settings().after ?? 5) === 0) Lock.lock(); }
  else if(!Lock.locked && Lock.hiddenAt && Date.now() - Lock.hiddenAt > (Lock.settings().after ?? 5) * 60000) Lock.lock();
});

window.addEventListener("hashchange", route);

/* ---------- boot ---------- */
const dc = lsGet("cp.draft.c"); if(dc) $("#c-text").value = dc;
const dr = lsGet("cp.draft.r"); if(dr){ $("#r-text").value = dr; }
route();
autosize($("#r-text"));
Store.init();
if("serviceWorker" in navigator && location.protocol === "https:"){ navigator.serviceWorker.register("sw.js").catch(() => {}); }
})();
