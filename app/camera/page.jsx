'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { blobs, cinza, contarDedos, mascaraDiferenca } from './deteccao';

const LARG_PROC = 240;          // largura da imagem de processamento
const INTERVALO_MS = 150;       // ~6,5 análises por segundo
const FRAMES_ESTAVEIS = 3;      // quadros seguidos com o mesmo blob
const ESPERA_POS_MAO_MS = 1500; // ignora o alvo logo depois de ver uma mão
const GESTO_MS = 800;           // tempo segurando o gesto
const GESTO_PAUSA_MS = 2500;    // intervalo entre trocas

export default function Camera() {
  const video = useRef(null);
  const overlay = useRef(null);
  const proc = useRef(null);

  const [estado, setEstado] = useState(null);
  const [erro, setErro] = useState('');
  const [status, setStatus] = useState('Toque em "Ligar câmera"');
  const [calib, setCalib] = useState(null);     // { cx, cy, r } normalizado
  const [passo, setPasso] = useState('parado'); // parado | centro | borda | rodando
  const [dedos, setDedos] = useState(0);
  const [maoAtiva, setMaoAtiva] = useState(false);
  const [limiar, setLimiar] = useState(38);
  const [telaPreta, setTelaPreta] = useState(false);
  const [gestosOk, setGestosOk] = useState(false);

  const ref = useRef({
    fundo: null,
    cinzaAtual: null,
    mascara: null,
    larg: 0,
    alt: 0,
    dardos: [],        // blobs já pontuados { x, y }
    candidato: null,   // { x, y, n }
    ultimaMao: 0,
    gestoAtual: 0,
    gestoDesde: 0,
    ultimaTroca: 0,
    calib: null,
    limiar: 38,
    estado: null,
  });

  ref.current.calib = calib;
  ref.current.limiar = limiar;
  ref.current.estado = estado;

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
    try {
      const salvo = localStorage.getItem('dardos:calib');
      if (salvo) setCalib(JSON.parse(salvo));
    } catch { /* ignora */ }
  }, []);

  useEffect(() => {
    if (calib) {
      try { localStorage.setItem('dardos:calib', JSON.stringify(calib)); } catch { /* ignora */ }
    }
  }, [calib]);

  // --- câmera ---
  const ligarCamera = useCallback(async () => {
    setErro('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
        audio: false,
      });
      video.current.srcObject = stream;
      await video.current.play();
      setStatus(calib ? 'Rodando' : 'Toque no CENTRO do alvo');
      setPasso(calib ? 'rodando' : 'centro');
      try { await navigator.wakeLock?.request('screen'); } catch { /* ignora */ }
    } catch (e) {
      setErro('Não consegui abrir a câmera: ' + e.message + ' (precisa ser HTTPS)');
    }
  }, [calib]);

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
            r.fundo = null;
            r.dardos = [];
            setStatus('Alvo limpo (fundo redefinido)');
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
  }, [enviar]);

  // --- detecção dos dardos ---
  useEffect(() => {
    if (passo !== 'rodando' || !calib) return;
    const id = setInterval(() => {
      const v = video.current;
      const c = proc.current;
      const r = ref.current;
      if (!v || v.videoWidth === 0 || !c) return;

      const larg = LARG_PROC;
      const alt = Math.round((v.videoHeight / v.videoWidth) * LARG_PROC);
      if (c.width !== larg || c.height !== alt) {
        c.width = larg;
        c.height = alt;
        r.fundo = null;
      }
      if (r.larg !== larg || r.alt !== alt || !r.cinzaAtual) {
        r.larg = larg;
        r.alt = alt;
        r.cinzaAtual = new Float32Array(larg * alt);
        r.mascara = new Uint8Array(larg * alt);
        r.fundo = null;
      }

      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(v, 0, 0, larg, alt);
      const img = ctx.getImageData(0, 0, larg, alt);
      cinza(img, r.cinzaAtual);

      if (!r.fundo) {
        r.fundo = Float32Array.from(r.cinzaAtual);
        r.dardos = [];
        setStatus('Fundo capturado — pode jogar');
        return;
      }

      // mão na frente do alvo: nada é dardo
      if (Date.now() - r.ultimaMao < ESPERA_POS_MAO_MS) {
        r.candidato = null;
        return;
      }

      const centro = { x: r.calib.cx * larg, y: r.calib.cy * alt };
      const raio = r.calib.r * larg;
      const areaMin = Math.max(4, Math.round((larg / 240) * 5));
      const areaMax = Math.round(Math.PI * raio * raio * 0.25);

      mascaraDiferenca(r.cinzaAtual, r.fundo, larg, alt, centro, raio, r.limiar, r.mascara);
      const lista = blobs(r.mascara, larg, alt, areaMin, areaMax);
      const novo = lista.find(
        (b) => !r.dardos.some((d) => Math.hypot(d.x - b.x, d.y - b.y) < raio * 0.12 + 4)
      );

      if (!novo) {
        r.candidato = null;
        return;
      }
      if (r.candidato && Math.hypot(r.candidato.x - novo.x, r.candidato.y - novo.y) < 4) {
        r.candidato.n += 1;
        r.candidato.x = novo.x;
        r.candidato.y = novo.y;
      } else {
        r.candidato = { x: novo.x, y: novo.y, n: 1 };
      }
      if (r.candidato.n < FRAMES_ESTAVEIS) return;

      // dardo confirmado
      const dist = Math.hypot(novo.x - centro.x, novo.y - centro.y) / raio;
      const aneis = r.estado?.aneis || [];
      let pontos = 0;
      let anel = 'Fora';
      for (const a of [...aneis].sort((x, y) => x.raio - y.raio)) {
        if (dist <= a.raio) { pontos = a.pontos; anel = a.nome; break; }
      }
      r.dardos.push({ x: novo.x, y: novo.y });
      r.candidato = null;
      r.fundo = Float32Array.from(r.cinzaAtual); // o dardo passa a ser fundo
      enviar({ tipo: 'acerto', pontos, anel, origem: 'camera' });
      setStatus(`${anel}: ${pontos} pts`);
      if (navigator.vibrate) navigator.vibrate(60);
    }, INTERVALO_MS);
    return () => clearInterval(id);
  }, [passo, calib, enviar]);

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
      const aneis = estado?.aneis || [];
      ctx.lineWidth = 2;
      for (const a of aneis) {
        ctx.strokeStyle = a.cor || '#f2c500';
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.arc(cx, cy, raio * a.raio, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#2fbf71';
      for (const d of ref.current.dardos) {
        const px = (d.x / ref.current.larg) * rect.width;
        const py = (d.y / ref.current.alt) * rect.height;
        ctx.beginPath();
        ctx.arc(px, py, 6, 0, Math.PI * 2);
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
      setStatus('Agora toque na BORDA externa do alvo');
    } else {
      setCalib((c) => {
        const dx = (nx - c.cx) * 1;
        const dy = (ny - c.cy) * (rect.height / rect.width);
        return { ...c, r: Math.max(0.02, Math.hypot(dx, dy)) };
      });
      setPasso('rodando');
      ref.current.fundo = null;
      setStatus('Calibrado. Capturando fundo…');
    }
  };

  const jogadorAtual = estado?.jogadores?.[estado.atual];

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
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
          <span>{status}</span>
          <span className="fraco">
            {maoAtiva ? `✋ ${dedos} dedo(s)` : gestosOk ? 'gestos prontos' : 'gestos off'}
          </span>
        </div>
        {erro && <div style={{ color: 'var(--vermelho)', fontSize: 13 }}>{erro}</div>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {passo === 'parado' && (
            <button className="primario" onClick={ligarCamera}>Ligar câmera</button>
          )}
          <button onClick={() => { setPasso('centro'); setStatus('Toque no CENTRO do alvo'); }}>
            Calibrar alvo
          </button>
          <button onClick={() => { ref.current.fundo = null; ref.current.dardos = []; setStatus('Fundo redefinido'); }}>
            Alvo limpo
          </button>
          <button onClick={() => enviar({ tipo: 'desfazer' })}>Desfazer</button>
          <button onClick={() => enviar({ tipo: 'proximo' })}>Próximo jogador</button>
          <button onClick={() => setTelaPreta(true)}>Modo tela preta</button>
        </div>
        <label style={{ fontSize: 13 }} className="fraco">
          Sensibilidade (quanto menor, mais sensível): {limiar}
          <input
            type="range"
            min="15"
            max="80"
            value={limiar}
            onChange={(e) => setLimiar(Number(e.target.value))}
            style={{ width: '100%' }}
          />
        </label>
      </div>

      <p className="fraco" style={{ fontSize: 13, margin: 0, lineHeight: 1.5 }}>
        O Android pausa a câmera se a tela apagar ou você sair da aba — use o <b>modo tela preta</b> com o
        brilho no mínimo em vez de desligar a tela. Mantenha o celular imóvel: qualquer tranco exige
        recalibrar.
      </p>
    </main>
  );
}
