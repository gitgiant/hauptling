import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { toastXml } from './toast.mjs';

/* Linux host (Ubuntu, and WSL on Windows — same thing): notifications. Workers run in Docker (src/docker.mjs). */

export const isWsl = () => existsSync('/proc/version') && /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
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
  notify,
  setupHost: () => [],
};
