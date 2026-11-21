import { execFile, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shellLine } from '../util.mjs';
import { toastXml } from './toast.mjs';

/*
 * Linux host (Ubuntu, and WSL on Windows — same thing). The broker runs as you; workers are
 * local users (hl-w1…, hl-test) driven with `sudo -n -u <user> -H` (sudoers rule from setup).
 * They reach the broker on 127.0.0.1 directly: no bridge.
 */

export const isWsl = () => existsSync('/proc/version') && /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
const sudo = (user) => ['sudo', '-n', '-u', user, '-H', '--'];
/** tmux forbids '.' and ':' in session names (model ids like gpt-5.5 have dots). */
export const tmuxName = (id) => `=${String(id).replace(/[.:]/g, '-')}`;
/** Pane/window commands need the `=session:` form on tmux 3.0. */
const pane = (id) => `${tmuxName(id)}:`;
const envArgv = (env) => (Object.keys(env).length ? ['env', ...Object.entries(env).map(([k, v]) => `${k}=${v}`)] : []);

function workerHost() {
  function run(user, argv, { env = {}, input, timeout = 600e3 } = {}) {
    const full = [...sudo(user), ...envArgv(env), ...argv];
    return new Promise((resolve, reject) => {
      const child = execFile(full[0], full.slice(1), { timeout, maxBuffer: 16 << 20, cwd: '/' }, (err, stdout, stderr) => {
        if (err) { err.stdout = stdout; err.stderr = stderr; err.message = `${argv[0]} as ${user} failed: ${(stderr || err.message).trim().slice(-600)}`; reject(err); }
        else resolve({ stdout, stderr });
      });
      if (input !== undefined) child.stdin.end(input);
    });
  }
  const tmux = (user, args, timeout = 15e3) => run(user, ['tmux', ...args], { timeout });
  return {
    kind: 'linux',
    run,
    async tmuxNew(user, session, dir, argv, env) {
      await tmux(user, ['new-session', '-d', '-s', tmuxName(session).slice(1), '-x', '220', '-y', '50', '-c', dir, shellLine([...envArgv(env), ...argv])]);
      await tmux(user, ['set-option', '-t', pane(session), 'remain-on-exit', 'on']).catch(() => {});
    },
    async tmuxAlive(user, session) {
      try { return (await tmux(user, ['display-message', '-p', '-t', pane(session), '#{pane_dead}'])).stdout.trim() === '0'; } catch { return false; }
    },
    async tmuxType(user, session, text) {
      await tmux(user, ['send-keys', '-t', pane(session), '-l', String(text).replace(/\s*\n\s*/g, ' ')]);
      await new Promise(r => setTimeout(r, 300));
      await tmux(user, ['send-keys', '-t', pane(session), 'Enter']);
    },
    async tmuxCapture(user, session, lines = 20) {
      return (await tmux(user, ['capture-pane', '-p', '-t', pane(session), '-S', `-${lines}`])).stdout;
    },
    async tmuxKill(user, session) { await tmux(user, ['kill-session', '-t', tmuxName(session)]).catch(() => {}); },
    attachArgv: (user, session) => [...sudo(user), 'tmux', 'attach', '-t', tmuxName(session)],
    spawnDetached(user, argv, env) {
      const full = [...sudo(user), ...envArgv(env), ...argv];
      const child = spawn(full[0], full.slice(1), { detached: true, stdio: 'ignore', cwd: '/' });
      child.unref();
    },
  };
}

/** Notification for a blocked agent. Buttons/links open the broker's answer page (works from any browser). */
function notify({ title, body, choices, links }) {
  if (process.env.HAUPTLING_NO_TOAST) return false;
  if (isWsl()) {
    // Windows toast through interop; its buttons open http://127.0.0.1 links, which Windows forwards into WSL.
    const xml = toastXml({ title, body, choices, links });
    const script = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(xml).toString('base64')}')))
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($doc))`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  }
  const child = spawn('notify-send', ['-u', 'critical', title, links ? `${body}\nAnswer: ${links.page}` : body], { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
  return true;
}

export default {
  name: 'linux',
  workerHost,
  notify,
  asUser: (user, argv) => ['sudo', '-u', user, '-i', '--', ...argv],
  asUserSync: (user, argv) => spawnSync('sudo', ['-n', '-u', user, '-H', '--', ...argv], { encoding: 'utf8', cwd: '/' }),
  rootSh: (script) => spawnSync('sudo', ['bash', '-c', script], { encoding: 'utf8' }),
  provisionWorkers({ slots, root }) {
    const r = spawnSync('sudo', ['bash', join(root, 'scripts', 'setup-linux-workers.sh'), String(slots), root, process.env.USER || ''], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('Worker setup failed (see output above)');
  },
  setupHost: () => [],
};
