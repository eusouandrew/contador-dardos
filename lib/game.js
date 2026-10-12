// Estado do jogo + persistência.
// Por padrão guarda em memória (suficiente para 2 telas, região única em vercel.json).
// Se existirem as variáveis do Upstash/Vercel KV, usa o KV e sobrevive a cold start.

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const KEY = 'dardos:estado';

export const ANEIS_PADRAO = [
  { nome: 'Mosca (vermelho)', raio: 0.2, pontos: 200, cor: '#e23b2e' },
  { nome: 'Amarelo', raio: 0.46, pontos: 100, cor: '#f2c500' },
  { nome: 'Preto', raio: 1.0, pontos: 50, cor: '#1d1d1d' },
];

function estadoInicial() {
  return {
    v: 1,
    jogadores: [
      { nome: 'Jogador 1', pontos: 0, dardos: 0 },
      { nome: 'Jogador 2', pontos: 0, dardos: 0 },
    ],
    atual: 0,
    aneis: ANEIS_PADRAO,
    dardosPorRodada: 3,
    historico: [], // { jogador, nome, pontos, anel, origem, t }
    atualizadoEm: Date.now(),
  };
}

let memoria = estadoInicial();

export async function lerEstado() {
  if (KV_URL && KV_TOKEN) {
    try {
      const r = await fetch(`${KV_URL}/get/${KEY}`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` },
        cache: 'no-store',
      });
      const j = await r.json();
      if (j?.result) return JSON.parse(j.result);
    } catch {
      /* cai para memória */
    }
    return memoria;
  }
  return memoria;
}

export async function gravarEstado(estado) {
  estado.v = (estado.v || 0) + 1;
  estado.atualizadoEm = Date.now();
  memoria = estado;
  if (KV_URL && KV_TOKEN) {
    try {
      await fetch(`${KV_URL}/set/${KEY}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${KV_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(JSON.stringify(estado)),
      });
    } catch {
      /* segue com memória */
    }
  }
  return estado;
}

export function pontosDoRaio(aneis, raioRelativo) {
  const lista = [...aneis].sort((a, b) => a.raio - b.raio);
  for (const anel of lista) {
    if (raioRelativo <= anel.raio) return { pontos: anel.pontos, anel: anel.nome };
  }
  return { pontos: 0, anel: 'Fora' };
}

export function aplicarAcao(estado, acao) {
  const e = JSON.parse(JSON.stringify(estado));

  switch (acao.tipo) {
    case 'acerto': {
      const idx = typeof acao.jogador === 'number' ? acao.jogador : e.atual;
      const j = e.jogadores[idx];
      if (!j) break;
      const pontos = Number(acao.pontos) || 0;
      j.pontos += pontos;
      j.dardos += 1;
      e.historico.unshift({
        jogador: idx,
        nome: j.nome,
        pontos,
        anel: acao.anel || '—',
        origem: acao.origem || 'camera',
        t: Date.now(),
      });
      e.historico = e.historico.slice(0, 60);
      break;
    }
    case 'jogador': {
      const idx = Number(acao.indice);
      if (idx >= 0 && idx < e.jogadores.length) e.atual = idx;
      break;
    }
    case 'proximo': {
      e.atual = (e.atual + 1) % e.jogadores.length;
      break;
    }
    case 'desfazer': {
      const ultimo = e.historico.shift();
      if (ultimo) {
        const j = e.jogadores[ultimo.jogador];
        if (j) {
          j.pontos -= ultimo.pontos;
          j.dardos = Math.max(0, j.dardos - 1);
        }
      }
      break;
    }
    case 'renomear': {
      const j = e.jogadores[Number(acao.indice)];
      if (j && acao.nome) j.nome = String(acao.nome).slice(0, 20);
      break;
    }
    case 'addJogador': {
      if (e.jogadores.length < 4) {
        e.jogadores.push({ nome: `Jogador ${e.jogadores.length + 1}`, pontos: 0, dardos: 0 });
      }
      break;
    }
    case 'removeJogador': {
      if (e.jogadores.length > 1) {
        e.jogadores.pop();
        e.atual = Math.min(e.atual, e.jogadores.length - 1);
      }
      break;
    }
    case 'aneis': {
      if (Array.isArray(acao.aneis)) e.aneis = acao.aneis;
      break;
    }
    case 'zerar': {
      e.jogadores = e.jogadores.map((j) => ({ ...j, pontos: 0, dardos: 0 }));
      e.historico = [];
      e.atual = 0;
      break;
    }
    default:
      break;
  }
  return e;
}

export function novoJogo() {
  return estadoInicial();
}
