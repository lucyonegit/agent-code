/**
 * BDD 拆解工具
 * 将用户需求拆解为 BDD 场景
 */

import { z } from 'zod';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { createLLM } from '../../../core/BaseLLM';
import { CODING_AGENT_PROMPTS } from '../config/prompt';
import type { Tool, LLMProvider } from '../../../types/index';

/**
 * BDD Feature Schema - 返回数组格式
 * [
 *   {
 *     "feature_id": "auth_feature",
 *     "feature_title": "User Authentication",
 *     "description": "As a website user, I want to log in...",
 *     "scenarios": [
 *       { "id": "scenario_1", "title": "Successful Login", "given": ["..."], "when": ["..."], "then": ["..."] }
 *     ]
 *   }
 * ]
 */
const BDDFeatureSchema = z.object({
  feature_id: z.string().describe('功能唯一标识'),
  feature_title: z.string().describe('功能标题'),
  description: z.string().describe('功能描述'),
  scenarios: z.array(
    z.object({
      id: z.string().describe('场景 ID'),
      title: z.string().describe('场景标题'),
      given: z.array(z.string()).describe('前置条件'),
      when: z.array(z.string()).describe('触发动作'),
      then: z.array(z.string()).describe('预期结果'),
    })
  ),
});

export const BDDResultSchema = z.array(BDDFeatureSchema);

export interface LLMConfig {
  model: string;
  provider: LLMProvider;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * 创建 BDD 拆解工具
 */
export function createBDDTool(config: LLMConfig): Tool {
  return {
    name: 'decompose_to_bdd',
    description:
      '将用户需求完整且一次性地拆解为 BDD（行为驱动开发）场景结构。必须覆盖所有需求，严禁分多次调用。',
    returnType: 'json',
    parameters: z.object({
      requirement: z.string().describe('用户需求描述'),
    }),
    execute: async args => {
      const llm = createLLM({
        model: config.model,
        provider: config.provider,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
      });

      // LangChain tool 调用返回的 args 总是对象形式，需要用对象包装
      const bddToolSchema = z.object({
        features: BDDResultSchema.describe('BDD 功能场景数组'),
      });

      const bddTool = {
        name: 'output_bdd',
        description: '输出 BDD 拆解结果',
        schema: bddToolSchema,
      };

      const llmWithTool = llm.bindTools([bddTool], {
        tool_choice: { type: 'function', function: { name: 'output_bdd' } },
      });

      const prompt = CODING_AGENT_PROMPTS.BDD_DECOMPOSER_PROMPT.replace(
        '{requirement}',
        args.requirement
      );

      const response = await llmWithTool.invoke([
        new SystemMessage(CODING_AGENT_PROMPTS.SYSTEM_PERSONA),
        new HumanMessage(prompt),
      ]);

      if (response.tool_calls && response.tool_calls.length > 0) {
        const toolArgs = response.tool_calls[0].args as { features: unknown };
        let result = toolArgs.features;

        // 防止 LLM 返回字符串而非对象（某些模型会这样）
        if (typeof result === 'string') {
          console.warn('[BDDTool] LLM returned features as string, parsing...');
          try {
            result = JSON.parse(result);
          } catch {
            throw new Error(`BDD 结果解析失败: LLM 返回了无效的 JSON 字符串`);
          }
        }

        return JSON.stringify(result, null, 2);
      }

      throw new Error('BDD 拆解失败');
    },
  };
}
