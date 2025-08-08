// ==== UI refs
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

// teclado (12 notas)
const NAMES = ["C","C♯","D","D♯","E","F","F♯","G","G♯","A","A♯","B"];
NAMES.forEach(n=>{
  const d=document.createElement('div');
  const sharp = n.includes('♯');
  d.className='key';
  d.style.background = sharp ? '#111' : '#fff';
  d.style.color = sharp ? '#fff' : '#000';
  d.textContent = n;
  kbd.appendChild(d);
});

// ==== Estado
let A4REF = 440;
let ctx=null, analyser=null, srcNode=null, gainNode=null, stream=null, raf=null, buf=null;

// ==== Utils
const dBtoLinear = db => Math.pow(10, db/20);
const freqToData = f => {
  if (!f || !isFinite(f)) return null;
  const n = Math.round(12 * Math.log2(f / A4REF)) + 69;
  const note = NAMES[n % 12];
  const octave = Math.floor(n / 12) - 1;
  const refFreq = A4REF * Math.pow(2, (n - 69) / 12);
  const cents = Math.round(1200 * Math.log2(f / refFreq));
  return {note, octave, cents, refFreq, midi:n};
};
const voiceRange = () => {
  const v = voiceSel.value;
  if (v==='bass') return [50, 400];
  if (v==='soprano') return [150,1200];
  return [70,900];
};

// Autocorrelação simples
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

// ==== UI handlers
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
    errEl.textContent = 'Erro listando mics: ' + e.message;
  }
}

// pede permissão rápida para liberar labels e enumerar
navigator.mediaDevices?.getUserMedia({audio:true}).then(s=>{
  s.getTracks().forEach(t=>t.stop());
  return listMics();
}).catch(()=>listMics());

async function start(){
  errEl.textContent = '';
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
    analyser = ctx.createAnalyser(); analyser.fftSize = 4096; analyser.smoothingTimeConstant = 0.85;

    srcNode.connect(gainNode).connect(analyser);
    buf = new Float32Array(analyser.fftSize);

    msg.textContent = "Ouvindo… cante 'laaa' perto do microfone.";
    loop();
  }catch(e){
    console.error(e);
    setButtons(false);
    msg.textContent = "Erro ao iniciar. Veja abaixo.";
    errEl.textContent =
      (e.name === 'NotAllowedError') ? "Permissão negada. Clique no cadeado da barra e permita o microfone."
    : (e.name === 'NotFoundError')  ? "Nenhum microfone encontrado. Conecte um e clique em Atualizar mics."
    : (e.name === 'NotReadableError') ? "Outro app está usando o microfone. Feche Zoom/Meet/Discord e tente de novo."
    : `Falhou getUserMedia: ${e.name} – ${e.message}`;
  }
}

function stop(){
  cancelAnimationFrame(raf);
  if (stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; }
  if (ctx){ ctx.close(); ctx=null; }
  msg.textContent = "Parado.";
  setButtons(false);
}

function loop(){
  if (!analyser || !ctx) return;
  analyser.getFloatTimeDomainData(buf);

  const [minF, maxF] = voiceRange();
  const {freq, rms} = detectPitch(buf, ctx.sampleRate, minF, maxF, 0.008);

  rmsOut.textContent = (rms||0).toFixed(3);
  fill.style.width = `${Math.min(100, Math.max(0, (rms||0)*400))}%`;

  if (freq){
    const data = freqToData(freq);
    if (data){
      noteEl.textContent = `${data.note}${data.octave}`;
      noteEl.style.textShadow = Math.abs(data.cents)<=5 ? "0 0 22px var(--neon)" : "0 0 10px var(--mag)";
      freqEl.textContent = `${freq.toFixed(1)} Hz · alvo ${data.refFreq.toFixed(1)} Hz`;
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
    }
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
  raf = requestAnimationFrame(loop);
}
