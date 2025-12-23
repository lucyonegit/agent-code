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
import { processProjectForWebContainer } from '../utils/project-merger';
import { validateAllFiles, generateFixPrompt } from '../utils/path-validator';
import { getViteTemplate } from '../services/template-generator';

/**
 * 代码生成结果 Schema
 */
const CodeGenResultSchema = z.object({
  files: z.array(
    z.object({
      path: z.string().describe('文件路径'),
      content: z.string().describe('文件内容'),
      npm_dependencies: z.record(z.string()).optional().describe('该文件特定的 npm 依赖'),
    })
  ),
  summary: z.string().describe('生成摘要'),
});

export interface LLMConfig {
  model: string;
  provider: LLMProvider;
  apiKey?: string;
  baseUrl?: string;
  useRag?: boolean;
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

import type { GeneratedFile } from '../../types/index';

/**
 * 代码生成工作流状态定义
 */
const CodeGenState = Annotation.Root({
  // 输入
  bddScenarios: Annotation<string>,
  architecture: Annotation<string>,
  existingFiles: Annotation<GeneratedFile[]>, // 新增：现有文件上下文
  // 中间状态
  keywords: Annotation<string[]>,
  availableComponents: Annotation<string[]>,
  selectedComponents: Annotation<string[]>,
  ragContext: Annotation<string>,
  // 输出
  result: Annotation<string>,
  // 路径验证
  pathErrors: Annotation<string[]>,
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
  validatePaths: '验证所有 import 路径的正确性',
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
function createCodeGenWorkflow(
  llm: BaseChatModel,
  useRag: boolean,
  onProgress?: CodeGenProgressCallback
) {
  // 节点1: 从 BDD 和架构中提取组件关键词
  const extractKeywordsNode = async (
    state: CodeGenStateType
  ): Promise<Partial<CodeGenStateType>> => {
    const extractFromText = async (text: string): Promise<string[]> => {
      const prompt = CODING_AGENT_PROMPTS.KEYWORD_EXTRACTOR_PROMPT + `\n\nText:\n${text}`;
      const response = await llm.invoke([new HumanMessage(prompt)]);
      const content = response.content as string;
      return content
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0);
    };

    const keywordsFromBDD = await extractFromText(state.bddScenarios);
    const keywordsFromArch = await extractFromText(state.architecture);
    const keywords = [...new Set([...keywordsFromBDD, ...keywordsFromArch])];

    return { keywords };
  };

  // 节点2: 获取可用组件列表
  const fetchComponentsNode = async (
    _state: CodeGenStateType
  ): Promise<Partial<CodeGenStateType>> => {
    const result = await getComponentList();
    const answer = result.answer;

    let availableComponents: string[] = [];
    try {
      const parsed = JSON.parse(answer);
      if (Array.isArray(parsed)) availableComponents = parsed;
    } catch {
      availableComponents = answer
        .split(/[,\n]/)
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0);
    }

    return { availableComponents };
  };

  // 节点3: 根据关键词选择匹配的组件
  const selectComponentsNode = async (
    state: CodeGenStateType
  ): Promise<Partial<CodeGenStateType>> => {
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
    const { bddScenarios, architecture, ragContext, existingFiles } = state;

    const codegenTool = {
      name: 'output_code',
      description: '当代码生成完毕后，严格调用此工具输出代码生成结果',
      schema: CodeGenResultSchema,
    };

    const llmWithTool = llm.bindTools!([codegenTool], {
      tool_choice: { type: 'function', function: { name: 'output_code' } },
    } as any);

    let prompt = CODING_AGENT_PROMPTS.CODE_GENERATOR_PROMPT.replace('{bdd_scenarios}', bddScenarios)
      .replace('{base_architecture}', architecture)
      .replace('{rag_context}', ragContext);

    // 如果有现有文件，注入到提示词上下文
    if (existingFiles && existingFiles.length > 0) {
      const filesContext = existingFiles
        .map(f => `Path: ${f.path}\nContent:\n${f.content}`)
        .join('\n\n');
      prompt = prompt.replace('{existing_files}', filesContext);
    } else {
      prompt = prompt.replace('{existing_files}', '无现有文件');
    }

    const response = await llmWithTool.invoke([
      new SystemMessage(CODING_AGENT_PROMPTS.SYSTEM_PERSONA),
      new HumanMessage(prompt),
    ]);

    console.log('code gen response:------', JSON.stringify(response));
    const toolCalls = (response as any).tool_calls;
    if (toolCalls && toolCalls.length > 0) {
      return { result: JSON.stringify(toolCalls[0].args, null, 2) };
    }

    return { result: JSON.stringify({ files: [], summary: '代码生成失败' }) };
  };

  // 节点6: 验证路径正确性
  const validatePathsNode = async (state: CodeGenStateType): Promise<Partial<CodeGenStateType>> => {
    try {
      const parsed = JSON.parse(state.result);
      if (!parsed.files || !Array.isArray(parsed.files)) {
        return { pathErrors: [] };
      }

      const validation = validateAllFiles(parsed.files);

      if (!validation.valid) {
        console.log(
          `[CodeGen] Found ${validation.errors.length} path errors, generating fix prompt...`
        );

        // 生成修复提示并让 LLM 修复
        const fixPrompt = generateFixPrompt(validation.errors);
        const fixResponse = await llm.invoke([
          new SystemMessage(
            '你是代码修复专家。请根据错误提示修复 import 路径问题，返回修正后的完整 JSON。'
          ),
          new HumanMessage(`原始生成结果:
${state.result}

${fixPrompt}

请返回修正后的完整 JSON（只返回 JSON，不要 markdown 包裹）：`),
        ]);

        const fixedContent = (fixResponse.content as string).trim();
        // 尝试提取 JSON
        const jsonMatch = fixedContent.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          return {
            result: jsonMatch[0],
            pathErrors: validation.errors.map(e => e.message),
          };
        }
      }

      return { pathErrors: [] };
    } catch (e) {
      console.error('[CodeGen] Path validation error:', e);
      return { pathErrors: [] };
    }
  };

  // 构建工作流图（使用事件包装器）
  if (useRag) {
    return new StateGraph(CodeGenState)
      .addNode(
        'extractKeywords',
        createNodeWithEvents(
          'extractKeywords',
          NODE_DESCRIPTIONS.extractKeywords,
          extractKeywordsNode,
          onProgress
        )
      )
      .addNode(
        'fetchComponents',
        createNodeWithEvents(
          'fetchComponents',
          NODE_DESCRIPTIONS.fetchComponents,
          fetchComponentsNode,
          onProgress
        )
      )
      .addNode(
        'selectComponents',
        createNodeWithEvents(
          'selectComponents',
          NODE_DESCRIPTIONS.selectComponents,
          selectComponentsNode,
          onProgress
        )
      )
      .addNode(
        'fetchDocs',
        createNodeWithEvents('fetchDocs', NODE_DESCRIPTIONS.fetchDocs, fetchDocsNode, onProgress)
      )
      .addNode(
        'generateCode',
        createNodeWithEvents(
          'generateCode',
          NODE_DESCRIPTIONS.generateCode,
          generateCodeNode,
          onProgress
        )
      )
      .addNode(
        'validatePaths',
        createNodeWithEvents(
          'validatePaths',
          NODE_DESCRIPTIONS.validatePaths,
          validatePathsNode,
          onProgress
        )
      )
      .addEdge(START, 'extractKeywords')
      .addEdge('extractKeywords', 'fetchComponents')
      .addEdge('fetchComponents', 'selectComponents')
      .addEdge('selectComponents', 'fetchDocs')
      .addEdge('fetchDocs', 'generateCode')
      .addEdge('generateCode', 'validatePaths')
      .addEdge('validatePaths', END)
      .compile();
  } else {
    return new StateGraph(CodeGenState)
      .addNode(
        'generateCode',
        createNodeWithEvents(
          'generateCode',
          NODE_DESCRIPTIONS.generateCode,
          generateCodeNode,
          onProgress
        )
      )
      .addNode(
        'validatePaths',
        createNodeWithEvents(
          'validatePaths',
          NODE_DESCRIPTIONS.validatePaths,
          validatePathsNode,
          onProgress
        )
      )
      .addEdge(START, 'generateCode')
      .addEdge('generateCode', 'validatePaths')
      .addEdge('validatePaths', END)
      .compile();
  }
}

/**
 * 创建代码生成工具（支持进度回调）
 */
export function createCodeGenTool(
  config: LLMConfig,
  existingFiles: GeneratedFile[] | undefined,
  onProgress?: CodeGenProgressCallback
): Tool {
  const llm = createLLM({
    model: 'qwen3-coder-plus',
    provider: config.provider,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  });

  const workflow = createCodeGenWorkflow(llm, config.useRag ?? true, onProgress);

  return {
    name: 'generate_code',
    description: '基于 BDD 场景和架构设计生成项目代码（使用 LangGraph 工作流）',
    returnType: 'json',
    parameters: z.object({
      bdd_scenarios: z.string().describe(`【严格要求】BDD 场景的 JSON 数据。
- 必须是以 "[" 开头的 JSON 数组
- 必须包含 decompose_to_bdd 工具返回的完整原始结果
- 禁止传入自然语言描述或总结
- 错误示例: "根据需求，BDD场景包括..."
- 正确示例: [{"feature_id":"F1","feature_name":"用户登录",...}]`),
      architecture: z.string().describe(`【严格要求】架构设计的 JSON 数据。
- 必须是以 "[" 开头的 JSON 数组
- 必须包含 design_architecture 工具返回的完整原始结果
- 禁止传入自然语言描述或总结
- 错误示例: "架构设计已完成，包括..."
- 正确示例: [{"path":"src/App.tsx","type":"component",...}]`),
    }),
    execute: async args => {
      // 严格验证输入格式
      const validateJsonInput = (input: string, fieldName: string): string => {
        const trimmed = input.trim();
        // 检查是否以 [ 或 { 开头（JSON 格式）
        if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) {
          console.error(
            `[CodeGen] Invalid ${fieldName} input: not JSON format. Input starts with: "${trimmed.slice(0, 50)}..."`
          );
          throw new Error(
            `参数 ${fieldName} 格式错误：必须传入 JSON 数据，不能传入自然语言描述。请使用上一步工具的原始返回结果。`
          );
        }
        // 尝试解析验证是否为有效 JSON
        try {
          JSON.parse(trimmed);
          return trimmed;
        } catch (e) {
          console.error(
            `[CodeGen] Invalid ${fieldName} input: JSON parse failed. Input: "${trimmed.slice(0, 100)}..."`
          );
          throw new Error(`参数 ${fieldName} 不是有效的 JSON 格式。请检查传入的数据。`);
        }
      };

      const validatedBdd = validateJsonInput(args.bdd_scenarios, 'bdd_scenarios');
      const validatedArch = validateJsonInput(args.architecture, 'architecture');

      const result = await workflow.invoke({
        bddScenarios: validatedBdd,
        architecture: validatedArch,
        existingFiles: existingFiles || [],
        keywords: [],
        availableComponents: [],
        selectedComponents: [],
        ragContext: '',
        result: '',
        pathErrors: [],
      });

      // 如果生成成功，进行项目合并
      try {
        const parsedResult = JSON.parse(result.result);
        if (parsedResult.files && Array.isArray(parsedResult.files)) {
          console.log('Merging project with dynamic Vite template...');

          // 使用动态生成的 Vite 模版
          const baseTemplate = await getViteTemplate({ framework: 'react-ts' });
          const finalTree = processProjectForWebContainer(baseTemplate, parsedResult.files);

          return JSON.stringify({
            tree: finalTree,
            summary: parsedResult.summary,
            files: parsedResult.files, // 保留原始文件列表供展示
            pathErrors: result.pathErrors || [], // 包含路径修复信息
          });
        }
        // 如果没有 files 数组，返回空结构
        console.warn('[CodeGen] No files array in result, returning empty structure');
        return JSON.stringify({
          files: [],
          tree: {},
          summary: parsedResult.summary || '代码生成未产生文件',
          pathErrors: [],
        });
      } catch (e) {
        console.error('Error during project merging:', e);
        // 返回一个有效的结构，确保 code_generated 事件能触发
        try {
          const fallback = JSON.parse(result.result);
          return JSON.stringify({
            files: fallback.files || [],
            tree: {},
            summary: fallback.summary || '模版合并失败',
            pathErrors: result.pathErrors || [],
          });
        } catch {
          // result.result 本身不是有效 JSON
          console.error('[CodeGen] result.result is not valid JSON:', result.result?.slice(0, 200));
          return JSON.stringify({
            files: [],
            tree: {},
            summary: '代码生成结果解析失败',
            pathErrors: [],
          });
        }
      }
    },
  };
}
