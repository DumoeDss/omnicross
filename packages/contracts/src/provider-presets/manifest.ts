/**
 * Static JSON-import manifest for the preset catalog.
 *
 * Each `presets/<id>.json` is imported EXPLICITLY (no glob). A glob /
 * `import.meta.glob` is rejected because a bundler build does not guarantee
 * glob ordering, and the preset order is load-bearing.
 *
 * The import statements below are alphabetical (ESLint `simple-import-sort`).
 * The LOAD ORDER — what `getAllProviderPresets()` returns, which the golden
 * deep-equality test pins — is defined solely by the `RAW_PRESETS_IN_ORDER`
 * array further down (international → chinese cloud → local → fast-inference).
 *
 * To add a preset: add `presets/<id>.json`, add an import here, and insert it
 * into `RAW_PRESETS_IN_ORDER` at the right position.
 */
import anthropic from './presets/anthropic.json';
import azureOpenai from './presets/azure-openai.json';
import baidu from './presets/baidu.json';
import cerebras from './presets/cerebras.json';
import dashscope from './presets/dashscope.json';
import deepseek from './presets/deepseek.json';
import gemini from './presets/gemini.json';
import geminiVertex from './presets/gemini-vertex.json';
import grok from './presets/grok.json';
import groq from './presets/groq.json';
import kimi from './presets/kimi.json';
import kuaishou from './presets/kuaishou.json';
import minimax from './presets/minimax.json';
import mistral from './presets/mistral.json';
import mthreads from './presets/mthreads.json';
import ollama from './presets/ollama.json';
import openai from './presets/openai.json';
import openaiResponse from './presets/openai-response.json';
import openrouter from './presets/openrouter.json';
import perplexity from './presets/perplexity.json';
import siliconflow from './presets/siliconflow.json';
import tencent from './presets/tencent.json';
import tencentAnthropic from './presets/tencent-anthropic.json';
import together from './presets/together.json';
import volcengine from './presets/volcengine.json';
import xiaomiMimo from './presets/xiaomi-mimo.json';
import xiaomiMimoAnthropic from './presets/xiaomi-mimo-anthropic.json';
import zhipu from './presets/zhipu.json';
import zhipuBigmodel from './presets/zhipu-bigmodel.json';

/**
 * Raw preset JSON modules in load order. Typed as `unknown[]` so the loader
 * validates each through the Zod schema rather than trusting the resolved
 * JSON-module type.
 */
export const RAW_PRESETS_IN_ORDER: unknown[] = [
  // International
  openai,
  anthropic,
  gemini,
  geminiVertex,
  grok,
  deepseek,
  azureOpenai,
  openaiResponse,
  siliconflow,
  openrouter,
  mistral,
  together,
  perplexity,
  // Chinese cloud
  zhipu,
  zhipuBigmodel,
  volcengine,
  kimi,
  dashscope,
  tencent,
  tencentAnthropic,
  minimax,
  baidu,
  kuaishou,
  mthreads,
  xiaomiMimo,
  xiaomiMimoAnthropic,
  // Local-inference
  ollama,
  // Fast-inference
  groq,
  cerebras,
];
