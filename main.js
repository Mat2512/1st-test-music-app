// ==== UI refs (já existentes no seu HTML)
const selMic = document.getElementById('mic');
const btnRefresh = document.getElementById('refresh');
const btnStart = document.getElementById('start');
const btnStop  = document.getElementById('stop');
const msg = document.getElementById('msg');
const gainSlider = document.getElementById('gain');
const gainVal = document.getElementById('gainVal');
const a4Input = document.getElementById('a4');
const voiceSel = document.getElementById('voice');
const fill = document.getElementById('fill');
const rmsOut = document.getElementById('rms');
const noteEl = document.getElementById('note');
const freqEl = document.getElementById('freq');
const centsEl = document.getElementById('cents');
const pointer = document.getElementById('ptr');
const kbd = document.getElementById('kbd');
const errEl = document.getElementById('err');

// ==== Teclado (12 notas)
const NAMES = ["C","C♯","D","D♯","E","F","F♯","G","G♯","A","A♯","B"];
if (kbd && !kbd.children.length) {
  NAMES.forEach(n=>{
    const d=document.createElement('div');
    const sharp = n.includes('♯');
    d.className='key';
    d.style.background = sharp ? '#111' : '#fff';
    d.style.color = sharp ? '#fff' : '#000';
    d.textContent = n;
    kbd.appendChild(d);
  });
}

// ==== Estado de áudio base
let A4REF = 440;
let ctx=null, analyser=null, srcNode=null, gainNode=null, stream=null, raf=null, buf=null;

// ---- Suavização & Histerese (anti-vibrato)
let fSmooth = null;
let EMA_ALPHA = 0.25;     // menor = mais suave
let MEDIAN_LEN = 7;       // janela mediana
const centsBuf = [];

let lockedNote = null;    // trava nota por curto período
let lockUntil = 0;
let NOTE_LOCK_MS = 200;   // 0.2s
let SWITCH_HYST = 30;     // precisa >30 cents para trocar

// ==== Utils
const dBtoLinear = db => Math.pow(10, db/20);
const median = arr => { const a=[...arr].sort((x,y)=>x-y); return a[Math.floor(a.length/2)] };
const voiceRange = () => {
  const v = voiceSel.value;
  if (v==='bass') return [50, 400];
  if (v==='soprano') return [150,1200];
  return [80, 750]; // mais estável
};
const nameToIndex = n => NAMES.indexOf(n); // C=0 ... B=11

// mapeamentos nota↔midi↔freq (A4 = midi 69)
const midiToFreq = (m) => A4REF * Math.pow(2, (m - 69) / 12);
const freqToMidi = (f) => 69 + 12 * Math.log2(f / A4REF);
const freqToData = f => {
  if (!f || !isFinite(f)) return null;
  const n = Math.round(freqToMidi(f));
  const note = NAMES[n % 12];
  const octave = Math.floor(n / 12) - 1;
  const refFreq = midiToFreq(n);
  const cents = Math.round(1200 * Math.log2(f / refFreq));
  return {note, octave, cents, refFreq, midi:n};
};
const noteOctToMidi = (noteName, octave) => (octave + 1) * 12 + nameToIndex(noteName);

// Autocorrelação simples (detector de pitch)
function detectPitch(buf, sr, minF, maxF, energyThresh=0.008) {
  let rms = 0;
  for (let i=0;i<buf.length;i++) rms += buf[i]*buf[i];
  rms = Math.sqrt(rms/buf.length);
  if (rms < energyThresh) return {freq:null, rms};

  const minLag = Math.floor(sr / maxF);
  const maxLag = Math.floor(sr / minF);
  let bestLag = -1, bestCorr = 0;

  for (let lag=minLag; lag<=maxLag; lag++){
    let corr = 0;
    for (let i=0; i<buf.length-lag; i++){
      corr += buf[i]*buf[i+lag];
    }
    if (corr > bestCorr){ bestCorr = corr; bestLag = lag; }
  }
  if (bestLag>0) return {freq: sr/bestLag, rms};
  return {freq:null, rms};
}

// ==== Handlers base
gainSlider.oninput = ()=>{ gainVal.textContent = gainSlider.value; if (gainNode) gainNode.gain.value = dBtoLinear(gainSlider.value); };
a4Input.oninput = ()=>{ A4REF = Number(a4Input.value||440); };
btnRefresh.onclick = listMics;
btnStart.onclick = start;
btnStop.onclick  = stop;

function setButtons(running){
  btnStart.disabled = running;
  btnStop.disabled  = !running;
}

async function listMics(){
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const mics = all.filter(d=>d.kind==='audioinput');
    selMic.innerHTML = '';
    for (const m of mics){
      const opt=document.createElement('option');
      opt.value = m.deviceId;
      opt.textContent = m.label || 'Microfone';
      selMic.appendChild(opt);
    }
  } catch (e) {
    console.error(e);
    if (errEl) errEl.textContent = 'Erro listando mics: ' + e.message;
  }
}

// Pede permissão para liberar labels de mics
navigator.mediaDevices?.getUserMedia({audio:true}).then(s=>{
  s.getTracks().forEach(t=>t.stop());
  return listMics();
}).catch(()=>listMics());

// ==== Controle de Suavidade (injetado)
(function injectSmoothControl(){
  const hostRow = voiceSel?.parentElement;
  if (!hostRow) return;
  const label = document.createElement('label');
  label.textContent = 'Suavidade:';
  label.style.marginLeft = '8px';
  const sel = document.createElement('select');
  sel.id = 'smooth';
  sel.innerHTML = `
    <option value="low">Baixa (rápido)</option>
    <option value="med" selected>Média</option>
    <option value="high">Alta (estável)</option>
  `;
  hostRow.appendChild(label);
  hostRow.appendChild(sel);

  const apply = (mode)=>{
    if (mode==='low'){ EMA_ALPHA=0.45; MEDIAN_LEN=3; NOTE_LOCK_MS=120; SWITCH_HYST=22; }
    else if (mode==='high'){ EMA_ALPHA=0.18; MEDIAN_LEN=11; NOTE_LOCK_MS=260; SWITCH_HYST=35; }
    else { EMA_ALPHA=0.25; MEDIAN_LEN=7; NOTE_LOCK_MS=200; SWITCH_HYST=30; }
  };
  sel.addEventListener('change', e=>apply(e.target.value));
  apply('med');
})();

// ==== INJETAR: Treino de Nota Alvo + Metrônomo (sem editar o HTML)
(function injectTrainerAndMetronome(){
  const readout = document.getElementById('readout');
  if (!readout) return;

  // Container geral
  const wrap = document.createElement('div');
  wrap.className = 'panel';
  wrap.style.marginTop = '12px';

  // ---- Treino de Nota
  const h2 = document.createElement('div');
  h2.textContent = '🎯 Treino de Nota Alvo';
  h2.style.fontWeight = '800';
  h2.style.marginBottom = '8px';
  wrap.appendChild(h2);

  const row1 = document.createElement('div');
  row1.className = 'row';

  const labNote = document.createElement('label'); labNote.textContent = 'Nota alvo:';
  const selNote = document.createElement('select'); selNote.id='trainer-note';
  NAMES.forEach(n => {
    const o = document.createElement('option'); o.value=n; o.textContent=n; selNote.appendChild(o);
  });

  const labOct = document.createElement('label'); labOct.textContent = 'Oitava:';
  const selOct = document.createElement('select'); selOct.id='trainer-oct';
  [2,3,4,5,6].forEach(oct=>{
    const o=document.createElement('option'); o.value=String(oct); o.textContent=String(oct); selOct.appendChild(o);
  });
  selNote.value = 'A'; selOct.value='4'; // padrão A4

  const labTol = document.createElement('label'); labTol.textContent = 'Tolerância (cents):';
  const tol = document.createElement('input'); tol.type='number'; tol.min='2'; tol.max='50'; tol.step='1'; tol.value='10'; tol.style.width='70px';

  const tBtn = document.createElement('button'); tBtn.textContent='Iniciar treino'; tBtn.className='cta';
  const tStop = document.createElement('button'); tStop.textContent='Parar treino'; tStop.className='stop'; tStop.disabled=true;

  row1.append(labNote, selNote, labOct, selOct, labTol, tol, tBtn, tStop);
  wrap.appendChild(row1);

  const stats = document.createElement('div');
  stats.className='hint';
  stats.style.marginTop='8px';
  stats.innerHTML = `
    Erro atual: <b id="t_err">—</b> cents ·
    Tempo afinado: <b id="t_time">0.0s</b> ·
    Melhor (menor erro): <b id="t_best">—</b> ·
    Média: <b id="t_avg">—</b>
  `;
  wrap.appendChild(stats);

  // ---- Metrônomo
  const h3 = document.createElement('div');
  h3.textContent = '⏱️ Metrônomo';
  h3.style.fontWeight = '800';
  h3.style.marginTop = '12px';
  h3.style.marginBottom = '8px';
  wrap.appendChild(h3);

  const row2 = document.createElement('div');
  row2.className = 'row';

  const labBpm = document.createElement('label'); labBpm.textContent = 'BPM:';
  const bpm = document.createElement('input'); bpm.type='number'; bpm.min='20'; bpm.max='240'; bpm.step='1'; bpm.value='80'; bpm.style.width='70px';

  const labBeat = document.createElement('label'); labBeat.textContent = 'Tempo por compasso:';
  const beats = document.createElement('select');
  [1,2,3,4,6].forEach(v=>{ const o=document.createElement('option'); o.value=String(v); o.textContent=String(v); beats.appendChild(o); });
  beats.value='4';

  const mStart = document.createElement('button'); mStart.textContent='Iniciar metrônomo'; mStart.className='cta';
  const mStop  = document.createElement('button'); mStop.textContent ='Parar metrônomo'; mStop.className='stop'; mStop.disabled=true;

  row2.append(labBpm, bpm, labBeat, beats, mStart, mStop);
  wrap.appendChild(row2);

  const vis = document.createElement('div');
  vis.style.marginTop='8px';
  vis.innerHTML = `<div class="tuner" style="height:32px">
    <div id="mbar" class="pointer" style="left:0%;width:8px; background:#00ffa6; box-shadow:0 0 16px #00ffa6; height:100%"></div>
  </div>`;
  wrap.appendChild(vis);

  readout.appendChild(wrap);

  // ==== Lógica do Treino
  let trainerOn = false;
  let trainerTargetMidi = noteOctToMidi(selNote.value, parseInt(selOct.value,10));
  let trainerTol = parseInt(tol.value,10);
  let trainerStartTs = 0;
  let trainerInTuneMs = 0;
  let trainerLastTs = 0;
  let trainerBest = null;
  let trainerAvgSum = 0;
  let trainerAvgCount = 0;

  const tErr = document.getElementById('t_err');
  const tTime= document.getElementById('t_time');
  const tBest= document.getElementById('t_best');
  const tAvg = document.getElementById('t_avg');

  function trainerResetStats(){
    trainerStartTs = performance.now();
    trainerInTuneMs = 0;
    trainerLastTs = trainerStartTs;
    trainerBest = null;
    trainerAvgSum = 0;
    trainerAvgCount = 0;
    tErr.textContent = '—';
    tTime.textContent= '0.0s';
    tBest.textContent= '—';
    tAvg.textContent = '—';
  }

  function setTrainerTarget(){
    trainerTargetMidi = noteOctToMidi(selNote.value, parseInt(selOct.value,10));
    trainerTol = parseInt(tol.value,10);
  }

  selNote.addEventListener('change', setTrainerTarget);
  selOct.addEventListener('change', setTrainerTarget);
  tol.addEventListener('change', setTrainerTarget);

  tBtn.addEventListener('click', ()=>{
    setTrainerTarget();
    trainerOn = true;
    tBtn.disabled = true;
    tStop.disabled = false;
    trainerResetStats();
    msg.textContent = "Treino ON — cante a nota alvo!";
  });
  tStop.addEventListener('click', ()=>{
    trainerOn = false;
    tBtn.disabled = false;
    tStop.disabled = true;
    msg.textContent = "Treino OFF.";
  });

  // ==== Lógica do Metrônomo
  let metroAC = null;
  let metroTimer = null;
  let metroBeat = 0;

  function metroPlayClick(accent=false){
    if (!metroAC) metroAC = new (window.AudioContext || window.webkitAudioContext)();
    const t = metroAC.currentTime + 0.01;
    const o = metroAC.createOscillator();
    const g = metroAC.createGain();
    o.type = 'square';
    o.frequency.value = accent ? 1200 : 880;
    g.gain.value = 0.0001;
    o.connect(g).connect(metroAC.destination);
    o.start(t);
    // envelope
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(accent?0.7:0.5, t+0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, t+0.06);
    o.stop(t+0.08);
  }

  function metroStart(){
    if (metroTimer) return;
    metroBeat = 0;
    const mbar = document.getElementById('mbar');
    const beatsPerBar = parseInt(beats.value,10);
    const interval = 60000 / Math.max(20, Math.min(240, parseInt(bpm.value,10)));

    metroPlayClick(true);
    mbar.style.left = '0%';
    mStart.disabled = true; mStop.disabled = false;

    metroTimer = setInterval(()=>{
      metroBeat = (metroBeat + 1) % beatsPerBar;
      const accent = (metroBeat === 0);
      metroPlayClick(accent);
      // anima barra (0%→100%)
      const pos = (metroBeat / (beatsPerBar-1||1)) * 100;
      mbar.style.left = `${Math.max(0, Math.min(100, pos))}%`;
      mbar.style.background = accent ? '#00ffa6' : '#60a5fa';
      mbar.style.boxShadow = accent ? '0 0 16px #00ffa6' : '0 0 12px #60a5fa';
    }, interval);
  }
  function metroStop(){
    if (metroTimer){ clearInterval(metroTimer); metroTimer=null; }
    if (metroAC){ try{ metroAC.close(); }catch{} metroAC=null; }
    mStart.disabled = false; mStop.disabled = true;
  }

  mStart.addEventListener('click', metroStart);
  mStop .addEventListener('click', metroStop);

  // Expor funções ao loop principal (via closures)
  window.__trainer__ = {
    on: ()=>trainerOn,
    targetMidi: ()=>trainerTargetMidi,
    tol: ()=>trainerTol,
    tick: (fShow)=>{
      if (!trainerOn || !fShow) return;
      const now = performance.now();
      const dt = now - trainerLastTs;
      trainerLastTs = now;

      const targetF = midiToFreq(trainerTargetMidi);
      const centsErr = Math.round(1200 * Math.log2(fShow / targetF));
      tErr.textContent = String(centsErr);

      // stats
      trainerBest = (trainerBest==null) ? Math.abs(centsErr) : Math.min(trainerBest, Math.abs(centsErr));
      trainerAvgSum += Math.abs(centsErr);
      trainerAvgCount++;

      if (Math.abs(centsErr) <= trainerTol) {
        trainerInTuneMs += dt;
      }
      tTime.textContent = (trainerInTuneMs/1000).toFixed(1) + 's';
      tBest.textContent = trainerBest.toFixed(0) + '¢';
      tAvg.textContent  = (trainerAvgSum/trainerAvgCount).toFixed(0) + '¢';
    }
  };
})();

// ==== Start/Stop de áudio base
async function start(){
  if (errEl) errEl.textContent = '';
  try{
    setButtons(true);
    A4REF = Number(a4Input.value||440);

    ctx = new (window.AudioContext || window.webkitAudioContext)();
    await ctx.resume();

    const deviceId = selMic.value ? { exact: selMic.value } : undefined;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId,
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        channelCount: 1, sampleRate: {ideal: 48000}
      }
    });

    srcNode = ctx.createMediaStreamSource(stream);
    gainNode = ctx.createGain(); gainNode.gain.value = dBtoLinear(gainSlider.value);
    analyser = ctx.createAnalyser();

    // ajustes mais estáveis
    analyser.fftSize = 8192;
    analyser.smoothingTimeConstant = 0.95;

    srcNode.connect(gainNode).connect(analyser);
    buf = new Float32Array(analyser.fftSize);

    msg.textContent = "Ouvindo… cante 'laaa' perto do microfone.";
    loop();
  }catch(e){
    console.error(e);
    setButtons(false);
    msg.textContent = "Erro ao iniciar. Veja abaixo.";
    if (errEl) {
      errEl.textContent =
        (e.name === 'NotAllowedError') ? "Permissão negada. Clique no cadeado da barra e permita o microfone."
      : (e.name === 'NotFoundError')  ? "Nenhum microfone encontrado. Conecte um e clique em Atualizar mics."
      : (e.name === 'NotReadableError') ? "Outro app está usando o microfone. Feche Zoom/Meet/Discord e tente de novo."
      : `Falhou getUserMedia: ${e.name} – ${e.message}`;
    }
  }
}

function stop(){
  cancelAnimationFrame(raf);
  if (stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; }
  if (ctx){ ctx.close(); ctx=null; }
  msg.textContent = "Parado.";
  setButtons(false);
  // limpa buffers/histerese
  fSmooth = null; centsBuf.length = 0; lockedNote = null; lockUntil = 0;
}

// ==== Loop principal
function loop(){
  if (!analyser || !ctx) return;
  analyser.getFloatTimeDomainData(buf);

  const [minF, maxF] = voiceRange();
  const {freq, rms} = detectPitch(buf, ctx.sampleRate, minF, maxF, 0.008);

  rmsOut.textContent = (rms||0).toFixed(3);
  fill.style.width = `${Math.min(100, Math.max(0, (rms||0)*400))}%`;

  // EMA para suavizar
  let fShow = null;
  if (freq){
    fSmooth = (fSmooth==null) ? freq : (EMA_ALPHA*freq + (1-EMA_ALPHA)*fSmooth);
    fShow = fSmooth;
  } else {
    fSmooth = null;
  }

  const data = fShow ? freqToData(fShow) : null;

  // Mediana curta nos cents
  if (data){
    centsBuf.push(data.cents);
    if (centsBuf.length > MEDIAN_LEN) centsBuf.shift();
    const centsMed = (centsBuf.length>=3) ? median(centsBuf) : data.cents;
    data.cents = Math.round(centsMed);
  }

  // Histerese / trava de nota
  if (data){
    const now = performance.now();
    const currentNote = data.note + data.octave;
    if (lockedNote == null) {
      lockedNote = currentNote;
      lockUntil = now + NOTE_LOCK_MS;
    } else {
      if (currentNote !== lockedNote) {
        if (now > lockUntil && Math.abs(data.cents) > SWITCH_HYST) {
          lockedNote = currentNote;
          lockUntil = now + NOTE_LOCK_MS;
        } else {
          data.note = lockedNote.slice(0, lockedNote.length-1);
          data.octave = parseInt(lockedNote.slice(-1),10);
        }
      } else if (now > lockUntil && Math.abs(data.cents) <= 5) {
        lockUntil = now + NOTE_LOCK_MS;
      }
    }
  }

  // UI base
  if (data){
    noteEl.textContent = `${data.note}${data.octave}`;
    noteEl.style.textShadow = Math.abs(data.cents)<=5 ? "0 0 22px var(--neon)" : "0 0 10px var(--mag)";
    freqEl.textContent = `${(fShow||0).toFixed(1)} Hz · alvo ${data.refFreq.toFixed(1)} Hz`;
    centsEl.textContent = String(data.cents);
    const c = Math.max(-50, Math.min(50, data.cents));
    pointer.style.left = (50 + c) + '%';
    const tuned = Math.abs(data.cents)<=5;
    pointer.style.background = tuned ? "lime" : "#ff3af2";
    pointer.style.boxShadow = tuned ? "0 0 24px lime" : "0 0 16px #ff3af2";
    for (let i=0;i<kbd.children.length;i++){
      const el=kbd.children[i];
      if (el.textContent===data.note){
        el.style.boxShadow = "0 0 18px var(--neon) inset, 0 0 10px var(--neon)";
        el.style.transform = "translateY(-2px)";
      } else {
        el.style.boxShadow = "0 2px 6px rgba(0,0,0,.2)";
        el.style.transform = "translateY(0)";
      }
    }
    msg.textContent = "Detecção ativa.";
  } else {
    noteEl.textContent = "—";
    freqEl.textContent = "Aguardando som estável...";
    centsEl.textContent = "0";
    pointer.style.left = "50%";
    pointer.style.background = "#ff3af2";
    pointer.style.boxShadow = "0 0 16px #ff3af2";
    msg.textContent = (rms && rms<0.01) ? "Sinal muito baixo — aproxime-se do mic ou aumente a sensibilidade." : "Analisando…";
    for (let i=0;i<kbd.children.length;i++){
      const el=kbd.children[i];
      el.style.boxShadow = "0 2px 6px rgba(0,0,0,.2)";
      el.style.transform = "translateY(0)";
    }
  }

  // Tick do treino (se ligado)
  if (window.__trainer__) {
    window.__trainer__.tick(fShow);
  }

  raf = requestAnimationFrame(loop);
}
