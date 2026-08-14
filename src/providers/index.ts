/**
 * Provider registry and selection.
 *
 * Selection fails closed in two ways: an unknown provider name is an error
 * rather than a fallback to the default, and a provider missing a mandatory
 * capability is refused outright.
 */

import { claudeProvider } from './claude.js';
import { copilotProvider } from './copilot.js';
import type { AgentProvider, ProviderId } from './types.js';
import { describeCapabilityGaps, isProviderId, missingCapabilities, PROVIDER_IDS } from './types.js';

export * from './types.js';
export { claudeProvider, copilotProvider };

const PROVIDERS: Record<ProviderId, AgentProvider> = {
  copilot: copilotProvider,
  claude: claudeProvider,
};

/**
 * Resolve a provider by name, verifying that it can enforce everything this
 * application's safety model depends on.
 */
export function selectProvider(name: string): AgentProvider {
  if (!isProviderId(name)) {
    throw new Error(`Unknown agent provider "${name}". Supported: ${PROVIDER_IDS.join(', ')}`);
  }

  const provider = PROVIDERS[name];
  const gaps = missingCapabilities(provider);
  if (gaps.length > 0) {
    throw new Error(
      `Provider "${provider.displayName}" cannot enforce this application's safety model:\n` +
        `${describeCapabilityGaps(gaps)}\n` +
        'Refusing to run. Weakened protections are not offered as an option.',
    );
  }

  return provider;
}
