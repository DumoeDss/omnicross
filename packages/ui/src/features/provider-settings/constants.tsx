import {
  Bot,
  Cloud,
  Cpu,
  Server,
  Sparkles,
  Zap
} from 'lucide-react';
import React from 'react';

import type { ProviderFormData } from './types';

export const DEFAULT_MODEL_GROUP_ID = 'default';
export const DEFAULT_MODEL_GROUP_NAME = 'Default';
export const AGGREGATED_PROVIDER_IDS = new Set(['openrouter']);

export const PROVIDER_ICONS: Record<string, React.ReactNode> = {
  // Popular providers
  openrouter: <Cloud className="h-5 w-5 text-purple-500" />,
  deepseek: <Zap className="h-5 w-5 text-blue-500" />,
  silicon: <Cpu className="h-5 w-5 text-cyan-500" />,
  aihubmix: <Cloud className="h-5 w-5 text-indigo-500" />,
  // Direct API
  openai: <Bot className="h-5 w-5 text-green-500" />,
  anthropic: <Bot className="h-5 w-5 text-amber-600" />,
  gemini: <Sparkles className="h-5 w-5 text-yellow-500" />,
  'azure-openai': <Cloud className="h-5 w-5 text-blue-500" />,
  // Chinese providers
  zhipu: <Bot className="h-5 w-5 text-blue-600" />,
  moonshot: <Sparkles className="h-5 w-5 text-purple-600" />,
  kimi: <Sparkles className="h-5 w-5 text-purple-600" />,
  dashscope: <Cloud className="h-5 w-5 text-orange-500" />,
  doubao: <Bot className="h-5 w-5 text-blue-400" />,
  volcengine: <Cloud className="h-5 w-5 text-red-500" />,
  tencent: <Cloud className="h-5 w-5 text-blue-400" />,
  baidu: <Cloud className="h-5 w-5 text-blue-700" />,
  minimax: <Bot className="h-5 w-5 text-purple-500" />,
  kuaishou: <Bot className="h-5 w-5 text-orange-400" />,
  mthreads: <Cpu className="h-5 w-5 text-green-600" />,
  xiaomi: <Cpu className="h-5 w-5 text-orange-500" />,
  // Local
  ollama: <Server className="h-5 w-5 text-text-muted" />,
  lmstudio: <Server className="h-5 w-5 text-text-muted" />,
  // Fast inference
  groq: <Cpu className="h-5 w-5 text-orange-500" />,
  grok: <Zap className="h-5 w-5 text-red-500" />,
  cerebras: <Cpu className="h-5 w-5 text-red-500" />,
  // Others
  mistral: <Zap className="h-5 w-5 text-orange-600" />,
  together: <Cloud className="h-5 w-5 text-blue-500" />,
  perplexity: <Sparkles className="h-5 w-5 text-teal-500" />,
  // SiliconFlow shares the silicon icon (already declared above)
  siliconflow: <Cpu className="h-5 w-5 text-cyan-500" />,
  claudecode: <Bot className="h-5 w-5 text-amber-500" />,
  default: <Server className="h-5 w-5 text-muted-foreground" />
};

export const emptyFormData: ProviderFormData = {
  name: '',
  // v3 field - apiFormat determines transformer selection
  apiFormat: 'openai',
  // Legacy fields (deprecated)
  chatApiFormat: 'openai',
  apiType: 'openai',
  api_base_url: '',
  api_key: '',
  models: [],
  modelConfigs: [],
  modelGroups: [],
  modelsEndpoint: '',
  enabled: true,
  icon: undefined,
  apiVersion: undefined
};

