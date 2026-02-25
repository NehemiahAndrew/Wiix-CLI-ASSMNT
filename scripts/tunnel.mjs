// =============================================================================
// Tunnel — exposes local dev server via localtunnel (fallback from cloudflared)
// Usage: node scripts/tunnel.mjs [port]
// =============================================================================
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.argv[2] ?? process.env.PORT ?? '3000', 10);

async function startTunnel() {
  // Try cloudflared first (binary-based, more reliable)
  try {
    const { tunnel } = await import('cloudflared');
    console.log(`\n🚇  Starting Cloudflare tunnel → http://localhost:${PORT} …\n`);

    const { url, connections, child, stop } = tunnel({ '--url': `http://localhost:${PORT}` });

    const tunnelUrl = await url;
    console.log(`✅  Tunnel live: ${tunnelUrl}\n`);

    const urlFile = resolve(__dirname, '..', 'tunnel_url.txt');
    writeFileSync(urlFile, tunnelUrl, 'utf-8');
    console.log(`📝  Written to tunnel_url.txt`);
    console.log(`\n   Set BASE_URL=${tunnelUrl} in your .env\n`);

    connections.then((conns) => {
      console.log('🔗  Connections ready:', JSON.stringify(conns, null, 2));
    });

    const shutdown = () => {
      console.log('\n🛑  Stopping tunnel …');
      stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    child.on('exit', (code) => {
      console.log(`cloudflared exited with code ${code}`);
      process.exit(code ?? 1);
    });

    return; // success — stay alive
  } catch (err) {
    console.warn(`⚠️  Cloudflared unavailable (${err.message}), falling back to localtunnel…\n`);
  }

  // Fallback: localtunnel (pure Node.js, no binary needed)
  try {
    const localtunnel = (await import('localtunnel')).default;
    console.log(`🚇  Starting localtunnel → http://localhost:${PORT} …\n`);

    const lt = await localtunnel({ port: PORT });

    console.log(`✅  Tunnel live: ${lt.url}\n`);

    const urlFile = resolve(__dirname, '..', 'tunnel_url.txt');
    writeFileSync(urlFile, lt.url, 'utf-8');
    console.log(`📝  Written to tunnel_url.txt`);
    console.log(`\n   Set BASE_URL=${lt.url} in your .env\n`);

    lt.on('close', () => {
      console.log('🛑  Tunnel closed');
      process.exit(0);
    });

    lt.on('error', (err) => {
      console.error('❌  Tunnel error:', err.message);
    });

    const shutdown = () => {
      console.log('\n🛑  Stopping tunnel …');
      lt.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    console.error('❌  Failed to start any tunnel:', err.message);
    console.error('\nInstall one of:');
    console.error('  npm install localtunnel');
    console.error('  npm install cloudflared');
    process.exit(1);
  }
}

startTunnel();
