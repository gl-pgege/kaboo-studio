import { runWriter } from '../drafts/writers.service';
import type { TerminalCaller } from '../ports';

export function ownerOf(caller: TerminalCaller): string {
  return runWriter(caller.actor) ?? `chat:${caller.actor.chatId ?? caller.actor.personId ?? caller.actor.name}`;
}
