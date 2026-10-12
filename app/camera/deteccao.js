// Visão do contador de dardos.
// As imagens são Float32Array intercalados RGB (3 valores por pixel).
// O alvo é descrito por uma elipse { cx, cy, a, b, ang }: centro, semi-eixos da
// borda do círculo preto e inclinação — com o celular de lado o círculo vira elipse.

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

export function brilhoMedio(img) {
  let s = 0;
  for (let p = 0; p < img.length; p += 3) s += img[p] + img[p + 1] + img[p + 2];
  return s / img.length;
}

// Distância normalizada até o centro: 1 = borda do círculo preto.
export function distElipse(g, x, y) {
  const dx = x - g.cx;
  const dy = y - g.cy;
  const c = Math.cos(g.ang);
  const s = Math.sin(g.ang);
  const u = (dx * c + dy * s) / g.a;
  const v = (-dx * s + dy * c) / g.b;
  return Math.sqrt(u * u + v * v);
}

// Pixels do recorte que pertencem à região analisada.
export function mascaraRegiao(g, larg, alt, limite) {
  const roi = new Uint8Array(larg * alt);
  for (let y = 0; y < alt; y++) {
    for (let x = 0; x < larg; x++) {
      if (distElipse(g, x, y) <= limite) roi[y * larg + x] = 1;
    }
  }
  return roi;
}

// ---------------------------------------------------------------------------
// Calibração automática: a partir de um toque no centro, encontra o disco
// amarelo+vermelho (cercado pelo preto) e ajusta uma elipse pelos momentos.

function quente(r, g, b) {
  // amarelo, laranja ou vermelho bem saturados
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max < 70) return false;
  const sat = (max - min) / max;
  if (sat < 0.4) return false;
  let h;
  if (max === r) h = (60 * ((g - b) / (max - min)) + 360) % 360;
  else if (max === g) h = 60 * ((b - r) / (max - min)) + 120;
  else h = 60 * ((r - g) / (max - min)) + 240;
  return h <= 75 || h >= 330;
}

function dilatarBin(m, saida, larg, alt) {
  saida.fill(0);
  for (let y = 0; y < alt; y++) {
    for (let x = 0; x < larg; x++) {
      if (!m[y * larg + x]) continue;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(alt - 1, y + 1); yy++) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(larg - 1, x + 1); xx++) saida[yy * larg + xx] = 1;
      }
    }
  }
  return saida;
}

function erodirBin(m, saida, larg, alt) {
  saida.fill(0);
  for (let y = 1; y < alt - 1; y++) {
    for (let x = 1; x < larg - 1; x++) {
      let ok = 1;
      for (let yy = y - 1; yy <= y + 1 && ok; yy++) {
        for (let xx = x - 1; xx <= x + 1; xx++) if (!m[yy * larg + xx]) { ok = 0; break; }
      }
      saida[y * larg + x] = ok;
    }
  }
  return saida;
}

function inundar(m, larg, alt, ini, marca) {
  const fila = new Int32Array(larg * alt);
  let a = 0;
  let f = 0;
  fila[f++] = ini;
  marca[ini] = 1;
  while (a < f) {
    const p = fila[a++];
    const x = p % larg;
    const viz = [x > 0 ? p - 1 : -1, x < larg - 1 ? p + 1 : -1, p - larg, p + larg];
    for (const q of viz) {
      if (q < 0 || q >= m.length || marca[q] || !m[q]) continue;
      marca[q] = 1;
      fila[f++] = q;
    }
  }
  return f;
}

// img: RGB já desfocado (larg×alt). (sx, sy): toque no centro, em pixels.
// razaoAmarelo: raio da borda externa do amarelo / raio da borda do preto.
// Retorna a elipse da borda do preto, ou null se não achou o alvo.
export function ajustarAlvo(img, larg, alt, sx, sy, razaoAmarelo = 0.57) {
  const n = larg * alt;
  let m = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 3) m[i] = quente(img[p], img[p + 1], img[p + 2]) ? 1 : 0;

  // fecha os buracos entre os pinos
  const t1 = new Uint8Array(n);
  const t2 = new Uint8Array(n);
  dilatarBin(dilatarBin(m, t1, larg, alt), t2, larg, alt);
  erodirBin(erodirBin(t2, t1, larg, alt), m, larg, alt);

  // semente: pixel "quente" mais perto do toque
  let ini = -1;
  for (let r = 0; r < 25 && ini < 0; r++) {
    for (let dy = -r; dy <= r && ini < 0; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = Math.round(sx + dx);
        const y = Math.round(sy + dy);
        if (x < 0 || y < 0 || x >= larg || y >= alt) continue;
        if (m[y * larg + x]) { ini = y * larg + x; break; }
      }
    }
  }
  if (ini < 0) return null;

  const regiao = new Uint8Array(n);
  const area = inundar(m, larg, alt, ini, regiao);
  if (area < 150 || area > n * 0.5) return null;

  // tapa os furos (dardos azuis em cima do amarelo): tudo que não se liga à
  // borda da imagem por fora da região faz parte do disco
  const fora = new Uint8Array(n);
  const livre = new Uint8Array(n);
  for (let i = 0; i < n; i++) livre[i] = regiao[i] ? 0 : 1;
  for (let x = 0; x < larg; x++) {
    for (const i of [x, (alt - 1) * larg + x]) if (livre[i] && !fora[i]) inundar(livre, larg, alt, i, fora);
  }
  for (let y = 0; y < alt; y++) {
    for (const i of [y * larg, y * larg + larg - 1]) if (livre[i] && !fora[i]) inundar(livre, larg, alt, i, fora);
  }

  let s = 0, mx = 0, my = 0;
  for (let i = 0; i < n; i++) {
    if (fora[i]) continue;
    s++;
    mx += i % larg;
    my += Math.floor(i / larg);
  }
  mx /= s;
  my /= s;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    if (fora[i]) continue;
    const dx = (i % larg) - mx;
    const dy = Math.floor(i / larg) - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  sxx /= s;
  syy /= s;
  sxy /= s;

  // autovalores da covariância: disco cheio de semi-eixo a tem variância a²/4
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc;
  const l2 = tr / 2 - disc;
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const a = (2 * Math.sqrt(l1)) / razaoAmarelo;
  const b = (2 * Math.sqrt(Math.max(l2, 1e-6))) / razaoAmarelo;
  if (b / a < 0.35) return null; // achatado demais: não é o alvo

  return { cx: mx, cy: my, a, b, ang, area: s };
}

// ---------------------------------------------------------------------------
// Diferença de quadros

// Marca os pixels da região que mudaram em relação ao fundo.
// Usa a maior diferença entre os canais (dardo laranja sobre a mosca vermelha
// quase não muda em cinza, mas muda no verde). (ox, oy) compensa o alvo que
// balançou: compara atual[x+ox, y+oy] com fundo[x, y].
export function mascaraDiferenca(atual, fundo, larg, alt, roi, limiar, mascara, ox = 0, oy = 0) {
  let mudados = 0;
  let total = 0;
  mascara.fill(0);
  for (let y = 0; y < alt; y++) {
    const ya = y + oy;
    if (ya < 0 || ya >= alt) continue;
    for (let x = 0; x < larg; x++) {
      const i = y * larg + x;
      if (!roi[i]) continue;
      const xa = x + ox;
      if (xa < 0 || xa >= larg) continue;
      total++;
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

// Procura o deslocamento que melhor encaixa o quadro atual no fundo, numa
// janela de ±maxD px em volta de `centro` (rastreamento: parte de onde o alvo
// estava). `passo` pula deslocamentos (busca grossa) e `amostra` pula pixels.
export function melhorDeslocamento(atual, fundo, larg, alt, roi, maxD, centro = null, passo = 1, amostra = 3) {
  const c0x = centro ? centro.ox : 0;
  const c0y = centro ? centro.oy : 0;
  let melhor = { ox: c0x, oy: c0y, erro: Infinity };
  for (let oy = c0y - maxD; oy <= c0y + maxD; oy += passo) {
    for (let ox = c0x - maxD; ox <= c0x + maxD; ox += passo) {
      let erro = 0;
      let n = 0;
      for (let y = 0; y < alt; y += amostra) {
        const ya = y + oy;
        if (ya < 0 || ya >= alt) continue;
        for (let x = 0; x < larg; x += amostra) {
          if (!roi[y * larg + x]) continue;
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

// Puxa o fundo devagar para o quadro atual onde nada mudou de verdade.
export function adaptarFundo(fundo, atual, mascara, taxa, larg, ox = 0, oy = 0) {
  const alt = mascara.length / larg;
  for (let i = 0; i < mascara.length; i++) {
    if (mascara[i]) continue;
    const x = (i % larg) + ox;
    const y = Math.floor(i / larg) + oy;
    if (x < 0 || x >= larg || y < 0 || y >= alt) continue;
    const p = i * 3;
    const q = (y * larg + x) * 3;
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

// Copia para o fundo só os pixels indicados (e uma margem de `margem` px):
// incorpora um dardo confirmado sem engolir outro que ainda está chegando.
export function copiarRegiao(fundo, atual, larg, alt, ox, oy, pixels, margem = 2) {
  const marca = new Uint8Array(larg * alt);
  for (const p of pixels) {
    const x = p % larg;
    const y = (p - x) / larg;
    for (let yy = Math.max(0, y - margem); yy <= Math.min(alt - 1, y + margem); yy++) {
      for (let xx = Math.max(0, x - margem); xx <= Math.min(larg - 1, x + margem); xx++) marca[yy * larg + xx] = 1;
    }
  }
  for (let i = 0; i < marca.length; i++) {
    if (!marca[i]) continue;
    const xa = Math.min(larg - 1, Math.max(0, (i % larg) + ox));
    const ya = Math.min(alt - 1, Math.max(0, Math.floor(i / larg) + oy));
    const p = i * 3;
    const q = (ya * larg + xa) * 3;
    fundo[p] = atual[q];
    fundo[p + 1] = atual[q + 1];
    fundo[p + 2] = atual[q + 2];
  }
}

// Região de um dardo: os pixels da mancha + margem, como lista de índices.
export function expandirRegiao(pixels, larg, alt, margem = 2) {
  const marca = new Uint8Array(larg * alt);
  for (const p of pixels) {
    const x = p % larg;
    const y = (p - x) / larg;
    for (let yy = Math.max(0, y - margem); yy <= Math.min(alt - 1, y + margem); yy++) {
      for (let xx = Math.max(0, x - margem); xx <= Math.min(larg - 1, x + margem); xx++) marca[yy * larg + xx] = 1;
    }
  }
  const out = [];
  for (let i = 0; i < marca.length; i++) if (marca[i]) out.push(i);
  return Int32Array.from(out);
}

// Guarda os valores RGB de `img` nos pixels da região.
export function amostrar(img, regiao) {
  const out = new Float32Array(regiao.length * 3);
  for (let k = 0; k < regiao.length; k++) {
    const p = regiao[k] * 3;
    out[k * 3] = img[p];
    out[k * 3 + 1] = img[p + 1];
    out[k * 3 + 2] = img[p + 2];
  }
  return out;
}

// Diferença média (maior canal) entre o quadro atual alinhado e uma amostra
// guardada, com ganho de luz por canal aplicado à amostra.
export function diferencaRegiao(atual, larg, alt, regiao, amostra, ox, oy, ganho = [1, 1, 1]) {
  let soma = 0;
  let n = 0;
  for (let k = 0; k < regiao.length; k++) {
    const i = regiao[k];
    const xa = (i % larg) + ox;
    const ya = Math.floor(i / larg) + oy;
    if (xa < 0 || xa >= larg || ya < 0 || ya >= alt) continue;
    const q = (ya * larg + xa) * 3;
    soma += Math.max(
      Math.abs(atual[q] - amostra[k * 3] * ganho[0]),
      Math.abs(atual[q + 1] - amostra[k * 3 + 1] * ganho[1]),
      Math.abs(atual[q + 2] - amostra[k * 3 + 2] * ganho[2])
    );
    n++;
  }
  return n ? soma / n : Infinity;
}

// Quanto a luz mudou desde que o dardo entrou: compara o fundo atual (que
// acompanha a luz) com como o dardo era quando foi contado.
function ganhoDeLuz(fundo, regiao, depois) {
  const s = [0, 0, 0];
  const d = [0, 0, 0];
  for (let k = 0; k < regiao.length; k++) {
    const p = regiao[k] * 3;
    for (let c = 0; c < 3; c++) {
      s[c] += fundo[p + c];
      d[c] += depois[k * 3 + c];
    }
  }
  return s.map((v, c) => (d[c] > 1 ? Math.min(2, Math.max(0.5, v / d[c])) : 1));
}

// ---------------------------------------------------------------------------
// Manchas e ponta do dardo

// Agrupa pixels vizinhos. Os grupos são formados na máscara dilatada (junta
// aletas e haste que apareceram separadas), mas as medidas usam só os pixels
// que mudaram de verdade. Para cada mancha devolve as duas extremidades do eixo
// comprido e a largura perto de cada uma: as aletas são largas, a ponta é fina.
export function manchas(mascara, larg, alt, areaMin, areaMax, dir = null, dilatacoes = 2) {
  let juntar = mascara;
  const t1 = new Uint8Array(mascara.length);
  const t2 = new Uint8Array(mascara.length);
  for (let k = 0; k < dilatacoes; k++) {
    const saida = k % 2 === 0 ? t1 : t2;
    dilatarBin(juntar, saida, larg, alt);
    juntar = saida;
  }

  const visto = new Uint8Array(mascara.length);
  const fila = new Int32Array(mascara.length);
  const achados = [];
  for (let i = 0; i < mascara.length; i++) {
    if (!mascara[i] || visto[i]) continue;
    let ini = 0;
    let fim = 0;
    fila[fim++] = i;
    visto[i] = 1;
    while (ini < fim) {
      const p = fila[ini++];
      const x = p % larg;
      const y = (p - x) / larg;
      if (x > 0 && juntar[p - 1] && !visto[p - 1]) { visto[p - 1] = 1; fila[fim++] = p - 1; }
      if (x < larg - 1 && juntar[p + 1] && !visto[p + 1]) { visto[p + 1] = 1; fila[fim++] = p + 1; }
      if (y > 0 && juntar[p - larg] && !visto[p - larg]) { visto[p - larg] = 1; fila[fim++] = p - larg; }
      if (y < alt - 1 && juntar[p + larg] && !visto[p + larg]) { visto[p + larg] = 1; fila[fim++] = p + larg; }
    }

    // só os pixels que mudaram de verdade
    const xs = [];
    const ys = [];
    for (let k = 0; k < fim; k++) {
      const p = fila[k];
      if (!mascara[p]) continue;
      xs.push(p % larg);
      ys.push(Math.floor(p / larg));
    }
    const area = xs.length;
    if (area < areaMin || area > areaMax) continue;
    const m = medirMancha(xs, ys, dir);
    m.pixels = fila.slice(0, fim);
    achados.push(m);
  }
  return achados.sort((a, b) => b.area - a.area);
}

function medirMancha(xs, ys, dir) {
  const n = xs.length;
  let mx = 0, my = 0;
  for (let k = 0; k < n; k++) { mx += xs[k]; my += ys[k]; }
  mx /= n;
  my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let k = 0; k < n; k++) {
    const dx = xs[k] - mx;
    const dy = ys[k] - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  sxx /= n; syy /= n; sxy /= n;
  const tr = sxx + syy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - (sxx * syy - sxy * sxy)));
  const l1 = tr / 2 + disc;
  const l2 = Math.max(tr / 2 - disc, 0.01);

  // eixo de medida: a direção ponta→aletas da calibração; sem ela, o eixo comprido
  let ux, uy;
  if (dir) {
    ux = dir.x;
    uy = dir.y;
  } else {
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    ux = Math.cos(ang);
    uy = Math.sin(ang);
  }

  let tmin = Infinity, tmax = -Infinity;
  const ts = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    ts[k] = (xs[k] - mx) * ux + (ys[k] - my) * uy;
    if (ts[k] < tmin) tmin = ts[k];
    if (ts[k] > tmax) tmax = ts[k];
  }
  const comp = tmax - tmin;

  // extremidade (média dos pixels nos 12% finais) e largura nos 30% finais
  const ponta = (de, ate) => {
    let sx = 0, sy = 0, c = 0;
    for (let k = 0; k < n; k++) if (ts[k] >= de && ts[k] <= ate) { sx += xs[k]; sy += ys[k]; c++; }
    return c ? { x: sx / c, y: sy / c } : { x: mx, y: my };
  };
  const largura = (de, ate) => {
    let s1 = 0, s2 = 0, c = 0;
    for (let k = 0; k < n; k++) {
      if (ts[k] < de || ts[k] > ate) continue;
      const w = -(xs[k] - mx) * uy + (ys[k] - my) * ux;
      s1 += w; s2 += w * w; c++;
    }
    return c ? Math.sqrt(Math.max(0, s2 / c - (s1 / c) ** 2)) : 0;
  };

  return {
    area: n,
    x: mx,
    y: my,
    comp,
    espessura: Math.sqrt(l2),          // desvio no eixo curto: linhas finas = borda/pinos
    alongamento: Math.sqrt(l1 / l2),
    porDirecao: !!dir,
    e1: ponta(tmin, tmin + 0.12 * comp), // com dir: lado da ponta
    e2: ponta(tmax - 0.12 * comp, tmax), // com dir: lado das aletas
    w1: largura(tmin, tmin + 0.3 * comp),
    w2: largura(tmax - 0.3 * comp, tmax),
  };
}

// Decide qual extremidade é a ponta.
// Com a direção da calibração (celular de lado) é direto: a ponta é a
// extremidade oposta às aletas. Sem ela (celular de frente) o dardo aparece
// curto e o centro da mancha já está perto da ponta.
export function escolherPonta(m) {
  if (m.porDirecao) return { ponta: m.e1, aletas: m.e2 };
  if (m.alongamento < 1.8) return { ponta: { x: m.x, y: m.y }, aletas: null };
  const e1EPonta = m.w2 >= m.w1; // aletas são o lado mais largo
  return e1EPonta ? { ponta: m.e1, aletas: m.e2 } : { ponta: m.e2, aletas: m.e1 };
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
  folga: 1.25,             // o recorte cobre 1,25× o semi-eixo maior (cabe a aleta pra fora)
  raioUtil: 1.08,          // região analisada, em raios do círculo preto
  framesEstaveis: 5,       // ~0,75s com a mesma ponta parada
  framesAquecimento: 12,   // ~2s para exposição/foco assentarem
  movimento: 0.02,         // >2% mudou entre dois quadros = alvo balançando
  framesParado: 3,         // quadros parados antes de voltar a analisar
  deslocMax: 2,            // ajuste fino quadro a quadro em volta da posição rastreada (px)
  deslocBalanco: 24,       // depois de balançar, procura o alvo nessa janela (px)
  mudancaGlobal: 0.035,    // >3,5% diferente do fundo mesmo alinhado…
  framesLuz: 10,           // …por ~1,5s seguidos = luz mudou: troca o fundo
  adaptaFundo: 0.04,       // velocidade com que o fundo segue a luz lenta
  pausaEntreDardosMs: 1200,
};

// geom: elipse do alvo nas coordenadas do recorte N×N, com geom.dir = direção
// ponta→aletas (vetor unitário) quando o celular está de lado.
export function criarDetector(N, geom, config = {}) {
  const cfg = { ...CONFIG_PADRAO, ...config };
  const raio = Math.sqrt(geom.a * geom.b);
  // Medido nas capturas reais: um dardo ocupa ~0,044 R² e mede ~0,36 R ao longo
  // da direção em que "deita"; os pinos da lateral que mudam quando o alvo
  // assenta torto dão ~0,009 R² e ~0,11 R. Os limites ficam no meio.
  // De frente o dardo aparece de ponta (só a cruz das aletas, ~0,007 R²).
  const areaMin = Math.max(12, Math.round(raio * raio * (geom.dir ? 0.015 : 0.004)));
  const espessuraMin = Math.max(0.9, raio * 0.012);
  // o comprimento aparente do dardo cresce com o ângulo do celular
  const inclinacao = Math.sqrt(Math.max(0, 1 - (Math.min(geom.a, geom.b) / Math.max(geom.a, geom.b)) ** 2));
  const compMin = geom.dir ? raio * Math.max(0.08, 0.3 * inclinacao) : 0;
  const areaMax = Math.round(raio * raio * 0.12);
  const roi = mascaraRegiao(geom, N, N, cfg.raioUtil);
  const mascara = new Uint8Array(N * N);
  const mascaraMov = new Uint8Array(N * N);

  const s = {
    fundo: null,
    anterior: null,
    aquecendo: 0,
    parado: 0,
    luz: 0,
    dardos: [],        // memória por dardo: { x, y, regiao, antes, depois, area }
    dono: new Int16Array(N * N).fill(-1), // qual dardo ocupa cada pixel
    candidato: null,
    ultimoAcerto: -Infinity,
    ox: 0,             // posição rastreada do alvo em relação à calibração
    oy: 0,
    procurarLonge: true,
  };

  function reiniciar() {
    s.fundo = null;
    s.anterior = null;
    s.dardos = [];
    s.dono.fill(-1);
    s.candidato = null;
    s.luz = 0;
    s.ox = 0;
    s.oy = 0;
    s.procurarLonge = true;
  }

  function refazerDonos() {
    s.dono.fill(-1);
    s.dardos.forEach((d, j) => { for (const i of d.regiao) s.dono[i] = j; });
  }

  // tira um dardo da memória e passa a considerar o alvo vazio naquela região
  function retirar(j, atual, ox, oy) {
    copiarRegiao(s.fundo, atual, N, N, ox, oy, s.dardos[j].regiao, 0);
    s.dardos.splice(j, 1);
    refazerDonos();
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
    const mov = mascaraDiferenca(atual, s.anterior, N, N, roi, limiar, mascaraMov);
    s.anterior.set(atual);
    const fracMov = mov.total ? mov.mudados / mov.total : 0;
    if (fracMov > cfg.movimento) {
      s.parado = 0;
      s.candidato = null;
      s.procurarLonge = true; // balançou: pode ter assentado em outro lugar
      return { tipo: 'movendo', real: true, ruido: fracMov };
    }
    if (s.parado < cfg.framesParado) {
      s.parado++;
      return { tipo: 'movendo', real: false, ruido: fracMov }; // só esperando assentar
    }

    // 2) mão na frente do alvo: nada é dardo
    if (maoRecente) {
      s.candidato = null;
      return { tipo: 'mao' };
    }

    // 3) rastreia o alvo: depois de balançar procura numa janela grande (busca
    //    grossa), depois só ajusta fino em volta de onde ele estava
    let centroBusca = { ox: s.ox, oy: s.oy };
    if (s.procurarLonge) {
      centroBusca = melhorDeslocamento(atual, s.fundo, N, N, roi, cfg.deslocBalanco, { ox: 0, oy: 0 }, 3, 4);
      s.procurarLonge = false;
    }
    const fino = melhorDeslocamento(atual, s.fundo, N, N, roi, cfg.deslocMax, centroBusca);
    const lim = cfg.deslocBalanco;
    const ox = Math.max(-lim, Math.min(lim, fino.ox));
    const oy = Math.max(-lim, Math.min(lim, fino.oy));
    s.ox = ox;
    s.oy = oy;

    // 4) memória por dardo: algum dardo contado foi retirado? (a região voltou
    //    a parecer o alvo de antes dele, com a correção de luz)
    let retirados = 0;
    for (let j = s.dardos.length - 1; j >= 0; j--) {
      const d = s.dardos[j];
      const ganho = ganhoDeLuz(s.fundo, d.regiao, d.depois);
      const comoAntes = diferencaRegiao(atual, N, N, d.regiao, d.antes, ox, oy, ganho);
      const comoDepois = diferencaRegiao(atual, N, N, d.regiao, d.depois, ox, oy, ganho);
      if (comoAntes < limiar * 0.5 && comoDepois > limiar * 0.5 && comoAntes < comoDepois * 0.6) {
        retirar(j, atual, ox, oy);
        retirados++;
      }
    }
    if (retirados) {
      s.candidato = null;
      return { tipo: 'retirado', n: retirados, restantes: s.dardos.length, ox, oy };
    }

    const { mudados, total } = mascaraDiferenca(atual, s.fundo, N, N, roi, limiar, mascara, ox, oy);
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

    // 5) mancha com tamanho de dardo que não seja um dardo já contado
    const lista = manchas(mascara, N, N, areaMin, areaMax, geom.dir || null);
    const maiorArea = lista[0]?.area || 0;
    const info = { ruido, ox, oy, maiorArea, areaMin };
    let novo = null;
    for (const m of lista) {
      if (m.espessura < espessuraMin) continue; // linha fina: borda da placa ou pinos
      if (m.comp < compMin) continue;           // curto demais para um dardo deitado
      const { ponta, aletas } = escolherPonta(m);
      if (distElipse(geom, ponta.x, ponta.y) > 1.02) continue; // ponta fora do preto

      // É o "fantasma" de um dardo já contado? Só se ocupa praticamente a mesma
      // região, com a mesma ponta e tamanho parecido. Um dardo NOVO caindo ao
      // lado (agrupado) ocupa outros pixels e passa.
      const contagem = new Map();
      for (const i of m.pixels) if (s.dono[i] >= 0) contagem.set(s.dono[i], (contagem.get(s.dono[i]) || 0) + 1);
      let fantasma = false;
      for (const [j, c] of contagem) {
        const d = s.dardos[j];
        const sobrepoe = c / m.pixels.length;
        const mesmaPonta = Math.hypot(d.x - ponta.x, d.y - ponta.y) < raio * 0.05;
        const mesmoTamanho = m.area > d.area * 0.7 && m.area < d.area * 1.4;
        if (sobrepoe > 0.6 && mesmaPonta && mesmoTamanho) {
          const ganho = ganhoDeLuz(s.fundo, d.regiao, d.depois);
          const aindaLa = diferencaRegiao(atual, N, N, d.regiao, d.depois, ox, oy, ganho) < limiar * 0.5;
          copiarRegiao(s.fundo, atual, N, N, ox, oy, m.pixels);
          if (!aindaLa) retirar(j, atual, ox, oy); // não parece mais o dardo: foi tirado
          fantasma = true;
          break;
        }
      }
      if (fantasma) continue;
      novo = { ...m, ponta, aletas };
      break;
    }
    if (!novo) {
      s.candidato = null;
      return { tipo: 'nada', ...info };
    }
    const p = novo.ponta;
    if (s.candidato && Math.hypot(s.candidato.x - p.x, s.candidato.y - p.y) < raio * 0.05) {
      s.candidato.n += 1;
    } else {
      s.candidato = { x: p.x, y: p.y, n: 1 };
    }
    if (s.candidato.n < cfg.framesEstaveis || agora - s.ultimoAcerto < cfg.pausaEntreDardosMs) {
      return { tipo: 'candidato', n: s.candidato.n, ...info };
    }

    // 5) dardo confirmado: pontua pela PONTA
    const dist = distElipse(geom, p.x, p.y);
    let pontos = 0;
    let anel = 'Fora';
    for (const a of [...(aneis || [])].sort((x, y) => x.raio - y.raio)) {
      if (dist <= a.raio) { pontos = a.pontos; anel = a.nome; break; }
    }
    const regiao = expandirRegiao(novo.pixels, N, N, 2);
    const fundoAntes = Float32Array.from(s.fundo);                 // para a caixa-preta
    const antes = amostrar(s.fundo, regiao);                       // alvo sem o dardo
    copiarRegiao(s.fundo, atual, N, N, ox, oy, regiao, 0);         // só ESTE dardo vira fundo
    const depois = amostrar(s.fundo, regiao);                      // alvo com o dardo
    s.dardos.push({ x: p.x, y: p.y, regiao, antes, depois, area: novo.area });
    refazerDonos();
    s.candidato = null;
    s.ultimoAcerto = agora;
    return {
      tipo: 'acerto', x: p.x, y: p.y, aletas: novo.aletas, dist, pontos, anel,
      area: novo.area, comp: novo.comp, espessura: novo.espessura, fundoAntes, ...info,
    };
  }

  return { processar, reiniciar, estado: s, mascara, geom };
}
