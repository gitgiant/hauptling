// `/h` slash commands (PRD "Slash commands"). STUB: `/h` is registered and answers that it is not built yet.
import type { EngineInterface, On, SessionStartInput } from 'claude-code'

/** At session start: register `/h`. */
export async function startCommands($: EngineInterface, _e: SessionStartInput): Promise<void> {
  await $.command.register({ name: 'h', description: 'Hauptling: drive this repo’s agents (kill, pause, reply, …)' })
}

export function registerCommands(on: On): void {
  on('command.run', { command: 'h' }, async () => ({ text: '/h is not built yet.' }))
}
