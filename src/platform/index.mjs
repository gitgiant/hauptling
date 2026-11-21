/*
 * Host platform seam. Core logic (store, mailbox, broker API, PR flow, tests) is platform-free;
 * what depends on the host OS goes through one adapter:
 *
 *   name                        'linux' (Ubuntu, and WSL on Windows)
 *   workerHost()                where workers run: { run, tmuxNew, tmuxAlive, tmuxType, tmuxKill, attachArgv, spawnDetached }
 *   notify(spec)                AskUserQuestion-style notification ({ title, body, choices, links: { page, choice(i) } })
 *   asUser(user, argv)          argv that runs argv interactively as a worker user (sign-in)
 *   asUserSync(user, argv)      spawnSync result of argv as a worker user (doctor probes)
 *   provisionWorkers({ slots, root })   installs tools and creates worker users (inherits stdio, may ask for sudo)
 *   setupHost({ root })         host-only extras; returns lines to print
 *
 * Windows hosts run everything inside WSL, so they use the linux adapter. macOS is planned
 * (native or a Linux VM); see PRD.md "Turnkey deployment".
 */
export async function platform(name = process.env.HAUPTLING_PLATFORM || process.platform) {
  if (name === 'linux') return (await import('./linux.mjs')).default;
  if (name === 'win32') throw new Error('On Windows, hauptling runs inside WSL: run install.cmd, then use hauptling from a WSL terminal');
  throw new Error(`Hauptling does not support ${name} hosts yet (macOS is planned)`);
}
