'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  adaptarFundo,
  blobs,
  borrar,
  brilhoMedio,
  contarDedos,
  extrairRGB,
  mascaraDiferenca,
} from './deteccao';

const TAM_PROC = 220;            // recorte quadrado em volta do alvo, em pixels
const FOLGA = 1.12;              // recorte cobre 1,12× o raio do alvo
const RAIO_UTIL = 1.06;          // fora disso é borda amarela (0 pts): nem olha
const INTERVALO_MS = 150;        // ~6,5 análises por segundo
const FRAMES_ESTAVEIS = 5;       // ~0,75s com o mesmo blob parado
const FRAMES_AQUECIMENTO = 12;   // ~2s para exposição/foco assentarem
const MUDANCA_GLOBAL = 0.035;    // >3,5% do alvo mudou de uma vez = luz/tremida
const ADAPTA_FUNDO = 0.04;       // velocidade com que o fundo segue a luz
const PAUSA_ENTRE_DARDOS_MS = 1200;
const ESPERA_POS_MAO_MS = 1500;  // ignora o alvo logo depois de ver uma mão
const GESTO_MS = 800;            // tempo segurando o gesto
const GESTO_PAUSA_MS = 2500;     // intervalo entre trocas

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
  const [limiar, setLimiar] = useState(40);
  const [ruido, setRuido] = useState(0);
  const [telaPreta, setTelaPreta] = useState(false);
  const [gestosOk, setGestosOk] = useState(false);
  const [trava, setTrava] = useState('');

  const ref = useRef({
    fundo: null,
    atual: null,
    tmp: null,
    mascara: null,
    aquecendo: 0,
    dardos: [],        // já pontuados { x, y } no recorte + { nx, ny } no vídeo
    candidato: null,   // { x, y, n }
    ultimoAcerto: 0,
    ultimaMao: 0,
    gestoAtual: 0,
    gestoDesde: 0,
    ultimaTroca: 0,
    track: null,
    travaCheck: null,  // { brilho, frames } enquanto confere a trava de exposição
    calib: null,
    limiar: 40,
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

  const reiniciarFundo = useCallback((msg) => {
    const r = ref.current;
    r.fundo = null;
    r.dardos = [];
    r.candidato = null;
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

  // Trava exposição/balanço de branco/foco no valor atual, se o aparelho deixar.
  // O ajuste automático é o que mais gera "dardo fantasma" com o alvo vazio.
  const travarCamera = useCallback(async (travar) => {
    const track = ref.current.track;
    if (!track?.getCapabilities) { setTrava('sem suporte'); return; }
    const caps = track.getCapabilities();
    const modo = (chave, alvo) => (caps[chave]?.includes?.(alvo) ? alvo : undefined);
    const alvo = travar ? 'manual' : 'continuous';
    const adv = {};
    const exp = modo('exposureMode', alvo);
    const wb = modo('whiteBalanceMode', alvo);
    const foco = modo('focusMode', alvo);
    if (exp) adv.exposureMode = exp;
    if (wb) adv.whiteBalanceMode = wb;
    if (foco) adv.focusMode = foco;
    if (!Object.keys(adv).length) { setTrava('sem suporte'); return; }
    try {
      await track.applyConstraints({ advanced: [adv] });
      setTrava(travar ? 'travada' : 'automática');
      reiniciarFundo();
    } catch {
      setTrava('sem suporte');
    }
  }, [reiniciarFundo]);

  // --- câmera ---
  const ligarCamera = useCallback(async () => {
    setErro('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } },
        audio: false,
      });
      video.current.srcObject = stream;
      ref.current.track = stream.getVideoTracks()[0];
      await video.current.play();
      setStatus(calib ? 'Ajustando câmera…' : 'Toque no CENTRO do alvo');
      setPasso(calib ? 'rodando' : 'centro');
      try { await navigator.wakeLock?.request('screen'); } catch { /* ignora */ }
      // espera a exposição automática assentar e então trava
      setTimeout(() => { ref.current.travaCheck = { brilho: null, frames: 0 }; }, 2500);
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
      const lado = r.calib.r * vw * FOLGA * 2;
      const sx = r.calib.cx * vw - lado / 2;
      const sy = r.calib.cy * vh - lado / 2;
      const N = TAM_PROC;

      if (c.width !== N) {
        c.width = N;
        c.height = N;
      }
      if (!r.atual || r.atual.length !== N * N * 3) {
        r.atual = new Float32Array(N * N * 3);
        r.tmp = new Float32Array(N * N * 3);
        r.mascara = new Uint8Array(N * N);
        r.fundo = null;
      }

      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, N, N);
      ctx.drawImage(v, sx, sy, lado, lado, 0, 0, N, N);
      extrairRGB(ctx.getImageData(0, 0, N, N), r.atual);
      borrar(r.atual, r.tmp, N, N);

      // confere se travar a exposição não estragou a imagem
      if (r.travaCheck) {
        const b = brilhoMedio(r.atual);
        if (r.travaCheck.brilho === null) {
          r.travaCheck.brilho = b;
          travarCamera(true);
        } else if (++r.travaCheck.frames >= 8) {
          if (Math.abs(b - r.travaCheck.brilho) > r.travaCheck.brilho * 0.25) {
            travarCamera(false);
          }
          r.travaCheck = null;
        }
      }

      if (!r.fundo) {
        r.fundo = Float32Array.from(r.atual);
        r.dardos = [];
        r.candidato = null;
        r.aquecendo = FRAMES_AQUECIMENTO;
        setStatus('Ajustando câmera…');
        return;
      }
      if (r.aquecendo > 0) {
        r.fundo.set(r.atual);
        if (--r.aquecendo === 0) setStatus('Pronto — pode jogar');
        return;
      }

      // mão na frente do alvo: nada é dardo
      if (Date.now() - r.ultimaMao < ESPERA_POS_MAO_MS) {
        r.candidato = null;
        return;
      }

      const centro = { x: N / 2, y: N / 2 };
      const raio = N / 2 / FOLGA;
      const { mudados, total } = mascaraDiferenca(
        r.atual, r.fundo, N, N, centro, raio * RAIO_UTIL, r.limiar, r.mascara
      );
      const fracao = total ? mudados / total : 0;
      setRuido(fracao);

      // muita coisa mudou de uma vez: é luz, exposição ou o celular mexeu
      if (fracao > MUDANCA_GLOBAL) {
        r.fundo.set(r.atual);
        r.candidato = null;
        setStatus('Mudança de luz/câmera — fundo atualizado');
        return;
      }

      adaptarFundo(r.fundo, r.atual, r.mascara, ADAPTA_FUNDO);

      // a cruz do dardo ocupa ~0,15 do raio; ruído de textura fica bem abaixo
      const areaMin = Math.max(10, Math.round(raio * raio * 0.002));
      const areaMax = Math.round(raio * raio * 0.06);
      const lista = blobs(r.mascara, N, N, areaMin, areaMax);
      const novo = lista.find(
        (b) => !r.dardos.some((d) => Math.hypot(d.x - b.x, d.y - b.y) < raio * 0.1)
      );

      if (!novo) {
        r.candidato = null;
        return;
      }
      if (r.candidato && Math.hypot(r.candidato.x - novo.x, r.candidato.y - novo.y) < raio * 0.04) {
        r.candidato.n += 1;
      } else {
        r.candidato = { x: novo.x, y: novo.y, n: 1 };
      }
      if (r.candidato.n < FRAMES_ESTAVEIS) return;
      if (Date.now() - r.ultimoAcerto < PAUSA_ENTRE_DARDOS_MS) return;

      // dardo confirmado
      const dist = Math.hypot(novo.x - centro.x, novo.y - centro.y) / raio;
      const aneis = r.estado?.aneis || [];
      let pontos = 0;
      let anel = 'Fora';
      for (const a of [...aneis].sort((x, y) => x.raio - y.raio)) {
        if (dist <= a.raio) { pontos = a.pontos; anel = a.nome; break; }
      }
      r.dardos.push({
        x: novo.x,
        y: novo.y,
        nx: (sx + (novo.x / N) * lado) / vw,
        ny: (sy + (novo.y / N) * lado) / vh,
      });
      r.candidato = null;
      r.ultimoAcerto = Date.now();
      r.fundo.set(r.atual); // o dardo passa a ser fundo
      enviar({ tipo: 'acerto', pontos, anel, origem: 'camera' });
      setStatus(`${anel}: ${pontos} pts`);
      if (navigator.vibrate) navigator.vibrate(60);
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
      const aneis = estado?.aneis || [];
      ctx.lineWidth = 2;
      for (const a of aneis) {
        ctx.strokeStyle = a.cor === '#1d1d1d' ? '#ffffff' : a.cor || '#f2c500';
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.arc(cx, cy, raio * a.raio, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#2fbf71';
      for (const d of ref.current.dardos) {
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
  const corRuido = ruido > MUDANCA_GLOBAL ? 'var(--vermelho)' : ruido > 0.01 ? 'var(--amarelo)' : 'var(--verde)';

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
        </div>
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

      <p className="fraco" style={{ fontSize: 13, margin: 0, lineHeight: 1.5 }}>
        Com o alvo vazio, o <b>Ruído</b> deve ficar verde (abaixo de 1%). Se ficar amarelo, aumente a
        sensibilidade. O Android pausa a câmera se a tela apagar — use o <b>modo tela preta</b> com o brilho
        no mínimo. Mantenha o celular imóvel: qualquer tranco exige recalibrar.
      </p>
    </main>
  );
}
