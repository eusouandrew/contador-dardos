// Caixa-preta: imagens e decisões do detector para cada lance (e para os
// dardos que a câmera não viu), para revisar no placar e ajustar o detector.
import { kvComando } from '../../../lib/game';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LISTA = 'dardos:regs';
const META = (id) => `dardos:reg:meta:${id}`;
const IMGS = (id) => `dardos:reg:img:${id}`;
const GUARDAR = 80;               // registros mais recentes
const VALIDADE_S = 60 * 60 * 24 * 21; // 3 semanas
const semCache = { headers: { 'Cache-Control': 'no-store' } };

const idValido = (id) => typeof id === 'string' && /^[a-z0-9-]{4,60}$/i.test(id);

// GET            → lista (só metadados)
// GET ?id=…      → um registro com as imagens
export async function GET(req) {
  const id = new URL(req.url).searchParams.get('id');
  if (id) {
    if (!idValido(id)) return Response.json({ erro: 'id inválido' }, { status: 400 });
    const [meta, imgs] = await Promise.all([kvComando(['GET', META(id)]), kvComando(['GET', IMGS(id)])]);
    if (!meta) return Response.json({ erro: 'não encontrado' }, { status: 404 });
    return Response.json({ ...JSON.parse(meta), ...(imgs ? JSON.parse(imgs) : {}) }, semCache);
  }
  const ids = await kvComando(['LRANGE', LISTA, 0, GUARDAR - 1]);
  if (!ids.length) return Response.json([], semCache);
  const metas = await kvComando(['MGET', ...ids.map(META)]);
  return Response.json(metas.filter(Boolean).map((m) => JSON.parse(m)), semCache);
}

// POST { id, tipo, meta, antes, depois }  → grava um registro
// POST { avaliar: id, correto, pontosCertos, nota } → marca o veredito do jogador
export async function POST(req) {
  const corpo = await req.json();

  if (corpo.avaliar) {
    if (!idValido(corpo.avaliar)) return Response.json({ erro: 'id inválido' }, { status: 400 });
    const meta = await kvComando(['GET', META(corpo.avaliar)]);
    if (!meta) return Response.json({ erro: 'não encontrado' }, { status: 404 });
    const atual = JSON.parse(meta);
    atual.avaliacao = {
      correto: !!corpo.correto,
      pontosCertos: corpo.pontosCertos ?? null,
      nota: String(corpo.nota || '').slice(0, 200),
      t: Date.now(),
    };
    await kvComando(['SET', META(corpo.avaliar), JSON.stringify(atual), 'EX', VALIDADE_S]);
    return Response.json(atual, semCache);
  }

  const { id, tipo, meta = {}, antes, depois } = corpo;
  if (!idValido(id)) return Response.json({ erro: 'id inválido' }, { status: 400 });
  const imagem = (s) => typeof s === 'string' && s.startsWith('data:image/jpeg;base64,') && s.length < 400000;
  if ((antes && !imagem(antes)) || (depois && !imagem(depois))) {
    return Response.json({ erro: 'imagem inválida' }, { status: 400 });
  }
  const registro = { id, tipo: String(tipo || 'acerto').slice(0, 20), t: Date.now(), meta };
  await kvComando(['SET', META(id), JSON.stringify(registro), 'EX', VALIDADE_S]);
  await kvComando(['SET', IMGS(id), JSON.stringify({ antes: antes || null, depois: depois || null }), 'EX', VALIDADE_S]);
  await kvComando(['LPUSH', LISTA, id]);
  await kvComando(['LTRIM', LISTA, 0, GUARDAR - 1]);
  return Response.json({ ok: true, id }, semCache);
}
