'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ajustarAlvo, borrar, brilhoMedio, CONFIG_PADRAO, contarDedos, criarDetector, extrairRGB } from './deteccao';

const TAM_PROC = 220;            // recorte quadrado em volta do alvo, em pixels
const INTERVALO_MS = 150;        // ~6,5 análises por segundo
const ESPERA_POS_MAO_MS = 1500;  // ignora o alvo logo depois de ver uma mão
const GESTO_MS = 800;            // tempo segurando o gesto
const GESTO_PAUSA_MS = 2500;     // intervalo entre trocas
const RAIO_MIN_PX = 70;          // abaixo disso o dardo fica pequeno demais na imagem
const LARG_CALIB = 480;          // resolução usada para achar o alvo pela cor
const RAZAO_FRONTAL = 0.94;      // elipse mais redonda que isso = celular de frente
const AVISO_SEM_DARDO_MS = 3500; // alvo balançou e nenhum dardo apareceu
const VERSAO = '2026-10-12';      // vai junto nos registros da caixa-preta

const novoId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// imagens da caixa-preta (JPEG pequeno do recorte do alvo)
function jpegDeImageData(img) {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d').putImageData(img, 0, 0);
  return c.toDataURL('image/jpeg', 0.82);
}
function jpegDeRGB(rgb, N) {
  const img = new ImageData(N, N);
  for (let i = 0, p = 0; i < N * N; i++, p += 3) {
    img.data[i * 4] = rgb[p];
    img.data[i * 4 + 1] = rgb[p + 1];
    img.data[i * 4 + 2] = rgb[p + 2];
    img.data[i * 4 + 3] = 255;
  }
  return jpegDeImageData(img);
}
function enviarRegistro(reg) {
  fetch('/api/registros', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reg),
  }).catch(() => { /* caixa-preta é melhor-esforço */ });
}

const MOTIVOS = {
  aquecendo: 'Ajustando câmera…',
  movendo: 'Alvo se mexendo — esperando parar',
  retirado: 'Dardo retirado',
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

// Calibração: elipse da borda do preto { cx, cy (0–1 do vídeo), a, b (fração da
// largura do vídeo), ang } + dir (ponta→aletas) quando o celular está de lado.
// Versões antigas guardavam só um círculo { cx, cy, r }.
function normalizarCalib(c) {
  if (!c) return null;
  if (typeof c.a === 'number') return c;
  if (typeof c.r === 'number') return { cx: c.cx, cy: c.cy, a: c.r, b: c.r, ang: 0, dir: null };
  return null;
}

function eixoCurto(c) {
  // o eixo curto da elipse é a direção em que os dardos "deitam" na imagem
  const ang = c.a >= c.b ? c.ang + Math.PI / 2 : c.ang;
  return { x: Math.cos(ang), y: Math.sin(ang) };
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
  const [passo, setPasso] = useState('parado'); // parado | centro | direcao | borda | rodando
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
    detector: null,
    movPendente: false, // alvo balançou e ainda não apareceu dardo
    ultimoMov: 0,
    atual: new Float32Array(TAM_PROC * TAM_PROC * 3),
    tmp: new Float32Array(TAM_PROC * TAM_PROC * 3),
    recorte: null,     // { sx, sy, lado, vw, vh } do último quadro, para o overlay
    ultimoImg: null,   // último recorte cru, para a caixa-preta
    manuaisVistos: null, // ids de lances manuais já registrados
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

  // Fila de envio: cada lance tem id, então reenviar depois de uma falha de rede
  // não conta o ponto duas vezes. A ordem é mantida.
  const fila = useRef([]);
  const despachando = useRef(false);
  const [pendentes, setPendentes] = useState(0);

  const despachar = useCallback(async () => {
    if (despachando.current) return;
    despachando.current = true;
    try {
      while (fila.current.length) {
        const acao = fila.current[0];
        try {
          const r = await fetch('/api/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(acao),
          });
          if (!r.ok) throw new Error(String(r.status));
          setEstado(await r.json());
          fila.current.shift();
          setErro('');
        } catch {
          setErro('Sem conexão com o placar — tentando de novo…');
          break;
        }
      }
    } finally {
      despachando.current = false;
      setPendentes(fila.current.length);
    }
  }, []);

  const enviar = useCallback((acao) => {
    fila.current.push({ id: novoId(), ...acao });
    setPendentes(fila.current.length);
    despachar();
  }, [despachar]);

  useEffect(() => {
    const id = setInterval(despachar, 2000);
    return () => clearInterval(id);
  }, [despachar]);

  const reiniciarFundo = useCallback((msg) => {
    ref.current.detector?.reiniciar();
    ref.current.movPendente = false;
    if (msg) setStatus(msg);
  }, []);

  // --- placar (para mostrar o jogador atual no celular) ---
  useEffect(() => {
    let vivo = true;
    const buscar = async () => {
      try {
        const r = await fetch('/api/state', { cache: 'no-store' });
        const novo = await r.json();
        if (!vivo) return;
        setEstado(novo);
        registrarFaltas(novo);
      } catch { /* ignora */ }
    };
    // Ponto somado à mão no placar = dardo que a câmera não contou. Guarda o que
    // a câmera estava vendo, para descobrir por quê.
    const registrarFaltas = (est) => {
      const r = ref.current;
      const manuais = (est.historico || []).filter((h) => h.origem === 'manual' && h.id);
      if (!r.manuaisVistos) {
        r.manuaisVistos = new Set(manuais.map((h) => h.id)); // os antigos não contam
        return;
      }
      for (const h of manuais) {
        if (r.manuaisVistos.has(h.id)) continue;
        r.manuaisVistos.add(h.id);
        const det = r.detector;
        if (!det?.estado.fundo || !r.ultimoImg) continue;
        enviarRegistro({
          id: `f-${h.id}`,
          tipo: 'faltou',
          meta: {
            lance: h.id, pontos: h.pontos, anel: h.anel, geom: det.geom, limiar: r.limiar,
            dardosNaMemoria: det.estado.dardos.length, versao: VERSAO,
          },
          antes: jpegDeRGB(det.estado.fundo, TAM_PROC),
          depois: jpegDeImageData(r.ultimoImg),
        });
      }
    };
    buscar();
    const id = setInterval(buscar, 1500);
    return () => { vivo = false; clearInterval(id); };
  }, []);

  // --- calibração salva ---
  useEffect(() => {
    const salvo = normalizarCalib(lerSalvo('dardos:calib'));
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
          if (temMao) {
            // Mão longe do alvo (alguém fazendo o gesto de trocar jogador) não
            // pausa a detecção; mão perto do alvo (tirando dardos) pausa.
            const c = ref.current.calib;
            let perto = true;
            if (c && v.videoWidth) {
              const xs = marcos.map((m) => m.x);
              const ys = marcos.map((m) => m.y);
              const A = Math.max(c.a, c.b) * 1.6;
              const Ay = (A * v.videoWidth) / v.videoHeight;
              perto = !(Math.max(...xs) < c.cx - A || Math.min(...xs) > c.cx + A ||
                Math.max(...ys) < c.cy - Ay || Math.min(...ys) > c.cy + Ay);
            }
            if (perto) ref.current.ultimaMao = Date.now();
          }

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
    let detector = null;
    let geoLado = 0;
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
      const lado = Math.max(r.calib.a, r.calib.b) * vw * CONFIG_PADRAO.folga * 2;
      const sx = r.calib.cx * vw - lado / 2;
      const sy = r.calib.cy * vh - lado / 2;
      if (!detector || geoLado !== lado) {
        const k = (vw * N) / lado; // fração da largura do vídeo → px do recorte
        detector = criarDetector(N, {
          cx: N / 2,
          cy: N / 2,
          a: r.calib.a * k,
          b: r.calib.b * k,
          ang: r.calib.ang,
          dir: r.calib.dir || null,
        });
        geoLado = lado;
        r.detector = detector;
      }

      if (c.width !== N) {
        c.width = N;
        c.height = N;
      }
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, N, N);
      ctx.drawImage(v, sx, sy, lado, lado, 0, 0, N, N);
      const img = ctx.getImageData(0, 0, N, N);
      r.ultimoImg = img;
      r.recorte = { sx, sy, lado, vw, vh };
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

      const ev = detector.processar(r.atual, {
        agora: Date.now(),
        maoRecente: Date.now() - r.ultimaMao < ESPERA_POS_MAO_MS,
        limiar: r.limiar,
        aneis: r.estado?.aneis || [],
      });

      const raioPx = Math.round(Math.sqrt(r.calib.a * r.calib.b) * vw);
      setDiag({ ...ev, res: `${vw}×${vh}`, raioPx });

      if (r.verDiag && debug.current) desenharDiagnostico(debug.current, img, detector);

      // alvo balançou (dardo bateu?) mas nenhum dardo apareceu depois de assentar:
      // é o que acontece com dardo vermelho na mosca vermelha, que a câmera não enxerga
      const agoraMs = Date.now();
      if (ev.tipo === 'movendo' && ev.real) {
        r.movPendente = true;
        r.ultimoMov = agoraMs;
      } else if (['mao', 'acerto', 'luz', 'retirado'].includes(ev.tipo)) {
        r.movPendente = false;
      } else if (r.movPendente && ev.tipo === 'nada' && agoraMs - r.ultimoMov > AVISO_SEM_DARDO_MS) {
        r.movPendente = false;
        setStatus('Alvo mexeu mas não vi dardo — se foi na mosca, toque +200');
        enviarRegistro({
          id: novoId(),
          tipo: 'sem-dardo',
          meta: { geom: detector.geom, limiar: r.limiar, ruido: ev.ruido, ox: ev.ox, oy: ev.oy, versao: VERSAO },
          antes: jpegDeRGB(detector.estado.fundo, N),
          depois: jpegDeImageData(img),
        });
        return;
      }

      if (ev.tipo === 'acerto') {
        const id = novoId();
        enviar({ id, tipo: 'acerto', pontos: ev.pontos, anel: ev.anel, origem: 'camera', registro: id });
        enviarRegistro({
          id,
          tipo: 'acerto',
          meta: {
            pontos: ev.pontos, anel: ev.anel, dist: ev.dist, ponta: { x: ev.x, y: ev.y }, aletas: ev.aletas,
            area: ev.area, comp: ev.comp, espessura: ev.espessura, ox: ev.ox, oy: ev.oy, ruido: ev.ruido,
            geom: detector.geom, limiar: r.limiar, N, versao: VERSAO,
          },
          antes: jpegDeRGB(ev.fundoAntes, N),
          depois: jpegDeImageData(img),
        });
        setStatus(`${ev.anel}: ${ev.pontos} pts`);
        if (navigator.vibrate) navigator.vibrate(60);
      } else if (ev.tipo === 'retirado') {
        setStatus(ev.restantes ? `Dardo retirado (${ev.restantes} no alvo)` : 'Alvo limpo — dardos retirados');
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
      // confere as duas medidas: o canvas nasce antes do vídeo ter altura
      const w = Math.round(rect.width * dpr);
      const h = Math.round(rect.height * dpr);
      if (cv.width !== w || cv.height !== h) {
        cv.width = w;
        cv.height = h;
      }
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      if (!calib) return;

      // o detector rastreia o alvo: os anéis acompanham onde ele está agora
      const det = ref.current.detector;
      const rc = ref.current.recorte;
      const k = rc ? rc.lado / TAM_PROC : 0; // px do recorte → px do vídeo
      const offX = det && rc ? (det.estado.ox * k) / rc.vw : 0;
      const offY = det && rc ? (det.estado.oy * k) / rc.vh : 0;
      const cx = (calib.cx + offX) * rect.width;
      const cy = (calib.cy + offY) * rect.height;
      ctx.lineWidth = 2;
      for (const a of estado?.aneis || []) {
        ctx.strokeStyle = a.cor === '#1d1d1d' ? '#ffffff' : a.cor || '#f2c500';
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.ellipse(cx, cy, calib.a * rect.width * a.raio, calib.b * rect.width * a.raio, calib.ang, 0, Math.PI * 2);
        ctx.stroke();
      }
      // seta: para onde as aletas apontam (a ponta fica do outro lado)
      if (calib.dir) {
        const L = Math.max(calib.a, calib.b) * rect.width * 0.35;
        const ex = cx + calib.dir.x * L;
        const ey = cy + calib.dir.y * L;
        ctx.strokeStyle = '#2fbf71';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        const ang = Math.atan2(calib.dir.y, calib.dir.x);
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - 10 * Math.cos(ang - 0.5), ey - 10 * Math.sin(ang - 0.5));
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - 10 * Math.cos(ang + 0.5), ey - 10 * Math.sin(ang + 0.5));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#2fbf71';
      for (const d of det && rc ? det.estado.dardos : []) {
        const nx = (rc.sx + (d.x + det.estado.ox) * k) / rc.vw;
        const ny = (rc.sy + (d.y + det.estado.oy) * k) / rc.vh;
        ctx.beginPath();
        ctx.arc(nx * rect.width, ny * rect.height, 6, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    raf = requestAnimationFrame(desenhar);
    return () => cancelAnimationFrame(raf);
  }, [calib, estado]);

  // Acha o alvo pela cor a partir do toque no centro.
  const calibrarAuto = (nx, ny) => {
    const v = video.current;
    if (!v || !v.videoWidth) return null;
    const W = LARG_CALIB;
    const H = Math.round((v.videoHeight / v.videoWidth) * W);
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, W, H);
    const img = new Float32Array(W * H * 3);
    extrairRGB(ctx.getImageData(0, 0, W, H), img);
    borrar(img, new Float32Array(img.length), W, H);
    const amarelo = (estado?.aneis || []).find((a) => /amarelo/i.test(a.nome))?.raio || 0.57;
    const g = ajustarAlvo(img, W, H, nx * W, ny * H, amarelo);
    if (!g) return null;
    return { cx: g.cx / W, cy: g.cy / H, a: g.a / W, b: g.b / W, ang: g.ang, dir: null };
  };

  const tocar = (ev) => {
    if (passo !== 'centro' && passo !== 'borda') return;
    const rect = ev.currentTarget.getBoundingClientRect();
    const nx = (ev.clientX - rect.left) / rect.width;
    const ny = (ev.clientY - rect.top) / rect.height;
    if (passo === 'centro') {
      const auto = calibrarAuto(nx, ny);
      if (auto) {
        setCalib(auto);
        if (Math.min(auto.a, auto.b) / Math.max(auto.a, auto.b) < RAZAO_FRONTAL) {
          setPasso('direcao');
          setStatus('Alvo encontrado. Confira os anéis e responda abaixo');
        } else {
          setPasso('rodando');
          setStatus('Alvo encontrado (celular de frente). Ajustando câmera…');
        }
        return;
      }
      // não achou pela cor: volta para o método manual
      setCalib({ cx: nx, cy: ny, a: 0.05, b: 0.05, ang: 0, dir: null });
      setPasso('borda');
      setStatus('Não achei o alvo pela cor — toque na BORDA do círculo preto');
    } else {
      setCalib((c) => {
        const dx = nx - c.cx;
        const dy = (ny - c.cy) * (rect.height / rect.width);
        const r = Math.max(0.02, Math.hypot(dx, dy));
        return { ...c, a: r, b: r, ang: 0, dir: null };
      });
      setPasso('rodando');
      setStatus('Calibrado. Ajustando câmera…');
    }
  };

  const escolherDirecao = (sinal) => {
    setCalib((c) => {
      if (sinal === 0) return { ...c, dir: null };
      const m = eixoCurto(c);
      // sinal −1 = aletas à esquerda/acima da ponta; +1 = à direita/abaixo
      const horizontal = Math.abs(m.x) >= Math.abs(m.y);
      const comp = horizontal ? m.x : m.y;
      const s = Math.sign(comp) === sinal ? 1 : -1;
      return { ...c, dir: { x: m.x * s, y: m.y * s } };
    });
    setPasso('rodando');
    setStatus('Calibrado. Ajustando câmera…');
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

      {passo === 'direcao' && calib && (() => {
        const m = eixoCurto(calib);
        const horizontal = Math.abs(m.x) >= Math.abs(m.y);
        return (
          <div className="card" style={{ display: 'grid', gap: 10, borderColor: 'var(--amarelo)' }}>
            <b>O celular está de lado, então os dardos aparecem "deitados".</b>
            <span className="fraco" style={{ fontSize: 14 }}>
              Olhe um dardo cravado na imagem: as <b>aletas</b> (penas) ficam de que lado da <b>ponta</b>?
              {' '}Se não tiver dardo no alvo, jogue um e veja.
            </span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="primario" onClick={() => escolherDirecao(-1)}>
                {horizontal ? '← Aletas à esquerda' : '↑ Aletas acima'}
              </button>
              <button className="primario" onClick={() => escolherDirecao(1)}>
                {horizontal ? 'Aletas à direita →' : '↓ Aletas abaixo'}
              </button>
              <button onClick={() => escolherDirecao(0)}>Não dá pra ver</button>
            </div>
          </div>
        );
      })()}

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
          <span>
            {pendentes > 0 && <b style={{ color: 'var(--amarelo)' }}>⏳ {pendentes} aguardando · </b>}
            Exposição: {trava || '—'}
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
              <span>
                Alvo: {calib ? `${(Math.min(calib.a, calib.b) / Math.max(calib.a, calib.b)).toFixed(2)} redondo` : '—'}
                {calib?.dir ? ' · com direção' : ' · de frente'}
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
  const g = detector.geom;
  ctx.strokeStyle = 'rgba(255,255,255,.6)';
  ctx.beginPath();
  ctx.ellipse(g.cx, g.cy, g.a, g.b, g.ang, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#2fbf71';
  for (const d of detector.estado.dardos) {
    ctx.beginPath();
    ctx.arc(d.x, d.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}
