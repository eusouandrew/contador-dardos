// Utilitários de visão: diferença de quadros + componentes conexos.

export function cinza(imageData, saida) {
  const d = imageData.data;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    saida[p] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
  }
  return saida;
}

// Pixels que mudaram em relação ao fundo, dentro do círculo do alvo.
export function mascaraDiferenca(atual, fundo, larg, alt, centro, raio, limiar, mascara) {
  const limite = raio * 1.45;
  let mudados = 0;
  mascara.fill(0);
  const x0 = Math.max(0, Math.floor(centro.x - limite));
  const x1 = Math.min(larg - 1, Math.ceil(centro.x + limite));
  const y0 = Math.max(0, Math.floor(centro.y - limite));
  const y1 = Math.min(alt - 1, Math.ceil(centro.y + limite));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - centro.x;
      const dy = y - centro.y;
      if (dx * dx + dy * dy > limite * limite) continue;
      const i = y * larg + x;
      if (Math.abs(atual[i] - fundo[i]) > limiar) {
        mascara[i] = 1;
        mudados++;
      }
    }
  }
  return mudados;
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
