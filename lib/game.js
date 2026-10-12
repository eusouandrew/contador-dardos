// Estado do jogo como registro de lances (event log).
//
// Cada ação é ANEXADA a uma lista no Redis (RPUSH é atômico) e o placar é
// calculado aplicando os lances em ordem. Assim:
//  - duas telas gravando ao mesmo tempo não apagam uma à outra;
//  - cada lance tem um id: o celular pode reenviar depois de uma falha de rede
//    sem contar o ponto duas vezes;
//  - de tempos em tempos um "retrato" do placar é salvo para não reler tudo.
// Sem as variáveis do Upstash/Vercel KV, guarda em memória (desenvolvimento).

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const LOG = 'dardos:log';
const RETRATO = 'dardos:snap';
const LEGADO = 'dardos:estado'; // formato antigo (estado inteiro numa chave)
const RETRATO_A_CADA = 150;      // lances
const IDS_LEMBRADOS = 300;

export const ANEIS_PADRAO = [
  { nome: 'Mosca (vermelho)', raio: 0.2, pontos: 200, cor: '#e23b2e' },
  { nome: 'Amarelo', raio: 0.57, pontos: 100, cor: '#f2c500' },
  { nome: 'Preto', raio: 1.0, pontos: 50, cor: '#1d1d1d' },
];

function estadoInicial() {
  return {
    v: 0,
    jogadores: [
      { nome: 'Jogador 1', pontos: 0, dardos: 0 },
      { nome: 'Jogador 2', pontos: 0, dardos: 0 },
    ],
    atual: 0,
    aneis: ANEIS_PADRAO,
    dardosPorRodada: 3,
    historico: [], // { id, jogador, nome, pontos, anel, origem, t, registro?, corrigido? }
    ids: [],       // ids de lances já aplicados (para ignorar reenvios)
    atualizadoEm: 0,
  };
}

export const usandoKV = !!(KV_URL && KV_TOKEN);

async function kv(comando) {
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    body: JSON.stringify(comando),
    cache: 'no-store',
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

// ---------------------------------------------------------------------------
// memória (sem KV)
const mem = { log: [], retrato: null, extra: new Map() };

export async function kvComando(comando) {
  if (usandoKV) return kv(comando);
  // subconjunto mínimo usado pelos registros, para rodar sem Redis
  const [cmd, chave, ...args] = comando;
  switch (cmd) {
    case 'SET': mem.extra.set(chave, args[0]); return 'OK';
    case 'GET': return mem.extra.get(chave) ?? null;
    case 'MGET': return [chave, ...args].map((k) => mem.extra.get(k) ?? null);
    case 'LPUSH': { const l = mem.extra.get(chave) || []; l.unshift(args[0]); mem.extra.set(chave, l); return l.length; }
    case 'LTRIM': { const l = mem.extra.get(chave) || []; mem.extra.set(chave, l.slice(Number(args[0]), Number(args[1]) + 1)); return 'OK'; }
    case 'LRANGE': { const l = mem.extra.get(chave) || []; const fim = Number(args[1]); return l.slice(Number(args[0]), fim < 0 ? l.length + fim + 1 : fim + 1); }
    default: throw new Error('comando não suportado em memória: ' + cmd);
  }
}

// ---------------------------------------------------------------------------
// leitura / escrita

async function lerBase() {
  if (!usandoKV) return mem.retrato || { estado: estadoInicial(), ate: -1 };
  const retrato = await kv(['GET', RETRATO]);
  if (retrato) return JSON.parse(retrato);
  // primeira vez no formato novo: parte do placar antigo, se existir
  const legado = await kv(['GET', LEGADO]);
  const base = legado ? { ...estadoInicial(), ...JSON.parse(legado), ids: [] } : estadoInicial();
  base.historico = (base.historico || []).map((h, i) => ({ id: h.id || `legado-${i}`, ...h }));
  return { estado: base, ate: -1 };
}

export async function lerEstado() {
  const { estado: base, ate } = await lerBase();
  const brutos = usandoKV ? await kv(['LRANGE', LOG, ate + 1, -1]) : mem.log.slice(ate + 1);
  const lances = brutos.map((b) => (typeof b === 'string' ? JSON.parse(b) : b));
  const estado = lances.reduce(aplicarAcao, base);
  estado.v = ate + 1 + lances.length;

  if (lances.length >= RETRATO_A_CADA) {
    // retrato de um prefixo do log: imutável, então gravar por cima é seguro
    const retrato = { estado, ate: ate + lances.length };
    try {
      if (usandoKV) await kv(['SET', RETRATO, JSON.stringify(retrato)]);
      else mem.retrato = JSON.parse(JSON.stringify(retrato));
    } catch { /* tenta de novo na próxima leitura */ }
  }
  return estado;
}

export async function registrarAcao(acao) {
  const lance = {
    ...acao,
    id: acao.id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    t: acao.t || Date.now(),
  };
  if (usandoKV) await kv(['RPUSH', LOG, JSON.stringify(lance)]);
  else mem.log.push(lance);
  return lerEstado();
}

// ---------------------------------------------------------------------------
// regras do jogo (pura: o mesmo log sempre dá o mesmo placar)

export function pontosDoRaio(aneis, raioRelativo) {
  const lista = [...aneis].sort((a, b) => a.raio - b.raio);
  for (const anel of lista) {
    if (raioRelativo <= anel.raio) return { pontos: anel.pontos, anel: anel.nome };
  }
  return { pontos: 0, anel: 'Fora' };
}

export function aplicarAcao(estado, acao) {
  const e = JSON.parse(JSON.stringify(estado));
  e.ids = e.ids || [];
  if (acao.id && e.ids.includes(acao.id)) return e; // reenvio: já aplicado
  if (acao.id) e.ids = [...e.ids, acao.id].slice(-IDS_LEMBRADOS);
  e.atualizadoEm = acao.t || e.atualizadoEm;

  switch (acao.tipo) {
    case 'acerto': {
      const idx = typeof acao.jogador === 'number' ? acao.jogador : e.atual;
      const j = e.jogadores[idx];
      if (!j) break;
      const pontos = Number(acao.pontos) || 0;
      j.pontos += pontos;
      j.dardos += 1;
      e.historico.unshift({
        id: acao.id,
        jogador: idx,
        nome: j.nome,
        pontos,
        anel: acao.anel || '—',
        origem: acao.origem || 'camera',
        registro: acao.registro || null,
        t: acao.t,
      });
      e.historico = e.historico.slice(0, 60);
      break;
    }
    case 'corrigir': {
      // muda o valor de um lance já contado (ex.: câmera disse 200, era 100)
      const h = e.historico.find((x) => x.id === acao.alvo);
      if (!h) break;
      const j = e.jogadores[h.jogador];
      const pontos = Number(acao.pontos) || 0;
      if (j) j.pontos += pontos - h.pontos;
      h.corrigido = { de: h.pontos, deAnel: h.anel };
      h.pontos = pontos;
      h.anel = acao.anel || h.anel;
      break;
    }
    case 'remover': {
      // lance que não existiu (ex.: câmera viu um dardo fantasma)
      const i = e.historico.findIndex((x) => x.id === acao.alvo);
      if (i < 0) break;
      const [h] = e.historico.splice(i, 1);
      const j = e.jogadores[h.jogador];
      if (j) {
        j.pontos -= h.pontos;
        j.dardos = Math.max(0, j.dardos - 1);
      }
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
