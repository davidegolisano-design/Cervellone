
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { randomInt } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function generatePin(){ return String(randomInt(100000,999999)); }

let revealTimeout = null;
let precountTimeout = null;
let autoNextTimeout = null;

let game = {
  pin: generatePin(),
  controlSocketId: null,
  phase: 'lobby',   // lobby | precount | question | reveal | final
  questions: [],
  questionIndex: -1,
  questionStartTs: null,
  precountStartTs: null,
  precountSec: 5,
  questionDurationSec: 20,
  players: new Map(),
  socketToToken: new Map(),
  settings: {
    leaderboardVisible: true,
    autoAdvance: true,
    revealDelaySec: 4,
    wrongPenalty: 200,
    freeSkips: 1,
    correctMaxPoints: 1300
  },
  lastResults: []
};

function broadcastAnswerStats(){
  const total = Array.from(game.players.values()).filter(p=>p.connected).length;
  const answered = Array.from(game.players.values()).filter(p=>p.answer!=null).length;
  io.to('control').emit('answered-stats', { answered, total });
  io.to('display').emit('answered-stats', { answered, total });
}
function ensureUniqueName(name){
  let base = String(name||'Giocatore').trim();
  if(!base) base = 'Giocatore';
  const names = new Set(Array.from(game.players.values()).map(p=>p.name));
  if(!names.has(base)) return base;
  let i = 2; let cand = `${base} (${i})`;
  while(names.has(cand)){ i++; cand = `${base} (${i})`; }
  return cand;
}
function findByName(name){
  const n = String(name||'').trim();
  if(!n) return null;
  for(const p of game.players.values()){
    if(p.name === n) return p;
  }
  return null;
}
function safeQuestion(q){
  if(!q) return null;
  const { question, options, category, difficulty } = q;
  return { question, options, category, difficulty };
}
function boards(){
  const total = Array.from(game.players.values())
    .map(p=>({name:p.name, score:p.score, connected:p.connected}))
    .sort((a,b)=>b.score-a.score);
  const round = Array.from(game.players.values())
    .map(p=>({name:p.name, score:p.roundScore||0, connected:p.connected}))
    .sort((a,b)=> b.score - a.score );
  return { total, round };
}
function broadcastBoards(){
  const {total, round} = boards();
  io.to('control').emit('leaderboard-total', total);
  io.to('control').emit('leaderboard-round', round);
  io.to('display').emit('display-config', game.settings);
}
function sendStatus(){
  const payload = {
    phase: game.phase,
    idx: game.questionIndex,
    total: game.questions.length,
    durationSec: game.questionDurationSec,
    settings: game.settings,
    precountSec: game.precountSec
  };
  io.to('display').emit('status', payload);
  io.to('control').emit('status', payload);
}
function clearTimers(){
  if(revealTimeout){ clearTimeout(revealTimeout); revealTimeout=null; }
  if(precountTimeout){ clearTimeout(precountTimeout); precountTimeout=null; }
  if(autoNextTimeout){ clearTimeout(autoNextTimeout); autoNextTimeout=null; }
}

// Time sync
io.on('connection',(socket)=>{
  socket.on('time-ping', (clientTs)=>{ socket.emit('time-pong', { serverTs: Date.now(), echo: clientTs }); });
});

// REST
app.get('/api/pin', (_req,res)=> res.json({ pin: game.pin }) );
app.get('/api/snapshot', (_req,res)=>{
  const players = Array.from(game.players.values()).map(p=>({name:p.name,score:p.score,roundScore:p.roundScore||0,connected:p.connected,answered:p.answer!=null}));
  res.json({ pin:game.pin, phase:game.phase, idx:game.questionIndex, total:game.questions.length, durationSec:game.questionDurationSec, settings:game.settings, players });
});

function startPrecount(index){
  clearTimers();
  if(index<0 || index>=game.questions.length) return;
  game.phase='precount';
  game.questionIndex=index;
  game.precountStartTs=Date.now();
  for(const p of game.players.values()){ p.answer=null; p.answeredAt=null; }
  const payload = { idx:index, total: game.questions.length, startedAt: game.precountStartTs, durationSec: game.precountSec };
  io.to('display').emit('precount', payload);
  io.to('control').emit('precount', payload);
  precountTimeout = setTimeout(()=> startQuestion(index), game.precountSec*1000 + 50);
  sendStatus();
  broadcastAnswerStats();
}

function startQuestion(index){
  clearTimers();
  if(index<0 || index>=game.questions.length) return;
  game.phase='question';
  game.questionIndex=index;
  game.questionStartTs=Date.now();
  game.lastResults = [];
  const q = game.questions[index];
  const payload = { ...safeQuestion(q), idx:index, total: game.questions.length, startedAt: game.questionStartTs, durationSec: game.questionDurationSec };
  io.to('players').emit('question', { idx:index, total:payload.total });
  io.to('display').emit('question', payload);
  io.to('control').emit('question', { ...q, ...payload });
  revealTimeout = setTimeout(()=>{ if(game.phase==='question' && game.questionIndex===index) revealAnswer(); }, game.questionDurationSec*1000 + 200);
  sendStatus();
  broadcastAnswerStats();
}

function revealAnswer(){
  clearTimers();
  const q = game.questions[game.questionIndex];
  if(!q) return;
  game.phase='reveal';
  const perPlayer=[];
  for(const p of game.players.values()){
    let delta=0, correct=false, timeSec=null, status='skip';
    if(p.answer!=null){
      timeSec = Math.max(0, ((p.answeredAt? p.answeredAt : (game.questionStartTs+game.questionDurationSec*1000)) - game.questionStartTs)/1000 );
      if(p.answer===q.correctIndex){
        correct=true; status='correct';
        const elapsed = p.answeredAt? (p.answeredAt - game.questionStartTs)/1000 : game.questionDurationSec;
        const dur = Math.max(1, game.questionDurationSec);
        const rem = Math.max(0, Math.min(dur, dur - elapsed));
        const maxPts = Math.max(1, Number(game.settings.correctMaxPoints)||1000);
        const basePart = Math.round(maxPts * 0.6);
        const bonusPart = Math.round(maxPts * 0.4 * (rem / dur));
        delta = basePart + bonusPart;
        p.score += delta;
        p.roundScore = (p.roundScore||0) + delta;
      }else{
        status='wrong';
        const pen = Math.max(0, Number(game.settings.wrongPenalty)||0);
        p.score = Math.max(0, p.score - pen);
        delta = -pen;
      }
    }else{
      const free = Math.max(0, Number(game.settings.freeSkips)||0);
      p.skipsUsed = (typeof p.skipsUsed==='number'? p.skipsUsed : 0);
      if(p.skipsUsed < free){
        p.skipsUsed += 1;
        status='skip'; delta=0;
      }else{
        status='wrong';
        const pen = Math.max(0, Number(game.settings.wrongPenalty)||0);
        p.score = Math.max(0, p.score - pen);
        delta = -pen;
      }
    }
    perPlayer.push({ name:p.name, correct, timeSec: timeSec, answer:p.answer, delta, total:p.score, status });
  }
  const sortedPerQ = perPlayer.slice().sort((a,b)=>{
    if (a.correct !== b.correct) return a.correct? -1 : 1;
    const ta = (a.timeSec==null? 1e9 : a.timeSec);
    const tb = (b.timeSec==null? 1e9 : b.timeSec);
    return ta - tb;
  });
  game.lastResults = sortedPerQ;

  io.to('players').emit('reveal', { correctIndex:q.correctIndex });
  io.to('display').emit('reveal', { correctIndex:q.correctIndex, perPlayer: sortedPerQ });
  io.to('control').emit('reveal', { correctIndex:q.correctIndex, perPlayer: sortedPerQ });

  broadcastBoards();
  sendStatus();

  if(game.settings.autoAdvance){
    autoNextTimeout = setTimeout(()=>{
      const i=game.questionIndex+1;
      if(i>=game.questions.length) endGame();
      else startPrecount(i);
    }, Math.max(500, (Number(game.settings.revealDelaySec)||4)*1000));
  }
}

function endGame(){
  clearTimers();
  game.phase='final';
  const finalBoard = Array.from(game.players.values()).map(p=>({name:p.name, score:p.score})).sort((a,b)=> b.score - a.score);
  io.to('display').emit('final-results', finalBoard);
  io.to('control').emit('final-results', finalBoard);
  io.to('players').emit('game-over',{});
  sendStatus();
}

io.on('connection',(socket)=>{
  socket.on('display-hello', ()=>{
    socket.join('display');
    socket.emit('pin', game.pin);
    socket.emit('display-config', game.settings);
    sendStatus();
    broadcastAnswerStats();
    if(game.phase==='precount' && game.questionIndex>=0){
      socket.emit('precount', { idx:game.questionIndex, total: game.questions.length, startedAt: game.precountStartTs, durationSec: game.precountSec });
    }
    if(game.phase==='question' && game.questionIndex>=0){
      const q = game.questions[game.questionIndex];
      socket.emit('question', { ...safeQuestion(q), idx:game.questionIndex, total: game.questions.length, startedAt: game.questionStartTs, durationSec: game.questionDurationSec });
    }
    if(game.phase==='reveal'){
      socket.emit('reveal', { correctIndex: game.questions[game.questionIndex]?.correctIndex ?? null, perPlayer: game.lastResults });
    }
  });

  socket.on('control-hello', ()=>{
    game.controlSocketId = socket.id;
    socket.join('control');
    socket.emit('pin', game.pin);
    sendStatus();
    broadcastBoards();
    broadcastAnswerStats();
    socket.emit('qcount', game.questions.length);
    if(game.phase==='precount' && game.questionIndex>=0){
      socket.emit('precount', { idx:game.questionIndex, total: game.questions.length, startedAt: game.precountStartTs, durationSec: game.precountSec });
    }
    if(game.phase==='question' && game.questionIndex>=0){
      const q = game.questions[game.questionIndex];
      socket.emit('question', { ...q, idx:game.questionIndex, total: game.questions.length, startedAt: game.questionStartTs, durationSec: game.questionDurationSec });
    }
    if(game.phase==='reveal'){
      socket.emit('reveal', { correctIndex: game.questions[game.questionIndex]?.correctIndex ?? null, perPlayer: game.lastResults });
    }
  });

  socket.on('player-hello', ({ name, pin, token })=>{
    if(pin!==game.pin){ socket.emit('join-error',{message:'PIN errato'}); return; }
    let player=null;
    if(token && game.players.has(token)){
      player = game.players.get(token);
      player.connected=true; player.socketId=socket.id;
      if(typeof player.skipsUsed!=='number') player.skipsUsed=0;
      socket.join('players');
      socket.emit('join-ok',{ token, name:player.name });
    }else{
      const newToken = uuidv4();
      player = { token:newToken, socketId:socket.id, name:ensureUniqueName(name), score:0, roundScore:0, connected:true, answer:null, answeredAt:null, skipsUsed:0 };
      game.players.set(newToken, player);
      game.socketToToken.set(socket.id, newToken);
      socket.join('players');
      socket.emit('join-ok',{ token:newToken, name:player.name });
    }
    broadcastBoards();
    broadcastAnswerStats();
    if(game.phase==='question' && game.questionIndex>=0){
      socket.emit('question', { idx:game.questionIndex, total: game.questions.length, startedAt: game.questionStartTs, durationSec: game.questionDurationSec });
    }
  });

  socket.on('player-answer', ({ answerIndex })=>{
    const token = game.socketToToken.get(socket.id) || [...game.players.values()].find(p=>p.socketId===socket.id)?.token;
    if(!token) return;
    const p = game.players.get(token);
    if(!p || game.phase!=='question') return;
    if(p.answer!=null) return;
    p.answer = Number(answerIndex);
    p.answeredAt = Date.now();
    socket.emit('answer-received',{ answerIndex:p.answer });
    broadcastAnswerStats();
  });

  socket.on('host-start', ()=>{ if(socket.id!==game.controlSocketId) return; startPrecount(0); });
  socket.on('host-next',  ()=>{ if(socket.id!==game.controlSocketId) return; const i=game.questionIndex+1; if(i>=game.questions.length) endGame(); else startPrecount(i); });
  socket.on('host-prev',  ()=>{ if(socket.id!==game.controlSocketId) return; const i=Math.max(0, game.questionIndex-1); startPrecount(i); });
  socket.on('host-reveal',()=>{ if(socket.id!==game.controlSocketId) return; if(game.phase==='question') revealAnswer(); });
  socket.on('host-end',   ()=>{ if(socket.id!==game.controlSocketId) return; endGame(); });
  socket.on('host-set-duration', (sec)=>{ if(socket.id!==game.controlSocketId) return; const n=Math.max(5,Math.min(90,Number(sec)||20)); game.questionDurationSec=n; sendStatus(); });
  socket.on('host-upload-questions', (qs)=>{
    if(socket.id!==game.controlSocketId) return;
    if(!Array.isArray(qs)) return;
    const cleaned = qs.filter(q=>q && q.question && Array.isArray(q.options) && Number.isInteger(q.correctIndex));
    if(cleaned.length){
      game.questions = cleaned;
      game.phase='lobby';
      game.questionIndex=-1;
      io.to('control').emit('qcount', game.questions.length);
      sendStatus();
    }
  });
  socket.on('host-set-leaderboard', ({visible})=>{
    if(socket.id!==game.controlSocketId) return;
    if(typeof visible === 'boolean') game.settings.leaderboardVisible = visible;
    io.to('display').emit('display-config', game.settings);
    sendStatus();
  });
  socket.on('host-set-auto', (on)=>{ if(socket.id!==game.controlSocketId) return; game.settings.autoAdvance = !!on; sendStatus(); });
  socket.on('host-set-scoring', ({ correctMaxPoints, wrongPenalty, freeSkips })=>{
    if(socket.id!==game.controlSocketId) return;
    if(correctMaxPoints!=null){ game.settings.correctMaxPoints = Math.max(1, Number(correctMaxPoints)||1000); }
    if(wrongPenalty!=null){ game.settings.wrongPenalty = Math.max(0, Number(wrongPenalty)||0); }
    if(freeSkips!=null){ game.settings.freeSkips = Math.max(0, Number(freeSkips)||0); }
    io.to('display').emit('display-config', game.settings);
    sendStatus();
  });
  socket.on('host-new-round', ()=>{
    if(socket.id!==game.controlSocketId) return;
    for(const p of game.players.values()){ p.roundScore = 0; }
    broadcastBoards();
  });
  socket.on('host-reset-scores', ()=>{
    if(socket.id!==game.controlSocketId) return;
    for(const p of game.players.values()){ p.score=0; p.roundScore=0; p.skipsUsed=0; }
    broadcastBoards();
  });
  socket.on('host-adjust-score-byname', ({ name, delta })=>{
    if(socket.id!==game.controlSocketId) return;
    const p = findByName(name); if(!p) return;
    p.score = Math.max(0, p.score + Number(delta||0));
    broadcastBoards();
  });
  socket.on('host-set-score-byname', ({ name, score })=>{
    if(socket.id!==game.controlSocketId) return;
    const p = findByName(name); if(!p) return;
    p.score = Math.max(0, Number(score)||0);
    broadcastBoards();
  });
  socket.on('host-rename-byname', ({ name, newName })=>{
    if(socket.id!==game.controlSocketId) return;
    const p = findByName(name); if(!p) return;
    p.name = ensureUniqueName(newName);
    broadcastBoards();
  });
  socket.on('host-kick-byname', ({ name })=>{
    if(socket.id!==game.controlSocketId) return;
    const p = findByName(name); if(!p) return;
    for (const [tok, pl] of game.players.entries()){
      if(pl.name === p.name){ game.players.delete(tok); break; }
    }
    broadcastBoards();
    broadcastAnswerStats();
  });
  socket.on('host-show-fullboard', ()=>{
    if(socket.id!==game.controlSocketId) return;
    const { total } = boards();
    io.to('display').emit('show-fullboard', total);
  });
  socket.on('host-hide-fullboard', ()=>{
    if(socket.id!==game.controlSocketId) return;
    io.to('display').emit('hide-fullboard');
  });
  socket.on('disconnect', ()=>{
    const token = game.socketToToken.get(socket.id);
    if(token && game.players.has(token)){
      const p = game.players.get(token);
      p.connected=false;
      broadcastBoards();
      broadcastAnswerStats();
    }
    if(socket.id===game.controlSocketId){ game.controlSocketId=null; }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, ()=>{
  console.log(`Cervellone Pro v5.2.1 su http://0.0.0.0:${PORT}`);
  console.log(`PIN: ${game.pin}`);
});
