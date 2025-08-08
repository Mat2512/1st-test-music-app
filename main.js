/* =======================
   Afinador Visual – main.js
   - Range de detecção: 20–2000 Hz
   - Suavização (EMA + mediana)
   - Histerese de nota
   - Treino de nota alvo (injetado)
   - Metrônomo (injetado)
   ======================= */

// ---- Refs principais do HTML existente
const el = {
  selMic: document.getElementById('mic'),
  btnRefresh: document.getElementById('refresh'),
  btnStart: document.getElementById('start'),
  btnStop: document.getElementById('stop'),
  msg: document.getElementById('msg'),
  gainSlider: document.getElementById('gain'),
  gainVal: document.getElementById('gainVal'),
  a4Input: document.getElementById('a4'),
  fill: document.getElementById('fill'),
  rmsOut: document.getElementById('rms'),
  noteEl: document.getElementById('note'),
  freqEl: document.getElementById('freq'),
  centsEl: document.getElementById('cents'),
  pointer: document.getElementById('ptr'),
  kbd: document.getElementById('kbd'),
  errEl: document.getElementById('err'),
  readout: document.getElementById('readout'),
  voiceSel: document.getElementById('voice'), // pode não existir; vamos ignorar
};

// Esconde o seletor de "Modo voz" se existir (não usamos mais)
if (el.voiceSel && el.voiceSel.parentElement) {
  el.voiceSel.parentElement.style.display = 'none';
}

// ---- Teclado (12 notas) – cria se ainda não existir
const NAMES = ["C","C♯","D","D♯","E","F","F♯","G","G♯","A","A♯","B"];
if (el.kbd && !el.kbd.children.length) {
  NAMES.forEach(n=>{
    const d=document.createElement('div');
    const sharp = n.includes('♯');
    d.className='key';
    d.style.background = sharp ? '#111' : '#fff';
    d.style.color = sharp ? '#fff' : '#000';
    d.textContent = n;
    el.kbd.appendChild(d);
  });
}

// ---- Estado de áudio base
let A4REF = 440;
let ctx=null, analyser=null, srcNode=null, gainNode=null, stream=null, raf=null, buf=null;

// ---- Detector: faixa TOTAL de canto (e além)
const MIN_FREQ = 20;     // graves extremos
const MAX_FREQ = 2000;   // agudos humanos
// Para 20 Hz, precisamos de buffer longo -> fftSize 32768

// ---- Suavização & Histerese (anti-vibrato)
let fSmooth = null;
let EMA_ALPHA = 0.25;     // menor = mais suave (padrão “médio”)
let MEDIAN_LEN = 7;       // janela da mediana (amortece tremulação)
const centsBuf = [];

let lockedNote = null;    // trava nota por curto período
let lockUntil = 0;
let NOTE_LOCK_MS = 200;   // 0.2s
let SWITCH_HYST = 30;     // troca de nota só se sair >30 cents

// ==== Utils
const dBtoLinear = db => Math.pow(10, db/20);
const median = arr => { const a=[...arr].sort((x,y)=>x-y); return a[Math.floor(a.length/2)] };
const nameToIndex = n => NAMES.indexOf(n);
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
if (el.gainSlider) {
  el.gainSlider.oninput = ()=>{
    el.gainVal.textContent = el.gainSlider.value;
    if (gainNode) gainNode.gain.value = dBtoLinear(el.gainSlider.value);
  };
}
if (el.a4Input) {
  el.a4Input.oninput = ()=>{ A4REF = Number(el.a4Input.value||440); };
}
if (el.btnRefresh) el.btnRefresh.onclick = listMics;
if (el.btnStart)   el.btnStart.onclick   = start;
if (el.btnStop)    el.btnStop.onclick    = stop;

function setButtons(running){
  if (!el.btnStart || !el.btnStop) return;
  el.btnStart.disabled = running;
  el.btnStop.disabled  = !running;
}

async function listMics(){
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const mics = all.filter(d=>d.kind==='audioinput');
    if (el.selMic) {
      el.selMic.innerHTML = '';
      for (const m of mics){
        const opt=document.createElement('option');
        opt.value = m.deviceId;
        opt.textContent = m.label || 'Microfone';
        el.selMic.appendChild(opt);
      }
    }
  } catch (e) {
    console.error(e);
    if (el.errEl) el.errEl.textContent = 'Erro listando mics: ' + e.message;
  }
}

// Pede permissão para liberar labels de mics
navigator.mediaDevices?.getUserMedia({audio:true}).then(s=>{
  s.getTracks().forEach(t=>t.stop());
  return listMics();
}).catch(()=>listMics());

// ==== Controle de Suavidade (injetado, sem depender do select de voz)
(function injectSmoothControl(){
  // Tenta achar a linha onde ficam os controles; se não achar, cria uma
  let hostRow = el.a4Input ? el.a4Input.parentElement : null;
  if (!hostRow) {
    hostRow = document.createElement('div');
    hostRow.className = 'row';
    const wrap = el.readout?.parentElement || document.body;
    wrap.appendChild(hostRow);
  }
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
    console.log('[Afinador] Suavidade:', mode, {EMA_ALPHA, MEDIAN_LEN, NOTE_LOCK_MS, SWITCH_HYST});
  };
  sel.addEventListener('change', e=>apply(e.target.value));
  apply('med');
})();

// ==== INJETAR: Treino de Nota Alvo + Metrônomo
(function injectTrainerAndMetronome(){
  let host = el.readout;
  if (!host) {
    console.warn('[Afinador] #readout não encontrado — criando um container.');
    host = document.createElement('div');
    host.id = 'readout';
    host.className = 'panel';
    document.body.appendChild(host);
  }

  const wrap = document.createElement('div');
  wrap.className = 'panel';
  wrap.style.marginTop = '12px';

  // ---- Treino
  const h2 = document.createElement('div');
  h2.textContent = '🎯 Treino de Nota Alvo';
  h2.style.fontWeight = '800';
  h2.style.marginBottom = '8px';
  wrap.appendChild(h2);

  const row1 = document.createElement('div');
  row1.className = 'row';

  const labNote = document.createElement('label'); labNote.textContent = 'Nota:';
  const selNote = document.createElement('select'); selNote.id='trainer-note';
  NAMES.forEach(n => { const o=document.createElement('option'); o.value=n; o.textContent=n; selNote.appendChild(o); });

  const labOct = document.createElement('label'); labOct.textContent = 'Oitava:';
  const selOct = document.createElement('selec
