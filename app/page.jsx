import Link from 'next/link';

export default function Home() {
  return (
    <main style={{ maxWidth: 560, margin: '0 auto', padding: 24, display: 'grid', gap: 16 }}>
      <h1 style={{ margin: '12px 0 0' }}>🎯 Contador de Dardos</h1>
      <p className="fraco" style={{ margin: 0 }}>
        Abra o placar na TV/computador e a câmera no celular que fica apontado para o alvo.
      </p>

      <Link href="/placar" className="card" style={{ textDecoration: 'none', color: 'inherit' }}>
        <h2 style={{ margin: '0 0 6px' }}>📺 Placar</h2>
        <p className="fraco" style={{ margin: 0 }}>Pontuação de cada jogador, histórico e correção manual.</p>
      </Link>

      <Link href="/camera" className="card" style={{ textDecoration: 'none', color: 'inherit' }}>
        <h2 style={{ margin: '0 0 6px' }}>📱 Câmera (celular)</h2>
        <p className="fraco" style={{ margin: 0 }}>
          Calibra o alvo, detecta os dardos e troca de jogador pelo número de dedos.
        </p>
      </Link>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Como usar</h3>
        <ol className="fraco" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
          <li>Apoie o celular firme, mirando o alvo inteiro. Ele não pode se mexer depois.</li>
          <li>Abra <b>/camera</b> no celular, toque em <b>Calibrar alvo</b> e depois no centro do alvo. Ele acha os anéis sozinho — confira se as elipses desenhadas batem com o alvo.</li>
          <li>Se o celular estiver de lado, ele pergunta para que lado ficam as aletas dos dardos na imagem.</li>
          <li>Abra <b>/placar</b> na outra tela.</li>
          <li>Para trocar de jogador, mostre os dedos para a câmera: 1 dedo = Jogador 1, 2 dedos = Jogador 2…</li>
          <li>Ao tirar os dardos do alvo, feche a mão por 1,5s (ou toque em “Alvo limpo”).</li>
        </ol>
      </div>
    </main>
  );
}
