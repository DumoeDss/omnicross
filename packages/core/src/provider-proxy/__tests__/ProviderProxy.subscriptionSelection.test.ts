import { describe, it } from 'vitest';
import { runSubscriptionSelectionCase, type SelectionIngress } from './subscriptionSelectionFixtures';

const ingresses: SelectionIngress[] = ['chat', 'responses', 'anthropic'];
describe('subscription selection commits model, defaults, auth, URL and wire together', () => {
  for (const ingress of ingresses) {
    for (const alias of [false, true]) {
      for (const explicit of [false, true]) {
        it(`${ingress}: alias=${alias}, explicit=${explicit}`, async () => {
          await runSubscriptionSelectionCase({ ingress, alias, explicit });
        });
      }
    }
    it(`${ingress}: refresh reselects the logical model once with refreshed bearer`, async () => {
      await runSubscriptionSelectionCase({ ingress, alias: true, explicit: false, refresh: true });
    });
    for (const alias of [false, true]) {
      it(`${ingress}: Anthropic target ${alias ? 'remaps to Responses' : 'keeps mapped model on same-format relay'}`, async () => {
        await runSubscriptionSelectionCase({ ingress, alias, explicit: false, reverse: true });
      });
    }
  }
  for (const alias of [false, true]) {
    for (const explicit of [false, true]) {
      it(`Anthropic fallback uses current target defaults: alias=${alias}, explicit=${explicit}`, async () => {
        await runSubscriptionSelectionCase({ ingress: 'anthropic', alias, explicit, fallback: true });
      });
    }
  }
  it('same-format alias can change wire before a fallback', async () => {
    await runSubscriptionSelectionCase({ ingress: 'anthropic', alias: true, explicit: false, reverse: true, fallback: true });
  });
  for (const ingress of ['chat', 'anthropic'] as const) {
    it(`${ingress}: typed capability errors remain 400 and do not advance fallback`, async () => {
      await runSubscriptionSelectionCase({ ingress, alias: false, explicit: false, rejectCapability: true, fallback: true });
    });
  }
});

describe('retired subscription selections retain defaults and use the flash wire', () => {
  for (const ingress of ingresses) {
    it(`${ingress}: account remap redirects before URL, auth and chain selection`, async () => {
      await runSubscriptionSelectionCase({
        ingress, alias: true, explicit: false, reverse: true,
        retired: { stage: 'account', model: 'deepseek-reasoner' },
      });
    });
  }
  it('scenario mapper redirects its legacy selection and retains explicit caller settings', async () => {
    await runSubscriptionSelectionCase({
      ingress: 'responses', alias: false, explicit: true,
      retired: { stage: 'primary', model: 'deepseek-chat' },
    });
  });
  it('Anthropic fallback redirects the legacy fallback and retains its defaults', async () => {
    await runSubscriptionSelectionCase({
      ingress: 'anthropic', alias: false, explicit: false, fallback: true, reverse: true,
      retired: { stage: 'fallback', model: 'deepseek-chat' },
    });
  });
  it('refresh reselects and redirects an account alias on every attempt', async () => {
    await runSubscriptionSelectionCase({
      ingress: 'chat', alias: true, explicit: false, refresh: true,
      retired: { stage: 'account', model: 'deepseek-reasoner' },
    });
  });
});
