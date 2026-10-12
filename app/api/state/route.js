import { lerEstado, registrarAcao } from '../../../lib/game';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const semCache = { headers: { 'Cache-Control': 'no-store' } };

// o histórico interno de ids não precisa ir para as telas
function publico(estado) {
  const { ids, ...resto } = estado;
  return resto;
}

export async function GET() {
  return Response.json(publico(await lerEstado()), semCache);
}

export async function POST(req) {
  const acao = await req.json();
  return Response.json(publico(await registrarAcao(acao)), semCache);
}
