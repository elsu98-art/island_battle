const http=require('http'),fs=require('fs'),path=require('path'),WebSocket=require('ws');
const words=require('./grade_words.json');const root=path.join(__dirname,'public');const port=process.env.PORT||3000;
const server=http.createServer((req,res)=>{
 const pathname=(req.url||'/').split('?')[0];const route=pathname==='/'?'/index.html':pathname;
 const allowed={'/index.html':'text/html; charset=utf-8','/battle-countdown-ending.wav':'audio/wav','/special-attack-success.wav':'audio/wav','/shield-electric.wav':'audio/wav'};
 if(!Object.hasOwn(allowed,route)){res.writeHead(404);res.end('Not found');return;}
 fs.readFile(path.join(root,route.slice(1)),(err,data)=>{
  if(err){res.writeHead(500);res.end('Server error');return;}
  res.writeHead(200,{'Content-Type':allowed[route],'Cache-Control':'no-store'});res.end(data);
 });
});
const wss=new WebSocket.Server({server,maxPayload:2048});const rooms=new Map();
const send=(ws,d)=>ws?.readyState===WebSocket.OPEN&&ws.send(JSON.stringify(d));const all=(r,d)=>r.players.forEach(p=>p&&send(p.ws,d));
const onlineMetrics=()=>({type:'metrics',online:[...wss.clients].filter(w=>w.readyState===WebSocket.OPEN).length,rooms:rooms.size,active:[...rooms.values()].filter(r=>r.phase==='battle').length,at:Date.now()});
const broadcastMetrics=()=>{const payload=JSON.stringify(onlineMetrics());wss.clients.forEach(w=>{if(w.readyState===WebSocket.OPEN)w.send(payload)});};
setInterval(broadcastMetrics,3000).unref();
const blank=()=>({score:0,correct:0,landmarks:0,energy:0,testSmall:0,testBig:0,shieldCorrect:0,shieldCharges:0,shieldUntil:0,streak:0,superCharges:0,question:'',pronunciation:[],deck:[],idx:0,lastAnswerAt:0,pendingSuper:false,wrong:0,built:0,destroyed:0,lost:0,smallUsed:0,bigUsed:0,superUsed:0,shieldUsed:0,jammedUntil:0});
const shuffle=a=>{a=[...a];for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a};
const WEIGHTS={easy:{2:20},normal:{2:16,3:3,4:1},hard:{3:16,4:3,5:1,6:1}};
function next(r,i){const p=r.states[i];if(p.idx>=p.deck.length){const plan=WEIGHTS[r.lengthMode]||WEIGHTS.easy;const deck=[];for(const [size,count] of Object.entries(plan)){const pool=shuffle(words[String(r.schoolGrade)]?.[size]||[]);for(let j=0;j<count;j++)deck.push(pool[j%pool.length]);}p.deck=shuffle(deck);p.idx=0;}const question=p.deck[p.idx++];p.question=question.text;p.pronunciation=question.zhuyin;}
function packed(r,forIndex){return {type:'state',room:r.name,grade:r.lengthMode,schoolGrade:r.schoolGrade,lengthMode:r.lengthMode,minutes:r.minutes,phase:r.phase,endsAt:r.endsAt,players:r.states.map((s,i)=>({...s,deck:undefined,idx:undefined,question:undefined,lastAnswerAt:undefined,name:r.players[i]?.name||''})),question:r.states[forIndex].question,pronunciation:r.states[forIndex].pronunciation};}
function roster(r,idx){return {type:'room',room:r.name,grade:r.lengthMode,schoolGrade:r.schoolGrade,lengthMode:r.lengthMode,minutes:r.minutes,phase:r.phase,players:r.players.map(p=>p?{name:p.name}:null),you:idx===0?'A':'B'};}
function broadcastRoster(r){r.players.forEach((p,i)=>p&&send(p.ws,roster(r,i)))}
// BV.3-18: per-player cyclic milestones: 8 correct -> Shin, +12 -> sister, +20 -> whale.
const SPECIAL_ORDER=[{kind:'shin',interval:8},{kind:'sister',interval:12},{kind:'whale',interval:20}];
const SPECIALS={shin:{duration:5000,text:'我家門前有小河，後面有山坡～'},sister:{duration:10000,text:'妹妹背著洋娃娃'},whale:{duration:20000,text:'白浪滔滔我不怕～撐穩舵兒往前划！撒網下水到漁家啊～捕條大魚哇哈哈！！'}};
function stopSister(r){if(r.sisterExpire)clearTimeout(r.sisterExpire);r.sisterExpire=null;r.sister=null;}
function checkSisterMilestone(r,i){
 if(r.phase!=='battle'||r.sister)return;
 const p=r.states[i];
 const sequence=r.specialCycles[i];
 const step=SPECIAL_ORDER[sequence.step];
 if(p.correct<sequence.nextAt)return;
 const id=(r.sisterSerial=(r.sisterSerial||0)+1);
 r.sister={id,kind:step.kind,owner:i,hits:0,expires:Date.now()+20000};
 // Advance the current player's milestone even if no one clicks this actor.
 sequence.step=(sequence.step+1)%SPECIAL_ORDER.length;
 sequence.nextAt+=SPECIAL_ORDER[sequence.step].interval;
 all(r,{type:'event',event:{kind:'sisterAppear',id,character:step.kind,owner:i,expires:r.sister.expires}});
 r.sisterExpire=setTimeout(()=>{if(r.sister?.id!==id)return;r.sister=null;r.sisterExpire=null;all(r,{type:'event',event:{kind:'sisterGone',id}});checkPendingSpecials(r);},20000);
}
function checkPendingSpecials(r){
 if(r.phase!=='battle'||r.sister)return;
 for(const i of [0,1]){if(r.states[i].correct>=r.specialCycles[i].nextAt){checkSisterMilestone(r,i);return;}}
}
function startCountdown(r){r.phase='countdown';r.rematchReady=[false,false];const at=Date.now()+5000;broadcastRoster(r);all(r,{type:'countdown',at,room:r.name,grade:r.lengthMode,schoolGrade:r.schoolGrade,lengthMode:r.lengthMode,minutes:r.minutes,phase:r.phase,players:r.players.map(p=>({name:p.name}))});r.startTimeout=setTimeout(()=>{if(r.phase!=='countdown')return;stopSister(r);r.states=[blank(),blank()];r.specialCycles=[0,1].map(()=>({step:0,nextAt:8}));r.states.forEach((_,n)=>next(r,n));r.phase='battle';r.endsAt=Date.now()+r.minutes*60000;broadcastMetrics();r.players.forEach((p,n)=>send(p.ws,{...packed(r,n),type:'battle',you:n?'B':'A'}));r.timer=setInterval(()=>{if(Date.now()>=r.endsAt)finalize(r)},200);},5000);}
function finalize(r){if(r.phase!=='battle')return;r.phase='done';stopSister(r);r.rematchReady=[false,false];if(r.superTimers){r.superTimers.forEach(clearTimeout);r.superTimers=[];}clearInterval(r.timer);broadcastMetrics();all(r,{type:'end',players:r.states.map((s,i)=>({name:r.players[i]?.name||'玩家',score:s.score,correct:s.correct,wrong:s.wrong,built:s.built,landmarks:s.landmarks,destroyed:s.destroyed,lost:s.lost,smallUsed:s.smallUsed,bigUsed:s.bigUsed,superUsed:s.superUsed,shieldUsed:s.shieldUsed}))});}
function publish(r,events=[]){r.players.forEach((p,i)=>p&&send(p.ws,packed(r,i)));events.forEach(event=>all(r,{type:'event',event}));}
function cleanup(ws){const info=ws.current;if(!info)return;ws.current=null;const r=rooms.get(info.room);if(!r)return;stopSister(r);clearTimeout(r.startTimeout);clearInterval(r.timer);if(r.superTimers)r.superTimers.forEach(clearTimeout);rooms.delete(r.name);r.players.forEach(p=>{if(p){p.ws.current=null;send(p.ws,{type:'left'});}});}
function fail(ws,message){send(ws,{type:'error',message})}
function handleMessage(ws,m){const type=m.type;if(type==='ping'){send(ws,{type:'pong',token:m.token,serverTime:Date.now()});return;}if(type==='create'||type==='join'){if(ws.current)return fail(ws,'請先離開目前房間。');const room=String(m.room||'').trim(),name=String(m.name||'').trim();if(room.length<1||room.length>4||name.length<1||name.length>16)return fail(ws,'房間名稱限 1～4 碼，玩家名稱限 1～16 字。');if(type==='create'){if(rooms.has(room))return fail(ws,'這個房間名稱已被使用。');const r={name:room,players:[{ws,name},null],schoolGrade:1,lengthMode:'easy',minutes:5,phase:'waiting',states:[blank(),blank()],endsAt:0,rematchReady:[false,false]};rooms.set(room,r);ws.current={room,index:0};broadcastRoster(r);broadcastMetrics()}else{const r=rooms.get(room);if(!r||r.phase!=='waiting'||r.players[1])return fail(ws,'找不到可加入的等待中房間，或房間已滿。');r.players[1]={ws,name};ws.current={room,index:1};broadcastRoster(r);broadcastMetrics()}return;}
if(type==='leave'){cleanup(ws);send(ws,{type:'left'});broadcastMetrics();return}const info=ws.current;if(!info)return fail(ws,'尚未加入房間。');const r=rooms.get(info.room);if(!r)return fail(ws,'房間不存在。');const i=info.index;
if(type==='settings'){
 if(i!==0||r.phase!=='waiting')return fail(ws,'只有玩家 A 可以調整對戰設定。');
 const schoolGrade=Number(m.schoolGrade), minutes=Number(m.minutes), lengthMode=String(m.lengthMode||'');
 if(!Number.isInteger(schoolGrade)||schoolGrade<1||schoolGrade>6||![3,5,7].includes(minutes)||!['easy','normal','hard'].includes(lengthMode))return fail(ws,'對戰設定不正確。');
 r.schoolGrade=schoolGrade;r.minutes=minutes;r.lengthMode=lengthMode;
 broadcastRoster(r);return;
}
if(type==='start'){if(i!==0||r.phase!=='waiting'||!r.players[1])return fail(ws,'只有主持人能在雙方就位後開始。');startCountdown(r);return;}
if(type==='rematch'){if(r.phase!=='done'||!r.players.every(Boolean))return fail(ws,'尚未進入雙方可再戰的狀態。');r.rematchReady[i]=true;all(r,{type:'rematchStatus',ready:r.rematchReady});if(r.rematchReady.every(Boolean))startCountdown(r);return;}
if(r.phase!=='battle'||Date.now()>=r.endsAt){if(r.phase==='battle')finalize(r);return}
const p=r.states[i];
if(type==='sisterClick'){
 const e=r.sister;
 if(!e||e.owner!==i||e.id!==Number(m.id)||Date.now()>e.expires)return;
 if(++e.hits>=5){
  clearTimeout(r.sisterExpire);r.sisterExpire=null;r.sister=null;
  const victim=1-i;
  const config=SPECIALS[e.kind];r.states[victim].jammedUntil=Date.now()+config.duration;r.states[victim].jammedText=config.text;
  all(r,{type:'event',event:{kind:'sisterTriggered',id:e.id,character:e.kind,owner:i,target:victim,until:r.states[victim].jammedUntil,text:config.text}});checkPendingSpecials(r);
 }else send(ws,{type:'event',event:{kind:'sisterProgress',id:e.id,character:e.kind,hits:e.hits}});
 return;
}
if(type==='cheat'&&String(m.code||'').toLowerCase()==='fast'){
 // Testing shortcut: synchronise both players to exactly 60 seconds remaining.
 r.endsAt=Date.now()+60000;
 publish(r,[{kind:'fast',player:i,endsAt:r.endsAt}]);
 return;
}
if(type==='cheat'&&String(m.code||'').toLowerCase()==='war'){
 const gained=Math.max(0,100-p.landmarks);
 p.landmarks=Math.max(100,p.landmarks);p.score+=gained*100;
 p.testSmall++;p.testBig++;p.superCharges++;p.shieldCharges=p.shieldUntil>Date.now()?0:1;
 publish(r,[{kind:'war',player:i,gained}]);return;
}
if(type==='cheat'&&String(m.code||'').toLowerCase()==='clear'){
 const removed=p.landmarks;p.landmarks=0;p.score=Math.max(0,p.score-removed*100);
 publish(r,[{kind:'clear',player:i,removed}]);return;
}
if(type==='answer'){if(p.jammedUntil>Date.now())return;const a=String(m.answer||'').replace(/\s/g,'').slice(0,120);if(!a)return;if(Date.now()-p.lastAnswerAt<180)return;p.lastAnswerAt=Date.now();if(a!==p.question.replace(/\s/g,'')){p.wrong++;p.streak=0;publish(r);send(ws,{type:'event',event:{kind:'wrong'}});return}p.score+=100;p.correct++;p.streak++;if(p.streak===15)p.superCharges++; p.landmarks++;p.built++;p.shieldCorrect++;if(p.shieldCorrect%10===0 && p.shieldCharges===0 && p.shieldUntil<=Date.now())p.shieldCharges=1;p.energy=Math.min(5,p.energy+1);next(r,i);publish(r,[{kind:'build',player:i}]);checkPendingSpecials(r);return;}
if(type==='attack'){const count=Number(m.count);if(count!==3&&count!==5)return fail(ws,'攻擊類型無效。');const bonus=count===3?'testSmall':'testBig';if(p[bonus]>0){p[bonus]--;}else{if(p.energy<count)return fail(ws,'攻擊能量不足。');p.energy=0;}if(count===3)p.smallUsed++;else p.bigUsed++;const opp=r.states[1-i],blocked=opp.shieldUntil>Date.now();const killed=blocked?0:Math.min(count,opp.landmarks);opp.landmarks-=killed;opp.lost+=killed;p.destroyed+=killed;opp.score=Math.max(0,opp.score-killed*100);publish(r,[{kind:'attack',player:i,target:1-i,count,killed,blocked}]);return;}
if(type==='super'){
 if(p.superCharges<1||p.pendingSuper)return fail(ws,'超爆攻擊尚不可使用。');
 p.superCharges--;p.superUsed++;p.streak=0;p.pendingSuper=true;
 const target=1-i, impactAt=Date.now()+1500;
 publish(r,[{kind:'superWarning',player:i,target,impactAt}]);
 const timer=setTimeout(()=>{
  if(r.phase!=='battle')return;
  p.pendingSuper=false;
  const opp=r.states[target],blocked=opp.shieldUntil>Date.now();
  const requested=15;const killed=blocked?0:Math.min(requested,opp.landmarks);
  opp.landmarks-=killed;opp.lost+=killed;p.destroyed+=killed;opp.score=Math.max(0,opp.score-killed*100);
  publish(r,[{kind:'super',player:i,target,killed,blocked}]);
 },1500);
 (r.superTimers||(r.superTimers=[])).push(timer);
 return;
}
if(type==='shield'){if(p.shieldCharges<1||p.shieldUntil>Date.now())return fail(ws,'防護罩尚不可使用。');p.shieldCharges=0;p.shieldUsed++;p.score+=500;p.shieldUntil=Date.now()+15000;publish(r,[{kind:'shield',player:i}]);return;}}
wss.on('connection',ws=>{send(ws,onlineMetrics());broadcastMetrics();ws.on('message',buffer=>{try{const m=JSON.parse(buffer.toString());if(!m||typeof m!=='object')return;handleMessage(ws,m)}catch(e){fail(ws,'資料格式錯誤。')}});ws.on('close',()=>{cleanup(ws);broadcastMetrics()});ws.on('error',()=>{});});
server.listen(port,'0.0.0.0',()=>console.log('Dream Island Battle online server: http://localhost:'+port));
