import { describe, expect, it } from 'vitest';
import { yamlProblem } from '../../src/components/agent-manager/config-tab';
import { agentFieldText } from '../../src/lib/agent-text';
import { DEMO_MODEL_ID, onlyDemoModel } from '../../src/lib/models';

describe('agentFieldText', () => {
  it('suggests a coding agent its own placeholders and hint', () => {
    expect(agentFieldText('coding')).toEqual({
      description: 'Works on my project',
      instructions: 'Run the tests before you say you are done…',
      instructionsHint: 'Added to the coding prompt, like an AGENTS.md of its own.',
    });
  });

  it('keeps the research example for the other kinds', () => {
    expect(agentFieldText('researcher').description).toBe('Finds and summarizes papers');
    expect(agentFieldText(undefined).instructionsHint).toBe(
      'Leave empty to use the default prompt for its kind.',
    );
  });
});

describe('yamlProblem', () => {
  it("drops the file name the notice already says, and keeps the server's reason", () => {
    expect(yamlProblem('agent.yaml: line 3: there is no setting "unknownKey"')).toBe(
      'line 3: there is no setting "unknownKey"',
    );
    expect(yamlProblem('yaml: line 2: did not find expected key')).toBe(
      'yaml: line 2: did not find expected key',
    );
  });
});

describe('onlyDemoModel', () => {
  it('is true with nothing but the demo model (no provider yet)', () => {
    expect(onlyDemoModel([{ id: DEMO_MODEL_ID, name: 'Demo' }])).toBe(true);
    expect(onlyDemoModel([])).toBe(true);
  });

  it('is false once a provider has a model', () => {
    expect(
      onlyDemoModel([
        { id: DEMO_MODEL_ID, name: 'Demo' },
        { id: 'openai/gpt-5', name: 'GPT-5', provider: 'openai' },
      ]),
    ).toBe(false);
  });
});
