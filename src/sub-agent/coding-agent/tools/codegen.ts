/**
 * 代码生成工具
 * 基于 BDD 场景、架构设计和 RAG 上下文生成代码
 * 
 * 参考 example/CodeGenerator.ts 实现流程
 */

import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { createLLM } from '../../../core/BaseLLM';
import { CODING_AGENT_PROMPTS } from '../config/prompt';
import { RagQueryTool, RagQueryAvailableComponents } from './rag';
import type { BDDFeature, ArchitectureFile, GeneratedFile, CodeGenResult } from '../../types/index';

/**
 * RAG 来源
 */
export interface RagSource {
  content: string;
  metadata: Record<string, any>;
}

/**
 * 代码生成配置
 */
export interface CodeGenConfig {
  model: string;
  provider: 'openai' | 'tongyi' | 'openai-compatible';
  apiKey?: string;
  baseUrl?: string;
}

/**
 * 代码生成选项
 */
export interface CodeGenOptions {
  /** 工具调用回调 */
  onToolCall?: (payload: {
    id: string;
    status: 'start' | 'end';
    tool_name: string;
    args?: any;
    result?: any;
    success?: boolean;
    startedAt?: number;
    finishedAt?: number;
    durationMs?: number;
  }) => void;
  /** 思考过程回调 */
  onThought?: (content: string) => void;
  /** RAG 使用回调 */
  onRagUsed?: (data: { term: string; components: string[] }) => void;
  /** RAG 来源回调 */
  onRagSources?: (sources: RagSource[]) => void;
  /** RAG 文档回调 */
  onRagDoc?: (payload: { component: string; section: 'API / Props' | 'Usage Example'; content: string }) => void;
  /** 场景匹配回调 */
  onScenarioMatches?: (matches: Array<{ scenarioId: string; paths: string[] }>) => void;
}

/**
 * 代码生成器类
 */
export class CodeGenerator {
  private llm: BaseChatModel;
  private ragSources: RagSource[] = [];
  private ragSourceKeys: Set<string> = new Set();

  constructor(config: CodeGenConfig) {
    this.llm = createLLM({
      model: config.model,
      provider: config.provider,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    });
  }

  /**
   * 执行代码生成
   */
  async generate(
    bddFeatures: BDDFeature[],
    architecture: ArchitectureFile[],
    options?: CodeGenOptions
  ): Promise<CodeGenResult> {
    const bddScenarios = JSON.stringify(bddFeatures, null, 2);
    const baseArch = JSON.stringify(architecture, null, 2);

    // Step 1: 提取关键词
    options?.onThought?.('Thought: 启动代码生成流程，提取组件关键词');
    const kwStart = Date.now();
    options?.onToolCall?.({
      id: `tool_extract_keywords_${kwStart}`,
      status: 'start',
      tool_name: 'extract_keywords',
      args: { input: 'bdd_scenarios' },
      startedAt: kwStart
    });

    const keywordsFromBDD = await this.extractKeywords(bddScenarios);
    const keywordsFromArch = await this.extractKeywords(baseArch);
    const keywords = Array.from(new Set([...keywordsFromBDD, ...keywordsFromArch]));

    const kwEnd = Date.now();
    options?.onToolCall?.({
      id: `tool_extract_keywords_${kwStart}`,
      status: 'end',
      tool_name: 'extract_keywords',
      args: { input: 'bdd_scenarios' },
      result: { keywords },
      success: true,
      startedAt: kwStart,
      finishedAt: kwEnd,
      durationMs: kwEnd - kwStart
    });

    // Step 2: 获取可用组件列表
    options?.onThought?.('Action: 获取可用内部组件列表');
    const listStart = Date.now();
    options?.onToolCall?.({
      id: `tool_list_components_${listStart}`,
      status: 'start',
      tool_name: 'list_internal_components',
      args: {},
      startedAt: listStart
    });

    const available = await this.fetchAvailableComponents();

    const listEnd = Date.now();
    options?.onToolCall?.({
      id: `tool_list_components_${listStart}`,
      status: 'end',
      tool_name: 'list_internal_components',
      args: {},
      result: { available: available.slice(0, 20) },
      success: true,
      startedAt: listStart,
      finishedAt: listEnd,
      durationMs: listEnd - listStart
    });

    options?.onThought?.('Observation: 可用组件列表: ' + JSON.stringify(available.slice(0, 8)));

    // Step 3: 选择匹配组件
    const selStart = Date.now();
    options?.onToolCall?.({
      id: `tool_select_components_${selStart}`,
      status: 'start',
      tool_name: 'select_components',
      args: { keywords, available },
      startedAt: selStart
    });

    const selected = this.selectComponentsFromBDD(keywords, available);

    const selEnd = Date.now();
    options?.onToolCall?.({
      id: `tool_select_components_${selStart}`,
      status: 'end',
      tool_name: 'select_components',
      args: { keywords, available },
      result: { selected },
      success: true,
      startedAt: selStart,
      finishedAt: selEnd,
      durationMs: selEnd - selStart
    });

    options?.onThought?.('Thought: 选择与需求匹配的内部组件: ' + JSON.stringify(selected));

    // Step 4: 获取组件文档
    options?.onThought?.('Action: fetch_component_docs\nInput: { "components": ' + JSON.stringify(selected) + ' }');

    const ragContext = await this.fetchComponentDocs(selected, options);
    options?.onRagSources?.(this.getRagSources());
    options?.onThought?.('Observation: 已获取组件API与示例文档，开始代码生成');

    // Step 5: 代码生成
    const prompt = CODING_AGENT_PROMPTS.CODE_GENERATOR_PROMPT
      .replace('{bdd_scenarios}', bddScenarios)
      .replace('{base_architecture}', baseArch)
      .replace('{rag_context}', ragContext);

    const messages = [
      new SystemMessage(CODING_AGENT_PROMPTS.SYSTEM_PERSONA),
      new HumanMessage(prompt)
    ];

    const genStart = Date.now();
    options?.onToolCall?.({
      id: `tool_llm_generate_${genStart}`,
      status: 'start',
      tool_name: 'llm_generate_project',
      args: { model: 'chat', inputs: ['persona', 'prompt'] },
      startedAt: genStart
    });

    const response = await this.llm.invoke(messages);

    const genEnd = Date.now();
    options?.onToolCall?.({
      id: `tool_llm_generate_${genStart}`,
      status: 'end',
      tool_name: 'llm_generate_project',
      args: { model: 'chat' },
      result: { length: String(response.content || '').length },
      success: true,
      startedAt: genStart,
      finishedAt: genEnd,
      durationMs: genEnd - genStart
    });

    const content = response.content as string;

    try {
      // 从 markdown 代码块中提取 JSON
      let jsonStr = content;
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1];
      } else {
        jsonStr = content.replace(/^\s*```(?:json)?\s*/, '').replace(/\s*```\s*$/, '');
      }

      const project = JSON.parse(jsonStr) as CodeGenResult;

      // 计算场景匹配
      try {
        const flattened = this.flattenFeaturesToScenarios(bddFeatures);
        const matches = await this.computeScenarioMatches(flattened, project.files.map(f => f.path));
        options?.onScenarioMatches?.(matches);
      } catch { }

      return project;
    } catch (error) {
      console.warn('Failed to parse project JSON:', error);
      return {
        files: [{
          path: 'src/components/GeneratedComponent.tsx',
          content: content
        }],
        summary: 'Failed to parse structured output, returning raw content.'
      };
    }
  }

  /**
   * 提取关键词
   */
  private async extractKeywords(text: string): Promise<string[]> {
    const prompt = `Identify the UI components mentioned or implied in the following text. Return a comma-separated list of component names (e.g., "Button, Table, DatePicker").

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
    try {
      const res: any = await RagQueryAvailableComponents.execute({});
      const text: string = res?.result || '';
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return parsed.map(v => String(v).trim()).filter(Boolean);
      } catch { }
      return text.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * 根据 BDD 选择组件
   */
  private selectComponentsFromBDD(keywords: string[], available: string[]): string[] {
    const lowerAvail = new Set(available.map(a => a.toLowerCase()));
    const selected: string[] = [];
    for (const k of keywords) {
      const lk = k.toLowerCase();
      if (lowerAvail.has(lk)) selected.push(k);
    }
    if (selected.length === 0) return available.slice(0, 3);
    return Array.from(new Set(selected));
  }

  /**
   * 获取组件文档
   */
  private async fetchComponentDocs(
    components: string[],
    options?: CodeGenOptions
  ): Promise<string> {
    let context = '';

    for (const comp of components) {
      const sections = ['API / Props', 'Usage Example'] as const;

      for (const sec of sections) {
        const startedAt = Date.now();
        const toolId = `tool_rag_${comp}_${sec}_${startedAt}`;

        options?.onToolCall?.({
          id: toolId,
          status: 'start',
          tool_name: 'search_component_docs',
          args: { query: '总结下这个组件的使用文档', metadataFilters: { component_name: comp, section: sec }, limit: 3 },
          startedAt
        });

        try {
          const result = await RagQueryTool.execute({
            query: '总结下这个组件的使用文档',
            metadataFilters: {
              component_name: comp,
              section: sec
            },
            limit: 3
          });

          if (result && typeof result === 'object') {
            const raw = (result as any).result ?? '';
            const payloadStr = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
            const safePayload = payloadStr.replace(/```/g, '\\`\\`\\`');
            const codeFence = sec === 'Usage Example' ? 'tsx' : 'md';
            context += `\n--- ${comp} (${sec}) ---\n\n\`\`\`${codeFence}\n${safePayload}\n\`\`\`\n\n`;

            options?.onRagDoc?.({ component: comp, section: sec, content: payloadStr });

            const srcList = (result as any).sources as RagSource[] | undefined;
            if (srcList && Array.isArray(srcList)) {
              for (const s of srcList) {
                const key = `${String(s.metadata?.component_name || s.metadata?.title || '')}::${String(s.metadata?.section || '')}::${s.content}`;
                if (!this.ragSourceKeys.has(key)) {
                  this.ragSourceKeys.add(key);
                  this.ragSources.push(s);
                }
              }
              options?.onRagUsed?.({ term: comp, components: [comp] });
            }
          }

          const finishedAt = Date.now();
          options?.onToolCall?.({
            id: toolId,
            status: 'end',
            tool_name: 'search_component_docs',
            args: { query: comp, metadataFilters: { component_name: comp, section: sec }, limit: 3 },
            result,
            success: true,
            startedAt,
            finishedAt,
            durationMs: finishedAt - startedAt
          });
        } catch (error) {
          const finishedAt = Date.now();
          options?.onToolCall?.({
            id: toolId,
            status: 'end',
            tool_name: 'search_component_docs',
            args: { query: comp, metadataFilters: { component_name: comp, section: sec }, limit: 3 },
            result: { error: String(error) },
            success: false,
            startedAt,
            finishedAt,
            durationMs: finishedAt - startedAt
          });
        }
      }
    }

    if (!context) return 'No internal component documentation found.';
    return context;
  }

  /**
   * 扁平化 Feature 为 Scenario
   */
  private flattenFeaturesToScenarios(features: BDDFeature[]): string {
    const scenarios = features.flatMap(f => f.scenarios || []);
    return JSON.stringify(scenarios);
  }

  /**
   * 计算场景与文件路径的匹配
   */
  private async computeScenarioMatches(
    bddScenarios: string,
    filePaths: string[]
  ): Promise<Array<{ scenarioId: string; paths: string[] }>> {
    const prompt = `Given BDD scenarios and a list of project file paths, select up to 3 most relevant file paths for each scenario and return JSON array [{"scenarioId":"...","paths":["..."]}].
Scenarios JSON:
${bddScenarios}

File paths:
${filePaths.join('\n')}`;

    const response = await this.llm.invoke([new HumanMessage(prompt)]);
    const content = response.content as string;

    try {
      const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/) || content.match(/```\n([\s\S]*?)\n```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : content;
      const arr = JSON.parse(jsonStr);
      if (Array.isArray(arr)) {
        return arr.map((x: any) => ({
          scenarioId: String(x.scenarioId || x.id || ''),
          paths: Array.isArray(x.paths) ? x.paths.map((p: any) => String(p)) : []
        }));
      }
    } catch { }
    return [];
  }

  /**
   * 获取 RAG 来源
   */
  public getRagSources(): RagSource[] {
    return this.ragSources;
  }
}

/**
 * 便捷函数：执行代码生成
 */
export async function generateCode(
  bddFeatures: BDDFeature[],
  architecture: ArchitectureFile[],
  config: CodeGenConfig,
  options?: CodeGenOptions
): Promise<CodeGenResult> {
  const generator = new CodeGenerator(config);
  return generator.generate(bddFeatures, architecture, options);
}
