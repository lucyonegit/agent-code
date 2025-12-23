/**
 * 架构设计工具
 * 基于 BDD 场景生成项目架构
 */

import { z } from 'zod';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { createLLM } from '../../../core/BaseLLM';
import { CODING_AGENT_PROMPTS } from '../config/prompt';
import type { Tool, LLMProvider } from '../../../types/index';

/**
 * 架构文件 Schema
 */
const ArchitectureFileSchema = z.object({
  path: z.string().describe('文件路径'),
  type: z.enum(['component', 'service', 'config', 'util', 'test', 'route']).describe('文件类型'),
  description: z.string().describe('文件描述'),
  bdd_references: z.array(z.string()).describe('关联的 BDD 场景'),
  status: z.literal('pending_generation').describe('状态'),
  dependencies: z
    .array(
      z.object({
        path: z.string(),
        import: z.array(z.string()),
      })
    )
    .describe('依赖'),
  rag_context_used: z.null(),
  content: z.null(),
});

export const ArchitectureResultSchema = z.array(ArchitectureFileSchema);

export interface LLMConfig {
  model: string;
  provider: LLMProvider;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * 创建架构设计工具
 */
export function createArchitectTool(config: LLMConfig): Tool {
  return {
    name: 'design_architecture',
    description: '基于 BDD 场景设计项目文件架构。返回架构文件数组。',
    returnType: 'json',
    parameters: z.object({
      bdd_scenarios: z.string().describe('BDD 场景 JSON 字符串'),
    }),
    execute: async args => {
      const llm = createLLM({
        model: 'qwen3-coder-plus',
        provider: config.provider,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
      });

      const architectTool = {
        name: 'output_architecture',
        description: '当设计完毕后，严格调用此工具输出架构设计结果',
        schema: ArchitectureResultSchema,
      };

      const llmWithTool = llm.bindTools([architectTool], {
        tool_choice: { type: 'function', function: { name: 'output_architecture' } },
      });

      const response = await llmWithTool.invoke([
        new SystemMessage(CODING_AGENT_PROMPTS.ARCHITECT_GENERATOR_PROMPT),
        new HumanMessage(`BDD 规范:\n${args.bdd_scenarios}\n\n请基于以上 BDD 规范设计项目架构。`),
      ]);

      console.log('arc response:-----', JSON.stringify(response));

      if (response.tool_calls && response.tool_calls.length > 0) {
        const result = response.tool_calls[0].args;
        return JSON.stringify(result, null, 2);
      }

      return JSON.stringify([]);
    },
  };
}
