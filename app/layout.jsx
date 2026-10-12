import './globals.css';

export const metadata = {
  title: 'Contador de Dardos',
  description: 'Placar automático por câmera com troca de jogador por gesto',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#0b0d10',
};

export default function RootLayout({ children }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
