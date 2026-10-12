// Utilitários de visão: diferença de quadros em cor + componentes conexos.
// As imagens são Float32Array intercalados RGB (3 valores por pixel).

export function extrairRGB(imageData, saida) {
  const d = imageData.data;
  for (let i = 0, p = 0; i < d.length; i += 4, p += 3) {
    saida[p] = d[i];
    saida[p + 1] = d[i + 1];
    saida[p + 2] = d[i + 2];
  }
  return saida;
}

// Desfoque 3x3 (separável). Apaga a textura dos pinos do alvo, que de outra
// forma "pisca" com qualquer microvibração ou ajuste de foco.
export function borrar(img, tmp, larg, alt) {
  for (let y = 0; y < alt; y++) {
    for (let x = 0; x < larg; x++) {
      const e = (y * larg + Math.max(0, x - 1)) * 3;
      const c = (y * larg + x) * 3;
      const d = (y * larg + Math.min(larg - 1, x + 1)) * 3;
      tmp[c] = (img[e] + img[c] + img[d]) / 3;
      tmp[c + 1] = (img[e + 1] + img[c + 1] + img[d + 1]) / 3;
      tmp[c + 2] = (img[e + 2] + img[c + 2] + img[d + 2]) / 3;
    }
  }
  for (let y = 0; y < alt; y++) {
    const ya = Math.max(0, y - 1);
    const yb = Math.min(alt - 1, y + 1);
    for (let x = 0; x < larg; x++) {
      const a = (ya * larg + x) * 3;
      const c = (y * larg + x) * 3;
      const b = (yb * larg + x) * 3;
      img[c] = (tmp[a] + tmp[c] + tmp[b]) / 3;
      img[c + 1] = (tmp[a + 1] + tmp[c + 1] + tmp[b + 1]) / 3;
      img[c + 2] = (tmp[a + 2] + tmp[c + 2] + tmp[b + 2]) / 3;
    }
  }
  return img;
}

// Marca os pixels que mudaram em relação ao fundo dentro do círculo.
// Usa a maior diferença entre os canais: dardo laranja sobre a mosca vermelha
// quase não muda em cinza, mas muda bastante no verde.
// (ox, oy) desloca o quadro atual para compensar o alvo que balançou.
export function mascaraDiferenca(atual, fundo, larg, alt, centro, raioMax, limiar, mascara, ox = 0, oy = 0) {
  let mudados = 0;
  let total = 0;
  mascara.fill(0);
  const r2 = raioMax * raioMax;
  for (let y = 0; y < alt; y++) {
    const dy = y - centro.y;
    const ya = y + oy;
    if (ya < 0 || ya >= alt) continue;
    for (let x = 0; x < larg; x++) {
      const dx = x - centro.x;
      if (dx * dx + dy * dy > r2) continue;
      const xa = x + ox;
      if (xa < 0 || xa >= larg) continue;
      total++;
      const i = y * larg + x;
      const p = i * 3;
      const q = (ya * larg + xa) * 3;
      const dif = Math.max(
        Math.abs(atual[q] - fundo[p]),
        Math.abs(atual[q + 1] - fundo[p + 1]),
        Math.abs(atual[q + 2] - fundo[p + 2])
      );
      if (dif > limiar) {
        mascara[i] = 1;
        mudados++;
      }
    }
  }
  return { mudados, total };
}

// Procura o deslocamento (até maxD px) que melhor encaixa o quadro atual no
// fundo. Compara uma amostra de pixels do círculo para ser barato.
export function melhorDeslocamento(atual, fundo, larg, alt, centro, raio, maxD) {
  let melhor = { ox: 0, oy: 0, erro: Infinity };
  const r2 = raio * raio;
  for (let oy = -maxD; oy <= maxD; oy++) {
    for (let ox = -maxD; ox <= maxD; ox++) {
      let erro = 0;
      let n = 0;
      for (let y = 0; y < alt; y += 3) {
        const ya = y + oy;
        if (ya < 0 || ya >= alt) continue;
        const dy = y - centro.y;
        for (let x = 0; x < larg; x += 3) {
          const dx = x - centro.x;
          if (dx * dx + dy * dy > r2) continue;
          const xa = x + ox;
          if (xa < 0 || xa >= larg) continue;
          const p = (y * larg + x) * 3;
          const q = (ya * larg + xa) * 3;
          erro += Math.abs(atual[q] - fundo[p]) + Math.abs(atual[q + 1] - fundo[p + 1]) + Math.abs(atual[q + 2] - fundo[p + 2]);
          n++;
        }
      }
      erro /= n || 1;
      // leve preferência por não deslocar, para não "andar" à toa com ruído
      erro += (Math.abs(ox) + Math.abs(oy)) * 0.05;
      if (erro < melhor.erro) melhor = { ox, oy, erro };
    }
  }
  return melhor;
}

// Puxa o fundo devagar para o quadro atual onde nada mudou de verdade,
// absorvendo variações lentas de luz sem engolir um dardo novo.
export function adaptarFundo(fundo, atual, mascara, taxa, larg = 0, ox = 0, oy = 0) {
  const alt = larg ? mascara.length / larg : 0;
  for (let i = 0; i < mascara.length; i++) {
    if (mascara[i]) continue;
    let q = i;
    if (ox || oy) {
      const x = (i % larg) + ox;
      const y = Math.floor(i / larg) + oy;
      if (x < 0 || x >= larg || y < 0 || y >= alt) continue;
      q = y * larg + x;
    }
    const p = i * 3;
    q *= 3;
    fundo[p] += (atual[q] - fundo[p]) * taxa;
    fundo[p + 1] += (atual[q + 1] - fundo[p + 1]) * taxa;
    fundo[p + 2] += (atual[q + 2] - fundo[p + 2]) * taxa;
  }
}

// Copia o quadro atual para o fundo já compensando o deslocamento.
export function copiarAlinhado(fundo, atual, larg, alt, ox, oy) {
  for (let y = 0; y < alt; y++) {
    const ya = Math.min(alt - 1, Math.max(0, y + oy));
    for (let x = 0; x < larg; x++) {
      const xa = Math.min(larg - 1, Math.max(0, x + ox));
      const p = (y * larg + x) * 3;
      const q = (ya * larg + xa) * 3;
      fundo[p] = atual[q];
      fundo[p + 1] = atual[q + 1];
      fundo[p + 2] = atual[q + 2];
    }
  }
}

export function brilhoMedio(img) {
  let s = 0;
  for (let p = 0; p < img.length; p += 3) s += img[p] + img[p + 1] + img[p + 2];
  return s / img.length;
}

// Agrupa pixels vizinhos em blobs (BFS 4-vizinhos).
export function blobs(mascara, larg, alt, areaMin, areaMax) {
  const visto = new Uint8Array(mascara.length);
  const fila = new Int32Array(mascara.length);
  const achados = [];
  for (let i = 0; i < mascara.length; i++) {
    if (!mascara[i] || visto[i]) continue;
    let ini = 0;
    let fim = 0;
    fila[fim++] = i;
    visto[i] = 1;
    let soma = 0;
    let somaX = 0;
    let somaY = 0;
    while (ini < fim) {
      const p = fila[ini++];
      const x = p % larg;
      const y = (p - x) / larg;
      soma++;
      somaX += x;
      somaY += y;
      if (x > 0 && mascara[p - 1] && !visto[p - 1]) { visto[p - 1] = 1; fila[fim++] = p - 1; }
      if (x < larg - 1 && mascara[p + 1] && !visto[p + 1]) { visto[p + 1] = 1; fila[fim++] = p + 1; }
      if (y > 0 && mascara[p - larg] && !visto[p - larg]) { visto[p - larg] = 1; fila[fim++] = p - larg; }
      if (y < alt - 1 && mascara[p + larg] && !visto[p + larg]) { visto[p + larg] = 1; fila[fim++] = p + larg; }
    }
    if (soma >= areaMin && soma <= areaMax) {
      achados.push({ area: soma, x: somaX / soma, y: somaY / soma });
    }
  }
  return achados.sort((a, b) => b.area - a.area);
}

// Quantos dedos (indicador→mínimo) estão estendidos.
export function contarDedos(marcos) {
  if (!marcos) return 0;
  const pares = [[8, 6], [12, 10], [16, 14], [20, 18]];
  let n = 0;
  for (const [ponta, junta] of pares) {
    if (marcos[ponta].y < marcos[junta].y - 0.02) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Detector: toda a decisão quadro a quadro mora aqui, para o celular e os
// testes rodarem exatamente o mesmo código.

export const CONFIG_PADRAO = {
  folga: 1.12,             // o recorte cobre 1,12× o raio do alvo
  raioUtil: 1.06,          // fora disso é borda amarela (0 pts): nem olha
  framesEstaveis: 5,       // ~0,75s com o mesmo blob parado
  framesAquecimento: 12,   // ~2s para exposição/foco assentarem
  movimento: 0.02,         // >2% mudou entre dois quadros = alvo balançando
  framesParado: 3,         // quadros parados antes de voltar a analisar
  deslocMax: 8,            // quanto o alvo pode ter assentado fora do lugar (px)
  mudancaGlobal: 0.035,    // >3,5% diferente do fundo mesmo alinhado…
  framesLuz: 10,           // …por ~1,5s seguidos = luz mudou: troca o fundo
  adaptaFundo: 0.04,       // velocidade com que o fundo segue a luz lenta
  pausaEntreDardosMs: 1200,
};

export function criarDetector(N, config = {}) {
  const cfg = { ...CONFIG_PADRAO, ...config };
  const centro = { x: N / 2, y: N / 2 };
  const raio = N / 2 / cfg.folga;
  const areaMin = Math.max(10, Math.round(raio * raio * 0.002));
  const areaMax = Math.round(raio * raio * 0.06);
  const mascara = new Uint8Array(N * N);
  const mascaraMov = new Uint8Array(N * N);

  const s = {
    fundo: null,
    anterior: null,
    aquecendo: 0,
    parado: 0,
    luz: 0,
    dardos: [],
    candidato: null,
    ultimoAcerto: -Infinity,
  };

  function reiniciar() {
    s.fundo = null;
    s.anterior = null;
    s.dardos = [];
    s.candidato = null;
    s.luz = 0;
  }

  // atual: Float32Array RGB N×N já desfocado. Retorna o que aconteceu.
  function processar(atual, { agora, maoRecente, limiar, aneis }) {
    if (!s.fundo) {
      s.fundo = Float32Array.from(atual);
      s.anterior = Float32Array.from(atual);
      s.aquecendo = cfg.framesAquecimento;
      s.dardos = [];
      s.candidato = null;
      return { tipo: 'aquecendo' };
    }
    if (s.aquecendo > 0) {
      s.fundo.set(atual);
      s.anterior.set(atual);
      s.aquecendo--;
      return { tipo: 'aquecendo' };
    }

    // 1) o alvo está se mexendo? (compara com o quadro anterior)
    const mov = mascaraDiferenca(atual, s.anterior, N, N, centro, raio * cfg.raioUtil, limiar, mascaraMov);
    s.anterior.set(atual);
    const fracMov = mov.total ? mov.mudados / mov.total : 0;
    if (fracMov > cfg.movimento) {
      s.parado = 0;
      s.candidato = null;
      return { tipo: 'movendo', ruido: fracMov };
    }
    if (s.parado < cfg.framesParado) {
      s.parado++;
      return { tipo: 'movendo', ruido: fracMov };
    }

    // 2) mão na frente do alvo: nada é dardo
    if (maoRecente) {
      s.candidato = null;
      return { tipo: 'mao' };
    }

    // 3) alinha com o fundo (o alvo pode ter assentado alguns px ao lado)
    const { ox, oy } = melhorDeslocamento(atual, s.fundo, N, N, centro, raio, cfg.deslocMax);
    const { mudados, total } = mascaraDiferenca(
      atual, s.fundo, N, N, centro, raio * cfg.raioUtil, limiar, mascara, ox, oy
    );
    const ruido = total ? mudados / total : 0;

    if (ruido > cfg.mudancaGlobal) {
      s.candidato = null;
      if (++s.luz >= cfg.framesLuz) {
        copiarAlinhado(s.fundo, atual, N, N, ox, oy);
        s.luz = 0;
        return { tipo: 'luz', ruido, ox, oy, trocouFundo: true };
      }
      return { tipo: 'luz', ruido, ox, oy, trocouFundo: false };
    }
    s.luz = 0;
    adaptarFundo(s.fundo, atual, mascara, cfg.adaptaFundo, N, ox, oy);

    // 4) blob com tamanho de dardo que ainda não foi pontuado
    const lista = blobs(mascara, N, N, areaMin, areaMax);
    const maiorArea = lista[0]?.area || 0;
    const novo = lista.find(
      (b) => !s.dardos.some((d) => Math.hypot(d.x - b.x, d.y - b.y) < raio * 0.1)
    );
    const info = { ruido, ox, oy, maiorArea, areaMin };
    if (!novo) {
      s.candidato = null;
      return { tipo: 'nada', ...info };
    }
    if (s.candidato && Math.hypot(s.candidato.x - novo.x, s.candidato.y - novo.y) < raio * 0.04) {
      s.candidato.n += 1;
    } else {
      s.candidato = { x: novo.x, y: novo.y, n: 1 };
    }
    if (s.candidato.n < cfg.framesEstaveis || agora - s.ultimoAcerto < cfg.pausaEntreDardosMs) {
      return { tipo: 'candidato', n: s.candidato.n, ...info };
    }

    // 5) dardo confirmado
    const dist = Math.hypot(novo.x - centro.x, novo.y - centro.y) / raio;
    let pontos = 0;
    let anel = 'Fora';
    for (const a of [...(aneis || [])].sort((x, y) => x.raio - y.raio)) {
      if (dist <= a.raio) { pontos = a.pontos; anel = a.nome; break; }
    }
    s.dardos.push({ x: novo.x, y: novo.y });
    s.candidato = null;
    s.ultimoAcerto = agora;
    copiarAlinhado(s.fundo, atual, N, N, ox, oy); // o dardo passa a ser fundo
    return { tipo: 'acerto', x: novo.x, y: novo.y, dist, pontos, anel, area: novo.area, ...info };
  }

  return { processar, reiniciar, estado: s, mascara, raio, centro };
}
