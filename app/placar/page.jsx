'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export default function Placar() {
  const [estado, setEstado] = useState(null);
  const [online, setOnline] = useState(true);
  const versao = useRef(0);

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
            <li key={h.t + '-' + i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15 }}>
              <span>{h.nome} · {h.anel}</span>
              <span className="fraco">
                {h.pontos} pts · {new Date(h.t).toLocaleTimeString('pt-BR')}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
