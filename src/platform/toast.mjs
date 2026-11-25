/*
 * Windows toast XML that acts like AskUserQuestion: up to 4 choice buttons plus "Other…".
 * Buttons open http://127.0.0.1 links to the broker's answer page (Windows forwards localhost
 * into WSL), so no URL protocol registration is needed.
 */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function toastXml({ title, body, choices = [], links, dashboard }) {
  const visual = `<visual><binding template="ToastGeneric"><text>${esc(title)}</text><text>${esc(body)}</text></binding></visual>`;
  const button = (label, url) => `<action content="${esc(label)}" activationType="protocol" arguments="${esc(url)}"/>`;
  const dismiss = '<action content="Dismiss" activationType="system" arguments="dismiss"/>';
  if (!links) {
    if (!dashboard) return `<toast scenario="reminder">${visual}<actions>${dismiss}</actions></toast>`;
    return `<toast scenario="reminder" activationType="protocol" launch="${esc(dashboard)}">${visual}<actions>${button('Open dashboard', dashboard)}${dismiss}</actions></toast>`;
  }
  // Toasts hold 5 buttons: up to 4 choices + "Other…"; "Dashboard" fits only with fewer choices.
  const actions = choices.slice(0, 4).map((c, i) => button(c.slice(0, 40), links.choice(i))).join('') + button('Other…', links.page)
    + (dashboard && choices.length < 4 ? button('Dashboard', dashboard) : '');
  return `<toast scenario="reminder" activationType="protocol" launch="${esc(links.page)}">`
    + visual
    + `<actions>${actions}</actions></toast>`;
}
