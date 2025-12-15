/**
 * 架构设计工具
 * 基于 BDD 场景生成项目架构
 */

import { z } from 'zod';
import { createLLM } from '../../../core/BaseLLM';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { CODING_AGENT_PROMPTS } from '../config/prompt';
import type { BDDFeature, ArchitectureFile } from '../../types/index';

/**
 * 架构文件输出的 Zod schema
 */
const ArchitectureFileSchema = z.object({
  path: z.string(),
  type: z.enum(['component', 'service', 'config', 'util', 'test', 'route']),
  description: z.string(),
  bdd_references: z.array(z.string()),
  status: z.literal('pending_generation'),
  dependencies: z.array(z.object({
    path: z.string(),
    import: z.array(z.string()),
  })),
  rag_context_used: z.null(),
  content: z.null(),
});

const ArchitectureOutputSchema = z.array(ArchitectureFileSchema);

export interface ArchitectConfig {
  model: string;
  provider: 'openai' | 'tongyi' | 'openai-compatible';
  apiKey?: string;
  baseUrl?: string;
}

/**
 * 执行架构设计
 * @param bddFeatures BDD 场景数组
 * @param config LLM 配置
 * @returns 架构文件数组
 */
export async function generateArchitecture(
  bddFeatures: BDDFeature[],
  config: ArchitectConfig
): Promise<ArchitectureFile[]> {
  const llm = createLLM({
    model: config.model,
    provider: config.provider,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  });

  // 定义架构生成工具
  const architectTool = {
    name: 'generate_architecture',
    description: '生成项目架构结构。你必须调用此工具来返回架构设计结果。',
    schema: ArchitectureOutputSchema,
  };

  const llmWithTool = llm.bindTools([architectTool], {
    tool_choice: { type: 'function', function: { name: 'generate_architecture' } },
  });

  const bddJson = JSON.stringify(bddFeatures, null, 2);

  const response = await llmWithTool.invoke([
    new SystemMessage(CODING_AGENT_PROMPTS.ARCHITECT_GENERATOR_PROMPT),
    new HumanMessage(`BDD 规范:\n${bddJson}\n\n请基于以上 BDD 规范设计项目架构。你必须调用 generate_architecture 工具来返回结果。`),
  ]);

  if (!response.tool_calls || response.tool_calls.length === 0) {
    throw new Error('LLM 未返回架构工具调用');
  }

  const toolCall = response.tool_calls[0];
  if (toolCall.name !== 'generate_architecture') {
    throw new Error(`意外的工具调用: ${toolCall.name}`);
  }

  return toolCall.args as ArchitectureFile[];
}
