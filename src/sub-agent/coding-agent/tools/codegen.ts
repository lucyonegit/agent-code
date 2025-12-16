/**
 * 代码生成工具
 * 基于 BDD 场景、架构设计生成代码，使用 LLM 智能提取组件关键词并获取文档
 */

import { z } from 'zod';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { createLLM } from '../../../core/BaseLLM';
import { CODING_AGENT_PROMPTS } from '../config/prompt';
import type { Tool, LLMProvider } from '../../../types/index';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { searchComponentDocs, getComponentList } from './rag';

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
 * 代码生成器类
 */
class CodeGenerator {
  private llm: BaseChatModel;

  constructor(config: LLMConfig) {
    this.llm = createLLM({
      model: config.model,
      provider: config.provider,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    });
  }

  /**
   * 使用 LLM 从文本中提取 UI 组件关键词
   */
  private async extractKeywords(text: string): Promise<string[]> {
    const prompt = `Identify the UI components mentioned or implied in the following text. 
Return ONLY a comma-separated list of component names (e.g., "Button, Table, DatePicker").
Do not include any explanation or other text.

Text:
${text}`;

    const response = await this.llm.invoke([new HumanMessage(prompt)]);
    const content = response.content as string;
    return content.split(',').map(s => s.trim()).filter(s => s.length > 0);
  }

  /**
   * 获取可用组件列表
   */
  private async fetchAvailableComponents(): Promise<string[]> {
    const result = await getComponentList();
    const answer = result.answer;
    // 解析组件列表字符串为数组
    try {
      // 尝试解析为 JSON 数组
      const parsed = JSON.parse(answer);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // 如果不是 JSON，按逗号或换行分割
      return answer.split(/[,\n]/).map((s: string) => s.trim()).filter((s: string) => s.length > 0);
    }
    return [];
  }

  /**
   * 根据关键词从可用组件中选择匹配的组件
   */
  private selectComponentsFromKeywords(keywords: string[], available: string[]): string[] {
    const selected = new Set<string>();
    const availableLower = available.map(c => c.toLowerCase());

    for (const keyword of keywords) {
      const keywordLower = keyword.toLowerCase();
      // 精确匹配
      const exactIndex = availableLower.indexOf(keywordLower);
      if (exactIndex !== -1) {
        selected.add(available[exactIndex]);
        continue;
      }
      // 模糊匹配：关键词包含组件名或组件名包含关键词
      for (let i = 0; i < available.length; i++) {
        if (keywordLower.includes(availableLower[i]) || availableLower[i].includes(keywordLower)) {
          selected.add(available[i]);
        }
      }
    }

    return Array.from(selected);
  }

  /**
   * 获取选中组件的文档
   */
  private async fetchComponentDocs(components: string[]): Promise<string> {
    let context = '';

    for (const comp of components) {
      const sections = ['API / Props', 'Usage Example'] as const;

      for (const sec of sections) {
        try {
          const result = await searchComponentDocs(
            '总结下这个组件的使用文档',
            comp,
            sec,
            3
          );

          if (result && result.answer && result.answer.length > 0) {
            // 转义 markdown 代码块
            const safePayload = result.answer.replace(/```/g, '\\`\\`\\`');
            const codeFence = sec === 'Usage Example' ? 'tsx' : 'md';
            context += `\n--- ${comp} (${sec}) ---\n\n\`\`\`${codeFence}\n${safePayload}\n\`\`\`\n\n`;
          }
        } catch {
          // 忽略单个查询失败
        }
      }
    }

    if (!context) {
      return 'No internal component documentation found.';
    }
    return context;
  }

  /**
   * 执行代码生成
   */
  async generate(bddScenarios: string, architecture: string): Promise<string> {
    // 1. 从 BDD 和架构中提取组件关键词
    const keywordsFromBDD = await this.extractKeywords(bddScenarios);
    const keywordsFromArch = await this.extractKeywords(architecture);
    const keywords = [...new Set([...keywordsFromBDD, ...keywordsFromArch])];

    // 2. 获取可用组件列表
    const available = await this.fetchAvailableComponents();

    // 3. 根据关键词选择匹配的组件
    const selected = this.selectComponentsFromKeywords(keywords, available);

    // 4. 获取选中组件的文档
    const ragContext = await this.fetchComponentDocs(selected);

    // 5. 调用 LLM 生成代码
    const codegenTool = {
      name: 'output_code',
      description: '输出代码生成结果',
      schema: CodeGenResultSchema,
    };

    const llmWithTool = this.llm.bindTools!([codegenTool], {
      tool_choice: { type: 'function', function: { name: 'output_code' } },
    } as any);

    const prompt = CODING_AGENT_PROMPTS.CODE_GENERATOR_PROMPT
      .replace('{bdd_scenarios}', bddScenarios)
      .replace('{base_architecture}', architecture)
      .replace('{rag_context}', ragContext);

    const response = await llmWithTool.invoke([
      new SystemMessage(CODING_AGENT_PROMPTS.SYSTEM_PERSONA),
      new HumanMessage(prompt),
    ]);

    const toolCalls = (response as any).tool_calls;
    if (toolCalls && toolCalls.length > 0) {
      const result = toolCalls[0].args;
      return JSON.stringify(result, null, 2);
    }

    return JSON.stringify({ files: [], summary: '代码生成失败' });
  }
}

/**
 * 创建代码生成工具
 */
export function createCodeGenTool(config: LLMConfig): Tool {
  return {
    name: 'generate_code',
    description: '基于 BDD 场景和架构设计生成项目代码（自动提取组件关键词并获取文档）',
    returnType: 'json',
    parameters: z.object({
      bdd_scenarios: z.string().describe('BDD 场景 JSON'),
      architecture: z.string().describe('架构设计 JSON'),
    }),
    execute: async (args) => {
      const generator = new CodeGenerator(config);
      return generator.generate(args.bdd_scenarios, args.architecture);
    },
  };
}

