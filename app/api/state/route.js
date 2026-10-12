import { lerEstado, gravarEstado, aplicarAcao } from '../../../lib/game';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const estado = await lerEstado();
  return Response.json(estado, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function POST(req) {
  const acao = await req.json();
  const estado = await lerEstado();
  const novo = aplicarAcao(estado, acao);
  await gravarEstado(novo);
  return Response.json(novo, { headers: { 'Cache-Control': 'no-store' } });
}
