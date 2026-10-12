'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export default function Placar() {
  const [estado, setEstado] = useState(null);
  const [online, setOnline] = useState(true);
  const [revisando, setRevisando] = useState(null); // lance aberto na revisão
  const versao = useRef(-1); // o placar novo começa na versão 0

  const enviar = useCallback(async (acao) => {
    try {
      const r = await fetch('/api/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(acao),
      });
      const novo = await r.json();
      versao.current = novo.v;
      setEstado(novo);
    } catch {
      setOnline(false);
    }
  }, []);

  useEffect(() => {
    let vivo = true;
    const buscar = async () => {
      try {
        const r = await fetch('/api/state', { cache: 'no-store' });
        const novo = await r.json();
        if (!vivo) return;
        setOnline(true);
        if (novo.v !== versao.current) {
          versao.current = novo.v;
          setEstado(novo);
        }
      } catch {
        if (vivo) setOnline(false);
      }
    };
    buscar();
    const id = setInterval(buscar, 800);
    return () => {
      vivo = false;
      clearInterval(id);
    };
  }, []);

  if (!estado) {
    return <main style={{ padding: 24 }} className="fraco">Carregando placar…</main>;
  }

  const ultimo = estado.historico[0];

  return (
    <main style={{ maxWidth: 1100, margin: '0 auto', padding: 20, display: 'grid', gap: 16 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>🎯 Placar</h1>
        <span className="fraco" style={{ fontSize: 13 }}>
          {online ? '● conectado' : '○ sem conexão'}
        </span>
      </header>

      <section
        style={{
          display: 'grid',
          gap: 12,
          gridTemplateColumns: `repeat(${Math.min(estado.jogadores.length, 2)}, minmax(0, 1fr))`,
        }}
      >
        {estado.jogadores.map((j, i) => {
          const ativo = i === estado.atual;
          return (
            <div
              key={i}
              className="card"
              onClick={() => enviar({ tipo: 'jogador', indice: i })}
              style={{
                borderColor: ativo ? 'var(--amarelo)' : 'var(--borda)',
                boxShadow: ativo ? '0 0 0 2px rgba(242,197,0,.25)' : 'none',
                cursor: 'pointer',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <input
                  value={j.nome}
                  onClick={(ev) => ev.stopPropagation()}
                  onChange={(ev) => enviar({ tipo: 'renomear', indice: i, nome: ev.target.value })}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'inherit',
                    font: 'inherit',
                    fontWeight: 600,
                    fontSize: 18,
                    width: '70%',
                  }}
                />
                <span className="fraco" style={{ fontSize: 13 }}>#{i + 1}</span>
              </div>
              <div
                style={{
                  fontSize: 'clamp(48px, 12vw, 104px)',
                  fontWeight: 800,
                  lineHeight: 1.05,
                  color: ativo ? 'var(--amarelo)' : 'var(--txt)',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {j.pontos}
              </div>
              <div className="fraco" style={{ fontSize: 14 }}>
                {j.dardos} dardo{j.dardos === 1 ? '' : 's'}
                {ativo ? ' · jogando agora' : ''}
              </div>
            </div>
          );
        })}
      </section>

      <section className="card" style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        <button className="primario" onClick={() => enviar({ tipo: 'proximo' })}>Próximo jogador</button>
        <button onClick={() => enviar({ tipo: 'desfazer' })}>Desfazer último</button>
        {estado.aneis.map((a) => (
          <button key={a.nome} onClick={() => enviar({ tipo: 'acerto', pontos: a.pontos, anel: a.nome, origem: 'manual' })}>
            +{a.pontos}
          </button>
        ))}
        <button onClick={() => enviar({ tipo: 'acerto', pontos: 0, anel: 'Errou', origem: 'manual' })}>Errou (0)</button>
        <span style={{ flex: 1 }} />
        <button onClick={() => enviar({ tipo: 'addJogador' })}>+ jogador</button>
        <button onClick={() => enviar({ tipo: 'removeJogador' })}>− jogador</button>
        <button className="perigo" onClick={() => confirm('Zerar o placar?') && enviar({ tipo: 'zerar' })}>Zerar</button>
      </section>

      {ultimo && (
        <div className="card" style={{ textAlign: 'center' }}>
          <span className="fraco">Último: </span>
          <b>{ultimo.nome}</b> · {ultimo.anel} ·{' '}
          <b style={{ color: 'var(--amarelo)' }}>{ultimo.pontos} pts</b>{' '}
          <span className="fraco">({ultimo.origem})</span>
        </div>
      )}

      <section className="card">
        <h3 style={{ margin: '0 0 10px' }}>Histórico</h3>
        {estado.historico.length === 0 && <p className="fraco" style={{ margin: 0 }}>Nenhum lance ainda.</p>}
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6, maxHeight: 280, overflow: 'auto' }}>
          {estado.historico.map((h, i) => (
            <li key={(h.id || h.t) + '-' + i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 15 }}>
              <span>
                {h.nome} · {h.anel}
                {h.corrigido && <span className="fraco"> (corrigido de {h.corrigido.de})</span>}
              </span>
              <span className="fraco" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {h.pontos} pts · {new Date(h.t).toLocaleTimeString('pt-BR')}
                {(h.registro || h.origem === 'manual') && h.id && (
                  <button
                    onClick={() => setRevisando(h)}
                    title="Ver o que a câmera viu e corrigir"
                    style={{ padding: '4px 8px', fontSize: 13 }}
                  >
                    📷
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {revisando && (
        <Revisao
          lance={revisando}
          aneis={estado.aneis}
          enviar={enviar}
          fechar={() => setRevisando(null)}
        />
      )}
    </main>
  );
}

// Revisão de um lance: o que a câmera viu (antes/depois, com a ponta marcada)
// e botões para corrigir. A correção vale no placar e fica gravada na
// caixa-preta para ajustar o detector.
function Revisao({ lance, aneis, enviar, fechar }) {
  const idRegistro = lance.registro || `f-${lance.id}`;
  const [reg, setReg] = useState(undefined); // undefined = carregando, null = sem registro
  const [feito, setFeito] = useState('');

  useEffect(() => {
    let vivo = true;
    fetch(`/api/registros?id=${encodeURIComponent(idRegistro)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => vivo && setReg(j))
      .catch(() => vivo && setReg(null));
    return () => { vivo = false; };
  }, [idRegistro]);

  const avaliar = (correto, pontosCertos) =>
    fetch('/api/registros', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ avaliar: idRegistro, correto, pontosCertos }),
    }).catch(() => {});

  const corrigir = async (pontos, anel) => {
    await enviar({ tipo: 'corrigir', alvo: lance.id, pontos, anel });
    if (reg) avaliar(false, pontos);
    setFeito(`Corrigido para ${pontos} pts`);
  };
  const remover = async () => {
    await enviar({ tipo: 'remover', alvo: lance.id });
    if (reg) avaliar(false, 'fantasma');
    setFeito('Lance removido');
  };
  const confirmar = () => {
    avaliar(true, lance.pontos);
    setFeito('Obrigado — marcado como certo');
  };

  const m = reg?.meta;
  const g = m?.geom;
  const daCamera = lance.origem !== 'manual';

  return (
    <div
      onClick={fechar}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.7)', display: 'grid', placeItems: 'center', padding: 16, zIndex: 20 }}
    >
      <div className="card" onClick={(e) => e.stopPropagation()} style={{ width: 'min(640px, 100%)', display: 'grid', gap: 12, maxHeight: '92vh', overflow: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <b>{lance.nome} · {lance.anel} · {lance.pontos} pts</b>
          <button onClick={fechar}>Fechar</button>
        </div>

        {reg === undefined && <span className="fraco">Carregando o que a câmera viu…</span>}
        {reg === null && <span className="fraco">Sem imagens para este lance.</span>}
        {reg && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {[['Antes', reg.antes], ['Depois', reg.depois]].map(([rotulo, src]) => (
                <figure key={rotulo} style={{ margin: 0 }}>
                  <div style={{ position: 'relative' }}>
                    {src && <img src={src} alt={rotulo} style={{ width: '100%', display: 'block', borderRadius: 8 }} />}
                    {g && rotulo === 'Depois' && (
                      <svg viewBox={`0 0 ${m.N || 220} ${m.N || 220}`} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
                        {aneis.map((a) => (
                          <ellipse
                            key={a.nome}
                            cx={g.cx + (m.ox || 0)}
                            cy={g.cy + (m.oy || 0)}
                            rx={g.a * a.raio}
                            ry={g.b * a.raio}
                            transform={`rotate(${(g.ang * 180) / Math.PI} ${g.cx + (m.ox || 0)} ${g.cy + (m.oy || 0)})`}
                            fill="none"
                            stroke="#fff"
                            strokeOpacity=".7"
                            strokeWidth="1"
                          />
                        ))}
                        {m.ponta && (
                          <circle cx={m.ponta.x + (m.ox || 0)} cy={m.ponta.y + (m.oy || 0)} r="4" fill="#2fbf71" stroke="#000" strokeWidth="1" />
                        )}
                      </svg>
                    )}
                  </div>
                  <figcaption className="fraco" style={{ fontSize: 12, marginTop: 4 }}>{rotulo}</figcaption>
                </figure>
              ))}
            </div>
            <span className="fraco" style={{ fontSize: 13 }}>
              {daCamera
                ? `Ponto verde = onde a câmera achou a ponta (distância ${m?.dist?.toFixed?.(2) ?? '—'} do centro).`
                : 'A câmera não contou este dardo — você somou à mão. Essas imagens mostram o que ela via.'}
            </span>
          </>
        )}

        {daCamera && !feito && (
          <div style={{ display: 'grid', gap: 8 }}>
            <button className="primario" onClick={confirmar}>✓ A câmera acertou</button>
            <span className="fraco" style={{ fontSize: 13 }}>Errou? O dardo foi em:</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {aneis.map((a) => (
                <button key={a.nome} onClick={() => corrigir(a.pontos, a.nome)} disabled={a.pontos === lance.pontos}>
                  {a.nome} ({a.pontos})
                </button>
              ))}
              <button onClick={() => corrigir(0, 'Fora')} disabled={lance.pontos === 0}>Fora (0)</button>
              <button className="perigo" onClick={remover}>Não teve dardo</button>
            </div>
          </div>
        )}
        {feito && <b style={{ color: 'var(--verde)' }}>{feito}</b>}
      </div>
    </div>
  );
}
