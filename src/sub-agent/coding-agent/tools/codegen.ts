/**
 * 代码生成工具
 * 使用 LangGraph 工作流：提取关键词 → 获取组件 → 选择组件 → 获取文档 → 生成代码
 * 每个节点执行时发送 tool_call/tool_call_result 事件供前端展示
 */

import { z } from 'zod';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { StateGraph, Annotation, END, START } from '@langchain/langgraph';
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
 * 工作流节点事件回调（复用 tool_call / tool_call_result 事件格式）
 */
export interface CodeGenProgressEvent {
  type: 'tool_call' | 'tool_call_result';
  toolCallId: string;
  toolName: string;
  args?: Record<string, any>;
  result?: string;
  success?: boolean;
  duration?: number;
  timestamp: number;
}

export type CodeGenProgressCallback = (event: CodeGenProgressEvent) => void | Promise<void>;

/**
 * 代码生成工作流状态定义
 */
const CodeGenState = Annotation.Root({
  // 输入
  bddScenarios: Annotation<string>,
  architecture: Annotation<string>,
  // 中间状态
  keywords: Annotation<string[]>,
  availableComponents: Annotation<string[]>,
  selectedComponents: Annotation<string[]>,
  ragContext: Annotation<string>,
  // 输出
  result: Annotation<string>,
});

type CodeGenStateType = typeof CodeGenState.State;

/**
 * 工作流节点描述
 */
const NODE_DESCRIPTIONS: Record<string, string> = {
  extractKeywords: '从 BDD 场景和架构设计中提取 UI 组件关键词',
  fetchComponents: '获取内部组件库的可用组件列表',
  selectComponents: '根据关键词智能匹配选择需要的组件',
  fetchDocs: '获取选中组件的 API 文档和使用示例',
  generateCode: '基于上下文调用 LLM 生成项目代码',
};

/**
 * 创建带事件通知的节点包装器
 */
function createNodeWithEvents<T extends (...args: any[]) => Promise<any>>(
  nodeName: string,
  nodeDescription: string,
  nodeFn: T,
  onProgress?: CodeGenProgressCallback
): T {
  return (async (...args: any[]) => {
    const startTime = Date.now();
    const state = args[0] as CodeGenStateType;
    const toolCallId = `codegen_${nodeName}_${startTime}`;

    // 发送 tool_call 事件
    if (onProgress) {
      await onProgress({
        type: 'tool_call',
        toolCallId,
        toolName: `codegen:${nodeName}`,
        args: {
          description: nodeDescription,
          keywords: state.keywords?.length || 0,
          availableComponents: state.availableComponents?.length || 0,
          selectedComponents: state.selectedComponents?.length || 0,
        },
        timestamp: Date.now(),
      });
    }

    // 执行节点
    const result = await nodeFn(...args);
    const duration = Date.now() - startTime;

    // 发送 tool_call_result 事件
    if (onProgress) {
      await onProgress({
        type: 'tool_call_result',
        toolCallId,
        toolName: `codegen:${nodeName}`,
        result: JSON.stringify(summarizeResult(nodeName, result)),
        success: true,
        duration,
        timestamp: Date.now(),
      });
    }

    return result;
  }) as T;
}

/**
 * 生成用于前端展示的结果摘要
 */
function summarizeResult(nodeName: string, result: Partial<CodeGenStateType>): any {
  switch (nodeName) {
    case 'extractKeywords':
      return { keywords: result.keywords, count: result.keywords?.length || 0 };
    case 'fetchComponents':
      return { count: result.availableComponents?.length || 0 };
    case 'selectComponents':
      return { selected: result.selectedComponents, count: result.selectedComponents?.length || 0 };
    case 'fetchDocs':
      return { contextLength: result.ragContext?.length || 0 };
    case 'generateCode':
      try {
        const parsed = JSON.parse(result.result || '{}');
        return { filesCount: parsed.files?.length || 0, summary: parsed.summary };
      } catch {
        return { result: result.result?.slice(0, 100) };
      }
    default:
      return result;
  }
}

/**
 * 创建代码生成工作流
 */
function createCodeGenWorkflow(llm: BaseChatModel, onProgress?: CodeGenProgressCallback) {

  // 节点1: 从 BDD 和架构中提取组件关键词
  const extractKeywordsNode = async (state: CodeGenStateType): Promise<Partial<CodeGenStateType>> => {
    const extractFromText = async (text: string): Promise<string[]> => {
      const prompt = `Identify the UI components mentioned or implied in the following text. 
Return ONLY a comma-separated list of component names (e.g., "Button, Table, DatePicker").
Do not include any explanation or other text.

Text:
${text}`;
      const response = await llm.invoke([new HumanMessage(prompt)]);
      const content = response.content as string;
      return content.split(',').map(s => s.trim()).filter(s => s.length > 0);
    };

    const keywordsFromBDD = await extractFromText(state.bddScenarios);
    const keywordsFromArch = await extractFromText(state.architecture);
    const keywords = [...new Set([...keywordsFromBDD, ...keywordsFromArch])];

    return { keywords };
  };

  // 节点2: 获取可用组件列表
  const fetchComponentsNode = async (_state: CodeGenStateType): Promise<Partial<CodeGenStateType>> => {
    const result = await getComponentList();
    const answer = result.answer;

    let availableComponents: string[] = [];
    try {
      const parsed = JSON.parse(answer);
      if (Array.isArray(parsed)) availableComponents = parsed;
    } catch {
      availableComponents = answer.split(/[,\n]/).map((s: string) => s.trim()).filter((s: string) => s.length > 0);
    }

    return { availableComponents };
  };

  // 节点3: 根据关键词选择匹配的组件
  const selectComponentsNode = async (state: CodeGenStateType): Promise<Partial<CodeGenStateType>> => {
    const { keywords, availableComponents } = state;
    const selected = new Set<string>();
    const availableLower = availableComponents.map(c => c.toLowerCase());

    for (const keyword of keywords) {
      const keywordLower = keyword.toLowerCase();
      const exactIndex = availableLower.indexOf(keywordLower);
      if (exactIndex !== -1) {
        selected.add(availableComponents[exactIndex]);
        continue;
      }
      for (let i = 0; i < availableComponents.length; i++) {
        if (keywordLower.includes(availableLower[i]) || availableLower[i].includes(keywordLower)) {
          selected.add(availableComponents[i]);
        }
      }
    }

    return { selectedComponents: Array.from(selected) };
  };

  // 节点4: 获取选中组件的文档
  const fetchDocsNode = async (state: CodeGenStateType): Promise<Partial<CodeGenStateType>> => {
    const { selectedComponents } = state;
    let context = '';

    for (const comp of selectedComponents) {
      const sections = ['API / Props', 'Usage Example'] as const;
      for (const sec of sections) {
        try {
          const result = await searchComponentDocs('总结下这个组件的使用文档', comp, sec, 3);
          if (result && result.answer && result.answer.length > 0) {
            const safePayload = result.answer.replace(/```/g, '\\`\\`\\`');
            const codeFence = sec === 'Usage Example' ? 'tsx' : 'md';
            context += `\n--- ${comp} (${sec}) ---\n\n\`\`\`${codeFence}\n${safePayload}\n\`\`\`\n\n`;
          }
        } catch {
          // 忽略单个查询失败
        }
      }
    }

    return { ragContext: context || 'No internal component documentation found.' };
  };

  // 节点5: 调用 LLM 生成代码
  const generateCodeNode = async (state: CodeGenStateType): Promise<Partial<CodeGenStateType>> => {
    const { bddScenarios, architecture, ragContext } = state;

    const codegenTool = {
      name: 'output_code',
      description: '输出代码生成结果',
      schema: CodeGenResultSchema,
    };

    const llmWithTool = llm.bindTools!([codegenTool], {
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
      return { result: JSON.stringify(toolCalls[0].args, null, 2) };
    }

    return { result: JSON.stringify({ files: [], summary: '代码生成失败' }) };
  };

  // 构建工作流图（使用事件包装器）
  const workflow = new StateGraph(CodeGenState)
    .addNode('extractKeywords', createNodeWithEvents('extractKeywords', NODE_DESCRIPTIONS.extractKeywords, extractKeywordsNode, onProgress))
    .addNode('fetchComponents', createNodeWithEvents('fetchComponents', NODE_DESCRIPTIONS.fetchComponents, fetchComponentsNode, onProgress))
    .addNode('selectComponents', createNodeWithEvents('selectComponents', NODE_DESCRIPTIONS.selectComponents, selectComponentsNode, onProgress))
    .addNode('fetchDocs', createNodeWithEvents('fetchDocs', NODE_DESCRIPTIONS.fetchDocs, fetchDocsNode, onProgress))
    .addNode('generateCode', createNodeWithEvents('generateCode', NODE_DESCRIPTIONS.generateCode, generateCodeNode, onProgress))
    .addEdge(START, 'extractKeywords')
    .addEdge('extractKeywords', 'fetchComponents')
    .addEdge('fetchComponents', 'selectComponents')
    .addEdge('selectComponents', 'fetchDocs')
    .addEdge('fetchDocs', 'generateCode')
    .addEdge('generateCode', END);

  return workflow.compile();
}

/**
 * 创建代码生成工具（支持进度回调）
 */
export function createCodeGenTool(config: LLMConfig, onProgress?: CodeGenProgressCallback): Tool {
  const llm = createLLM({
    model: config.model,
    provider: config.provider,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  });

  const workflow = createCodeGenWorkflow(llm, onProgress);

  return {
    name: 'generate_code',
    description: '基于 BDD 场景和架构设计生成项目代码（使用 LangGraph 工作流）',
    returnType: 'json',
    parameters: z.object({
      bdd_scenarios: z.string().describe('BDD 场景 JSON'),
      architecture: z.string().describe('架构设计 JSON'),
    }),
    execute: async (args) => {
      const result = await workflow.invoke({
        bddScenarios: args.bdd_scenarios,
        architecture: args.architecture,
        keywords: [],
        availableComponents: [],
        selectedComponents: [],
        ragContext: '',
        result: '',
      });
      return result.result;
    },
  };
}



