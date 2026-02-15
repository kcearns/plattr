export const metadata = {
  title: 'example-nextjs',
  description: 'Platform example Next.js app',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
