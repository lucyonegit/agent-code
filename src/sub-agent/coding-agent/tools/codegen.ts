/**
 * 代码生成工具
 * 基于 BDD 场景、架构设计和 RAG 上下文生成代码
 */

import { z } from 'zod';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { createLLM } from '../../../core/BaseLLM';
import { CODING_AGENT_PROMPTS } from '../config/prompt';
import type { Tool, LLMProvider } from '../../../types/index';

/**
 * 代码生成结果 Schema
 */
const CodeGenResultSchema = z.object({
  files: z.array(z.object({
    path: z.string().describe('文件路径'),
    content: z.string().describe('文件内容'),
  })),
  summary: z.string().describe('生成摘要'),
});

export interface LLMConfig {
  model: string;
  provider: LLMProvider;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * 创建代码生成工具
 */
export function createCodeGenTool(config: LLMConfig): Tool {
  return {
    name: 'generate_code',
    description: '基于 BDD 场景、架构设计和组件文档生成项目代码',
    returnType: 'json',
    parameters: z.object({
      bdd_scenarios: z.string().describe('BDD 场景 JSON'),
      architecture: z.string().describe('架构设计 JSON'),
      rag_context: z.string().describe('RAG 获取的组件文档'),
    }),
    execute: async (args) => {
      const llm = createLLM({
        model: config.model,
        provider: config.provider,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
      });

      const codegenTool = {
        name: 'output_code',
        description: '输出代码生成结果',
        schema: CodeGenResultSchema,
      };

      const llmWithTool = llm.bindTools([codegenTool], {
        tool_choice: { type: 'function', function: { name: 'output_code' } },
      });

      const prompt = CODING_AGENT_PROMPTS.CODE_GENERATOR_PROMPT
        .replace('{bdd_scenarios}', args.bdd_scenarios)
        .replace('{base_architecture}', args.architecture)
        .replace('{rag_context}', args.rag_context || '暂无组件文档');

      const response = await llmWithTool.invoke([
        new SystemMessage(CODING_AGENT_PROMPTS.SYSTEM_PERSONA),
        new HumanMessage(prompt),
      ]);

      if (response.tool_calls && response.tool_calls.length > 0) {
        const result = response.tool_calls[0].args;
        return JSON.stringify(result, null, 2);
      }

      return JSON.stringify({ files: [], summary: '代码生成失败' });
    },
  };
}
