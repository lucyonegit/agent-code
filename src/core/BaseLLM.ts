import { ChatOpenAI } from '@langchain/openai';
import type { LLMProvider } from '../types/index.js';

/**
 * LLM 创建配置
 */
export interface LLMConfig {
  /** 模型名称 */
  model: string;
  /** 提供商 */
  provider: LLMProvider;
  /** 温度参数 */
  temperature?: number;
  /** API Key */
  apiKey?: string;
  /** 自定义 Base URL（用于 openai-compatible） */
  baseUrl?: string;
  /** 是否启用流式输出 */
  streaming?: boolean;
}

/**
 * 创建 LLM 实例
 * @param config - LLM 配置
 * ```
 */
export function createLLM(config: LLMConfig): ChatOpenAI {
  const baseConfig = {
    model: config.model,
    temperature: config.temperature ?? 0,
    apiKey: config.apiKey,
    streaming: config.streaming,
  };

  switch (config.provider) {
    case 'tongyi':
      // 使用通义千问的 OpenAI 兼容端点
      return new ChatOpenAI({
        ...baseConfig,
        configuration: {
          baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        },
      });
    
    case 'openai-compatible':
      return new ChatOpenAI({
        ...baseConfig,
        configuration: {
          baseURL: config.baseUrl,
        },
      });
    
    case 'openai':
    default:
      return new ChatOpenAI(baseConfig);
  }
}
