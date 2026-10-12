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
export function mascaraDiferenca(atual, fundo, larg, alt, centro, raioMax, limiar, mascara) {
  let mudados = 0;
  let total = 0;
  mascara.fill(0);
  const r2 = raioMax * raioMax;
  for (let y = 0; y < alt; y++) {
    const dy = y - centro.y;
    for (let x = 0; x < larg; x++) {
      const dx = x - centro.x;
      if (dx * dx + dy * dy > r2) continue;
      total++;
      const i = y * larg + x;
      const p = i * 3;
      const dif = Math.max(
        Math.abs(atual[p] - fundo[p]),
        Math.abs(atual[p + 1] - fundo[p + 1]),
        Math.abs(atual[p + 2] - fundo[p + 2])
      );
      if (dif > limiar) {
        mascara[i] = 1;
        mudados++;
      }
    }
  }
  return { mudados, total };
}

// Puxa o fundo devagar para o quadro atual onde nada mudou de verdade,
// absorvendo variações lentas de luz sem engolir um dardo novo.
export function adaptarFundo(fundo, atual, mascara, taxa) {
  for (let i = 0; i < mascara.length; i++) {
    if (mascara[i]) continue;
    const p = i * 3;
    fundo[p] += (atual[p] - fundo[p]) * taxa;
    fundo[p + 1] += (atual[p + 1] - fundo[p + 1]) * taxa;
    fundo[p + 2] += (atual[p + 2] - fundo[p + 2]) * taxa;
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
