'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { borrar, brilhoMedio, CONFIG_PADRAO, contarDedos, criarDetector, extrairRGB } from './deteccao';

const TAM_PROC = 220;            // recorte quadrado em volta do alvo, em pixels
const INTERVALO_MS = 150;        // ~6,5 análises por segundo
const ESPERA_POS_MAO_MS = 1500;  // ignora o alvo logo depois de ver uma mão
const GESTO_MS = 800;            // tempo segurando o gesto
const GESTO_PAUSA_MS = 2500;     // intervalo entre trocas
const RAIO_MIN_PX = 70;          // abaixo disso o dardo fica pequeno demais na imagem

const MOTIVOS = {
  aquecendo: 'Ajustando câmera…',
  movendo: 'Alvo se mexendo — esperando parar',
  mao: 'Mão na frente — pausado',
  luz: 'Mudança de luz — conferindo',
  nada: 'Pronto — pode jogar',
  candidato: 'Possível dardo… confirmando',
};

function lerSalvo(chave) {
  try {
    const v = localStorage.getItem(chave);
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}

function salvar(chave, valor) {
  try { localStorage.setItem(chave, JSON.stringify(valor)); } catch { /* ignora */ }
}

export default function Camera() {
  const video = useRef(null);
  const overlay = useRef(null);
  const proc = useRef(null);
  const debug = useRef(null);

  const [estado, setEstado] = useState(null);
  const [erro, setErro] = useState('');
  const [status, setStatus] = useState('Toque em "Ligar câmera"');
  const [calib, setCalib] = useState(null);     // { cx, cy, r } normalizado
  const [passo, setPasso] = useState('parado'); // parado | centro | borda | rodando
  const [dedos, setDedos] = useState(0);
  const [maoAtiva, setMaoAtiva] = useState(false);
  const [limiar, setLimiar] = useState(40);
  const [diag, setDiag] = useState(null);
  const [verDiag, setVerDiag] = useState(false);
  const [telaPreta, setTelaPreta] = useState(false);
  const [gestosOk, setGestosOk] = useState(false);
  const [trava, setTrava] = useState('');
  const [zoomCaps, setZoomCaps] = useState(null);
  const [zoom, setZoom] = useState(null);

  const ref = useRef({
    detector: criarDetector(TAM_PROC),
    atual: new Float32Array(TAM_PROC * TAM_PROC * 3),
    tmp: new Float32Array(TAM_PROC * TAM_PROC * 3),
    dardosVideo: [],   // posições pontuadas, normalizadas no vídeo, para o overlay
    ultimaMao: 0,
    gestoAtual: 0,
    gestoDesde: 0,
    ultimaTroca: 0,
    track: null,
    travaCheck: null,  // { brilho, frames } enquanto confere a trava de exposição
    calib: null,
    limiar: 40,
    estado: null,
    verDiag: false,
  });

  ref.current.calib = calib;
  ref.current.limiar = limiar;
  ref.current.estado = estado;
  ref.current.verDiag = verDiag;

  const enviar = useCallback(async (acao) => {
    try {
      const r = await fetch('/api/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(acao),
      });
      setEstado(await r.json());
    } catch {
      setErro('Falha ao falar com o servidor');
    }
  }, []);

  const reiniciarFundo = useCallback((msg) => {
    ref.current.detector.reiniciar();
    ref.current.dardosVideo = [];
    if (msg) setStatus(msg);
  }, []);

  // --- placar (para mostrar o jogador atual no celular) ---
  useEffect(() => {
    let vivo = true;
    const buscar = async () => {
      try {
        const r = await fetch('/api/state', { cache: 'no-store' });
        const novo = await r.json();
        if (vivo) setEstado(novo);
      } catch { /* ignora */ }
    };
    buscar();
    const id = setInterval(buscar, 1500);
    return () => { vivo = false; clearInterval(id); };
  }, []);

  // --- calibração salva ---
  useEffect(() => {
    const salvo = lerSalvo('dardos:calib');
    if (salvo) setCalib(salvo);
  }, []);

  useEffect(() => {
    if (calib) salvar('dardos:calib', calib);
  }, [calib]);

  // Trava exposição/balanço de branco/foco no valor atual, se o aparelho deixar.
  const travarCamera = useCallback(async (travar) => {
    const track = ref.current.track;
    if (!track?.getCapabilities) { setTrava('sem suporte'); return; }
    const caps = track.getCapabilities();
    const alvo = travar ? 'manual' : 'continuous';
    const adv = {};
    for (const chave of ['exposureMode', 'whiteBalanceMode', 'focusMode']) {
      if (caps[chave]?.includes?.(alvo)) adv[chave] = alvo;
    }
    if (!Object.keys(adv).length) { setTrava('sem suporte'); return; }
    try {
      await track.applyConstraints({ advanced: [adv] });
      setTrava(travar ? 'travada' : 'automática');
      reiniciarFundo();
    } catch {
      setTrava('sem suporte');
    }
  }, [reiniciarFundo]);

  const aplicarZoom = useCallback(async (valor, recalibrar) => {
    const track = ref.current.track;
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ zoom: valor }] });
      setZoom(valor);
      salvar('dardos:zoom', valor);
      if (recalibrar) {
        setPasso('centro');
        setStatus('Zoom mudou — toque no CENTRO do alvo');
      }
    } catch { /* aparelho recusou */ }
  }, []);

  // --- câmera ---
  const ligarCamera = useCallback(async () => {
    setErro('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      video.current.srcObject = stream;
      const track = stream.getVideoTracks()[0];
      ref.current.track = track;
      await video.current.play();

      const caps = track.getCapabilities?.() || {};
      if (caps.zoom && caps.zoom.max > caps.zoom.min) {
        setZoomCaps(caps.zoom);
        const z = lerSalvo('dardos:zoom');
        if (z) await aplicarZoom(z, false);
        else setZoom(track.getSettings?.().zoom ?? caps.zoom.min);
      }

      setStatus(calib ? 'Ajustando câmera…' : 'Toque no CENTRO do alvo');
      setPasso(calib ? 'rodando' : 'centro');
      try { await navigator.wakeLock?.request('screen'); } catch { /* ignora */ }
      // espera a exposição automática assentar e então trava
      setTimeout(() => { ref.current.travaCheck = { brilho: null, frames: 0 }; }, 2500);
    } catch (e) {
      setErro('Não consegui abrir a câmera: ' + e.message + ' (precisa ser HTTPS)');
    }
  }, [calib, aplicarZoom]);

  // --- MediaPipe: mãos ---
  useEffect(() => {
    let parar = false;
    let landmarker = null;
    let raf = 0;

    (async () => {
      try {
        const { FilesetResolver, HandLandmarker } = await import('@mediapipe/tasks-vision');
        const fileset = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
        );
        landmarker = await HandLandmarker.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath:
              'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          numHands: 1,
        });
        if (parar) return;
        setGestosOk(true);

        let ultimo = 0;
        const laco = () => {
          raf = requestAnimationFrame(laco);
          const v = video.current;
          if (!v || v.readyState < 2) return;
          const agora = performance.now();
          if (agora - ultimo < 100) return;
          ultimo = agora;

          const res = landmarker.detectForVideo(v, agora);
          const marcos = res.landmarks?.[0];
          const temMao = !!marcos;
          setMaoAtiva(temMao);
          if (temMao) ref.current.ultimaMao = Date.now();

          const n = temMao ? contarDedos(marcos) : -1;
          setDedos(n < 0 ? 0 : n);

          const r = ref.current;
          if (n !== r.gestoAtual) {
            r.gestoAtual = n;
            r.gestoDesde = agora;
            return;
          }
          if (agora - r.gestoDesde < GESTO_MS) return;
          if (agora - r.ultimaTroca < GESTO_PAUSA_MS) return;

          const est = r.estado;
          if (n >= 1 && n <= 4 && est && n - 1 < est.jogadores.length) {
            if (est.atual !== n - 1) {
              r.ultimaTroca = agora;
              enviar({ tipo: 'jogador', indice: n - 1 });
              setStatus(`Jogador ${n} selecionado`);
            }
          } else if (n === 0 && temMao && agora - r.gestoDesde > 1500) {
            r.ultimaTroca = agora;
            reiniciarFundo('Alvo limpo (fundo redefinido)');
          }
        };
        raf = requestAnimationFrame(laco);
      } catch (e) {
        setGestosOk(false);
        setErro('Gestos indisponíveis: ' + e.message);
      }
    })();

    return () => {
      parar = true;
      cancelAnimationFrame(raf);
      landmarker?.close?.();
    };
  }, [enviar, reiniciarFundo]);

  // --- detecção dos dardos ---
  useEffect(() => {
    if (passo !== 'rodando' || !calib) return;
    reiniciarFundo();

    const id = setInterval(() => {
      const v = video.current;
      const c = proc.current;
      const r = ref.current;
      if (!v || v.videoWidth === 0 || !c) return;

      // recorte quadrado em volta do alvo, na resolução cheia do vídeo
      const vw = v.videoWidth;
      const vh = v.videoHeight;
      const N = TAM_PROC;
      const lado = r.calib.r * vw * CONFIG_PADRAO.folga * 2;
      const sx = r.calib.cx * vw - lado / 2;
      const sy = r.calib.cy * vh - lado / 2;

      if (c.width !== N) {
        c.width = N;
        c.height = N;
      }
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, N, N);
      ctx.drawImage(v, sx, sy, lado, lado, 0, 0, N, N);
      const img = ctx.getImageData(0, 0, N, N);
      extrairRGB(img, r.atual);
      borrar(r.atual, r.tmp, N, N);

      // confere se travar a exposição não estragou a imagem
      if (r.travaCheck) {
        const b = brilhoMedio(r.atual);
        if (r.travaCheck.brilho === null) {
          r.travaCheck.brilho = b;
          travarCamera(true);
        } else if (++r.travaCheck.frames >= 8) {
          if (Math.abs(b - r.travaCheck.brilho) > r.travaCheck.brilho * 0.25) travarCamera(false);
          r.travaCheck = null;
        }
      }

      const ev = r.detector.processar(r.atual, {
        agora: Date.now(),
        maoRecente: Date.now() - r.ultimaMao < ESPERA_POS_MAO_MS,
        limiar: r.limiar,
        aneis: r.estado?.aneis || [],
      });

      const raioPx = Math.round(r.calib.r * vw);
      setDiag({ ...ev, res: `${vw}×${vh}`, raioPx });

      if (r.verDiag && debug.current) desenharDiagnostico(debug.current, img, r.detector);

      if (ev.tipo === 'acerto') {
        r.dardosVideo.push({ nx: (sx + (ev.x / N) * lado) / vw, ny: (sy + (ev.y / N) * lado) / vh });
        enviar({ tipo: 'acerto', pontos: ev.pontos, anel: ev.anel, origem: 'camera' });
        setStatus(`${ev.anel}: ${ev.pontos} pts`);
        if (navigator.vibrate) navigator.vibrate(60);
      } else if (ev.tipo === 'nada' && raioPx < RAIO_MIN_PX) {
        setStatus('Alvo pequeno na imagem — aproxime o celular ou use o zoom');
      } else if (ev.tipo !== 'candidato' || ev.n === 1) {
        setStatus(ev.tipo === 'luz' && ev.trocouFundo ? 'Luz mudou — fundo atualizado' : MOTIVOS[ev.tipo]);
      }
    }, INTERVALO_MS);
    return () => clearInterval(id);
  }, [passo, calib, enviar, reiniciarFundo, travarCamera]);

  // --- desenho do overlay ---
  useEffect(() => {
    let raf = 0;
    const desenhar = () => {
      raf = requestAnimationFrame(desenhar);
      const cv = overlay.current;
      const v = video.current;
      if (!cv || !v) return;
      const rect = v.getBoundingClientRect();
      if (rect.width === 0) return;
      const dpr = window.devicePixelRatio || 1;
      if (cv.width !== Math.round(rect.width * dpr)) {
        cv.width = Math.round(rect.width * dpr);
        cv.height = Math.round(rect.height * dpr);
      }
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      if (!calib) return;

      const cx = calib.cx * rect.width;
      const cy = calib.cy * rect.height;
      const raio = calib.r * rect.width;
      ctx.lineWidth = 2;
      for (const a of estado?.aneis || []) {
        ctx.strokeStyle = a.cor === '#1d1d1d' ? '#ffffff' : a.cor || '#f2c500';
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.arc(cx, cy, raio * a.raio, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#2fbf71';
      for (const d of ref.current.dardosVideo) {
        ctx.beginPath();
        ctx.arc(d.nx * rect.width, d.ny * rect.height, 6, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    raf = requestAnimationFrame(desenhar);
    return () => cancelAnimationFrame(raf);
  }, [calib, estado]);

  const tocar = (ev) => {
    if (passo !== 'centro' && passo !== 'borda') return;
    const rect = ev.currentTarget.getBoundingClientRect();
    const nx = (ev.clientX - rect.left) / rect.width;
    const ny = (ev.clientY - rect.top) / rect.height;
    if (passo === 'centro') {
      setCalib({ cx: nx, cy: ny, r: 0.05 });
      setPasso('borda');
      setStatus('Agora toque na BORDA externa do círculo preto');
    } else {
      setCalib((c) => {
        const dx = nx - c.cx;
        const dy = (ny - c.cy) * (rect.height / rect.width);
        return { ...c, r: Math.max(0.02, Math.hypot(dx, dy)) };
      });
      setPasso('rodando');
      setStatus('Calibrado. Ajustando câmera…');
    }
  };

  const jogadorAtual = estado?.jogadores?.[estado.atual];
  const ruido = diag?.ruido || 0;
  const corRuido = ruido > CONFIG_PADRAO.mudancaGlobal ? 'var(--vermelho)' : ruido > 0.01 ? 'var(--amarelo)' : 'var(--verde)';

  return (
    <main style={{ padding: 12, display: 'grid', gap: 12, maxWidth: 680, margin: '0 auto' }}>
      {telaPreta && (
        <div
          onDoubleClick={() => setTelaPreta(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: '#000',
            zIndex: 50,
            display: 'grid',
            placeItems: 'center',
            color: '#111',
            fontSize: 12,
          }}
        >
          toque duas vezes para voltar
        </div>
      )}

      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ margin: 0, fontSize: 18 }}>📱 Câmera</h1>
        <span className="fraco" style={{ fontSize: 13 }}>
          {jogadorAtual ? `${jogadorAtual.nome} · ${jogadorAtual.pontos}` : '—'}
        </span>
      </header>

      <div style={{ position: 'relative', borderRadius: 14, overflow: 'hidden', background: '#000' }}>
        <video
          ref={video}
          playsInline
          muted
          onClick={tocar}
          style={{ width: '100%', height: 'auto', display: 'block' }}
        />
        <canvas
          ref={overlay}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
        />
      </div>
      <canvas ref={proc} style={{ display: 'none' }} />

      <div className="card" style={{ display: 'grid', gap: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, gap: 8 }}>
          <span>{status}</span>
          <span className="fraco">
            {maoAtiva ? `✋ ${dedos} dedo(s)` : gestosOk ? 'gestos prontos' : 'gestos off'}
          </span>
        </div>
        <div className="fraco" style={{ fontSize: 13, display: 'flex', justifyContent: 'space-between' }}>
          <span>
            Ruído: <b style={{ color: corRuido }}>{(ruido * 100).toFixed(1)}%</b>
          </span>
          <span>Exposição: {trava || '—'}</span>
        </div>
        {erro && <div style={{ color: 'var(--vermelho)', fontSize: 13 }}>{erro}</div>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {passo === 'parado' && (
            <button className="primario" onClick={ligarCamera}>Ligar câmera</button>
          )}
          <button onClick={() => { setPasso('centro'); setStatus('Toque no CENTRO do alvo'); }}>
            Calibrar alvo
          </button>
          <button onClick={() => reiniciarFundo('Fundo redefinido')}>Alvo limpo</button>
          <button onClick={() => enviar({ tipo: 'desfazer' })}>Desfazer</button>
          <button onClick={() => enviar({ tipo: 'proximo' })}>Próximo jogador</button>
          <button onClick={() => setTelaPreta(true)}>Modo tela preta</button>
          <button onClick={() => setVerDiag((d) => !d)}>{verDiag ? 'Fechar diagnóstico' : 'Diagnóstico'}</button>
        </div>
        {zoomCaps && zoom !== null && (
          <label style={{ fontSize: 13 }} className="fraco">
            Zoom: {Number(zoom).toFixed(1)}× (recalibra ao mudar)
            <input
              type="range"
              min={zoomCaps.min}
              max={zoomCaps.max}
              step={zoomCaps.step || 0.1}
              value={zoom}
              onChange={(e) => aplicarZoom(Number(e.target.value), true)}
              style={{ width: '100%' }}
            />
          </label>
        )}
        <label style={{ fontSize: 13 }} className="fraco">
          Sensibilidade (quanto menor, mais sensível): {limiar}
          <input
            type="range"
            min="15"
            max="90"
            value={limiar}
            onChange={(e) => setLimiar(Number(e.target.value))}
            style={{ width: '100%' }}
          />
        </label>
      </div>

      {verDiag && (
        <div className="card" style={{ display: 'grid', gap: 8, fontSize: 13 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <canvas
              ref={debug}
              width={TAM_PROC}
              height={TAM_PROC}
              style={{ width: 160, height: 160, borderRadius: 8, background: '#000', flexShrink: 0 }}
            />
            <div className="fraco" style={{ display: 'grid', gap: 4, fontVariantNumeric: 'tabular-nums' }}>
              <span>Estado: <b style={{ color: 'var(--txt)' }}>{diag?.tipo || '—'}</b></span>
              <span>Vídeo: {diag?.res || '—'}</span>
              <span>
                Raio do alvo: {diag?.raioPx ?? '—'} px{' '}
                {diag?.raioPx < RAIO_MIN_PX ? <b style={{ color: 'var(--vermelho)' }}>(pequeno)</b> : ''}
              </span>
              <span>Ruído: {(ruido * 100).toFixed(2)}%</span>
              <span>Deslocamento: {diag?.ox ?? 0}, {diag?.oy ?? 0}</span>
              <span>Maior mancha: {diag?.maiorArea ?? 0} px (mín. {diag?.areaMin ?? '—'})</span>
            </div>
          </div>
          <span className="fraco">Vermelho = pixels diferentes do fundo. Um dardo novo deve virar uma mancha vermelha.</span>
        </div>
      )}

      <p className="fraco" style={{ fontSize: 13, margin: 0, lineHeight: 1.5 }}>
        Com o alvo vazio, o <b>Ruído</b> deve ficar verde (abaixo de 1%). O Android pausa a câmera se a tela
        apagar — use o <b>modo tela preta</b> com o brilho no mínimo.
      </p>
    </main>
  );
}

function desenharDiagnostico(canvas, img, detector) {
  const ctx = canvas.getContext('2d');
  const saida = ctx.createImageData(img.width, img.height);
  const m = detector.mascara;
  for (let i = 0, p = 0; i < m.length; i++, p += 4) {
    if (m[i]) {
      saida.data[p] = 255;
      saida.data[p + 1] = 40;
      saida.data[p + 2] = 40;
    } else {
      saida.data[p] = img.data[p] * 0.7;
      saida.data[p + 1] = img.data[p + 1] * 0.7;
      saida.data[p + 2] = img.data[p + 2] * 0.7;
    }
    saida.data[p + 3] = 255;
  }
  ctx.putImageData(saida, 0, 0);
  ctx.strokeStyle = 'rgba(255,255,255,.6)';
  ctx.beginPath();
  ctx.arc(detector.centro.x, detector.centro.y, detector.raio, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#2fbf71';
  for (const d of detector.estado.dardos) {
    ctx.beginPath();
    ctx.arc(d.x, d.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}
