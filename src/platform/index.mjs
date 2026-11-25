/*
 * Host platform seam. Core logic (store, mailbox, broker API, PR flow, tests) is platform-free;
 * what depends on the host OS goes through one adapter:
 *
 *   name                        'linux' (Ubuntu, and WSL on Windows)
 *   notify(spec)                AskUserQuestion-style notification ({ title, body, choices, links: { page, choice(i) } })
 *   setupHost({ root })         host-only extras; returns lines to print
 *   openUrl(url)                open a page in your browser (`hauptling dashboard`)
 *
 * Workers run in Docker containers on every host (src/docker.mjs). Windows hosts run everything inside WSL, so they use the linux adapter. macOS is planned
 * (native or a Linux VM); see PRD.md "Turnkey deployment".
 */
export async function platform(name = process.env.HAUPTLING_PLATFORM || process.platform) {
  if (name === 'linux') return (await import('./linux.mjs')).default;
  if (name === 'win32') throw new Error('On Windows, hauptling runs inside WSL: run install.cmd, then use hauptling from a WSL terminal');
  throw new Error(`Hauptling does not support ${name} hosts yet (macOS is planned)`);
}
