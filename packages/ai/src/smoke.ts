// `pnpm ai:smoke` : un appel réel minimal, manuel. Exige ANTHROPIC_API_KEY et AI_SMOKE_MODEL
// (aucun identifiant de modèle n'est écrit dans le code) ; sans clé, le script s'arrête proprement.
import { AnthropicProvider } from './anthropic-provider.js';
import { demoSummaryPipeline } from './pipelines/demo.js';
import { runPipelineDetailed } from './runner.js';

const apiKey = process.env['ANTHROPIC_API_KEY'];
const model = process.env['AI_SMOKE_MODEL'];
if (apiKey === undefined || apiKey === '' || model === undefined || model === '') {
  console.info(
    'ai:smoke ignoré : définir ANTHROPIC_API_KEY et AI_SMOKE_MODEL (appel réel, manuel).',
  );
} else if (process.env['CI'] !== undefined && process.env['AI_LIVE'] !== '1') {
  console.error('ai:smoke refusé en CI sans AI_LIVE=1.');
  process.exitCode = 1;
} else {
  const run = await runPipelineDetailed(
    demoSummaryPipeline,
    { text: 'Le service comptable reçoit les factures par courriel puis les saisit à la main.' },
    { clientId: 'smoke', models: { default: model } },
    { provider: new AnthropicProvider({ apiKey }) },
  );
  console.info(
    JSON.stringify({ output: run.output, usage: run.usage, costEur: run.costEstimateEur }, null, 2),
  );
}
