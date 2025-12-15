/**
 * BDD 拆解工具
 * 将用户需求拆解为 BDD 场景
 */

import { z } from 'zod';
import { createLLM } from '../../../core/BaseLLM';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { CODING_AGENT_PROMPTS } from '../config/prompt';
import type { BDDFeature } from '../../types/index';

/**
 * BDD Feature 输出的 Zod schema
 */
const BDDScenarioSchema = z.object({
  id: z.string(),
  title: z.string(),
  given: z.array(z.string()),
  when: z.array(z.string()),
  then: z.array(z.string()),
});

const BDDFeatureSchema = z.object({
  feature_id: z.string(),
  feature_title: z.string(),
  description: z.string(),
  scenarios: z.array(BDDScenarioSchema),
});

const BDDOutputSchema = z.array(BDDFeatureSchema);

export interface BDDDecomposerConfig {
  model: string;
  provider: 'openai' | 'tongyi' | 'openai-compatible';
  apiKey?: string;
  baseUrl?: string;
}

/**
 * 执行 BDD 拆解
 * @param requirement 用户需求描述
 * @param config LLM 配置
 * @returns BDD Feature 数组
 */
export async function decomposeToBDD(
  requirement: string,
  config: BDDDecomposerConfig
): Promise<BDDFeature[]> {
  const llm = createLLM({
    model: config.model,
    provider: config.provider,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  });

  // 定义 BDD 生成工具
  const bddTool = {
    name: 'generate_bdd',
    description: '生成 BDD 场景结构。你必须调用此工具来返回 BDD 拆解结果。',
    schema: BDDOutputSchema,
  };

  const llmWithTool = llm.bindTools([bddTool], {
    tool_choice: { type: 'function', function: { name: 'generate_bdd' } },
  });

  const prompt = CODING_AGENT_PROMPTS.BDD_DECOMPOSER_PROMPT.replace('{requirement}', requirement);

  const response = await llmWithTool.invoke([
    new SystemMessage(CODING_AGENT_PROMPTS.SYSTEM_PERSONA),
    new HumanMessage(prompt),
  ]);

  if (!response.tool_calls || response.tool_calls.length === 0) {
    throw new Error('LLM 未返回 BDD 工具调用');
  }

  const toolCall = response.tool_calls[0];
  if (toolCall.name !== 'generate_bdd') {
    throw new Error(`意外的工具调用: ${toolCall.name}`);
  }

  return toolCall.args as BDDFeature[];
}
