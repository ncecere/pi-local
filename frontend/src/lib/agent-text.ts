/**
 * The placeholders and hints of an agent's description and instructions, by
 * its kind: the New agent dialog and the Overview tab say the same.
 */
export interface AgentFieldText {
  description: string;
  instructions: string;
  instructionsHint: string;
}

const CODING: AgentFieldText = {
  description: 'Works on my project',
  instructions: 'Run the tests before you say you are done…',
  instructionsHint: 'Added to the coding prompt, like an AGENTS.md of its own.',
};

const OTHER: AgentFieldText = {
  description: 'Finds and summarizes papers',
  instructions: 'You help me keep track of research papers…',
  instructionsHint: 'Leave empty to use the default prompt for its kind.',
};

/** The text for an agent of this kind (its `agentKind`, or a new one's template ID). */
export function agentFieldText(kind: string | null | undefined): AgentFieldText {
  return kind === 'coding' ? CODING : OTHER;
}
