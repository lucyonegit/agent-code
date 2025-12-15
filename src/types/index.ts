/**
 * ReAct Agent 核心 - 类型定义
 * 
 * 本文件包含 ReAct Agent 框架的所有核心接口和类型定义。
 * 这些类型与业务逻辑完全解耦，设计用于最大程度的可复用性。
 */

import { z } from 'zod';

// ============================================================================
// 工具定义
// ============================================================================

/**
 * 使用 Zod 定义的工具参数 Schema
 */
export type ToolParameterSchema = z.ZodObject<any>;

/**
 * 工具定义接口
 * 表示 ReAct agent 可以使用的单个工具
 */
export interface Tool {
  /** 工具的唯一标识符 */
  name: string;
  
  /** 工具功能的可读描述 */
  description: string;
  
  /** 定义工具参数的 Zod schema */
  parameters: ToolParameterSchema;
  
  /** 
   * 使用给定参数执行工具
   * @param args - 符合参数 schema 的参数对象
   * @returns 工具输出的字符串或 Promise<string>
   */
  execute: (args: Record<string, any>) => string | Promise<string>;
}

// ============================================================================
// ReAct 事件类型
// ============================================================================

/**
 * Agent 产生思考时发出的事件
 */
export interface ThoughtEvent {
  type: 'thought';
  content: string;
}

/**
 * Agent 决定使用工具时发出的事件
 */
export interface ActionEvent {
  type: 'action';
  toolName: string;
  args: Record<string, any>;
}

/**
 * 工具返回结果后发出的事件
 */
export interface ObservationEvent {
  type: 'observation';
  content: string;
}

/**
 * Agent 产生最终答案时发出的事件
 */
export interface FinalAnswerEvent {
  type: 'final_answer';
  content: string;
}

/**
 * 错误发生时发出的事件
 */
export interface ErrorEvent {
  type: 'error';
  message: string;
  details?: any;
}

/**
 * 流式输出的增量内容事件
 */
export interface StreamEvent {
  type: 'stream';
  /** 本次迭代的唯一标识，用于 UI 合并同一迭代的 thought */
  thoughtId: string;
  /** 增量内容 */
  chunk: string;
  /** 是否是思考内容的流式输出 */
  isThought: boolean;
}

/**
 * 所有可能的 ReAct 事件的联合类型
 */
export type ReActEvent = 
  | ThoughtEvent 
  | ActionEvent 
  | ObservationEvent 
  | FinalAnswerEvent
  | ErrorEvent
  | StreamEvent;

/**
 * 处理 ReAct 事件的回调函数类型
 */
export type ReActEventHandler = (event: ReActEvent) => void | Promise<void>;

// ============================================================================
// ReAct 执行器配置
// ============================================================================

/**
 * LLM 提供商类型
 */
export type LLMProvider = 'openai' | 'tongyi' | 'openai-compatible';

/**
 * ReActExecutor 的配置项
 */
export interface ReActConfig {
  /** LLM 模型标识符（例如 'gpt-4', 'qwen-plus', 'qwen-turbo'）*/
  model: string;
  
  /** LLM 提供商。默认：'openai' */
  provider?: LLMProvider;
  
  /** 停止前的最大 ReAct 迭代次数。默认：10 */
  maxIterations?: number;
  
  /** 可选的系统提示词，用于引导 agent 的行为 */
  systemPrompt?: string;
  
  /** OpenAI API 密钥或兼容的 API 密钥 */
  apiKey?: string;
  
  /** API 的基础 URL（用于 openai-compatible 模式）*/
  baseUrl?: string;
  
  /** LLM 采样温度。默认：0 */
  temperature?: number;
  
  /** 是否启用流式输出。默认：false */
  streaming?: boolean;

  /** 是否开启简洁问候。默认：false */
  shortGreeting?: boolean
}

/**
 * 单次 ReAct 执行的输入参数
 */
export interface ReActInput {
  /** 用户输入或任务描述 */
  input: string;
  
  /** 可选的上下文信息（例如之前步骤的结果）*/
  context?: string;
  
  /** 本次执行可用的工具列表 */
  tools: Tool[];
  
  /** 执行过程中接收事件的可选回调 */
  onMessage?: ReActEventHandler;
}

// ============================================================================
// LLM 结构化输出类型
// ============================================================================

/**
 * ReAct 输出中 action 部分的 Zod schema
 */
export const ActionSchema = z.object({
  name: z.string().describe('要使用的工具名称'),
  arguments: z.record(z.any()).describe('传递给工具的参数'),
});

/**
 * 完整 ReAct LLM 输出的 Zod schema
 * LLM 必须返回 action 或 final_answer 其中之一，不能同时返回
 */
export const ReActOutputSchema = z.object({
  thought: z.string().describe('解释当前推理过程的思考内容'),
  action: ActionSchema.optional().describe('如果需要，要调用的工具'),
  final_answer: z.string().optional().describe('如果不需要更多操作，返回最终答案'),
});

/**
 * 从 Zod schema 派生的 TypeScript 类型
 */
export type ReActOutput = z.infer<typeof ReActOutputSchema>;

// ============================================================================
// 规划器类型
// ============================================================================

/**
 * 计划步骤的状态
 */
export type PlanStepStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';

/**
 * 计划中的单个步骤
 */
export interface PlanStep {
  /** 步骤的唯一标识符 */
  id: string;
  
  /** 描述此步骤应完成的内容 */
  description: string;
  
  /** 步骤的当前状态 */
  status: PlanStepStatus;
  
  /** 此步骤可能需要的工具名称 */
  requiredTools?: string[];
  
  /** 步骤执行的结果（完成后填充）*/
  result?: string;
  
  /** 必须在此步骤之前完成的步骤 ID */
  dependencies?: string[];
}

/**
 * 计划步骤的 Zod schema（用于结构化输出）
 */
export const PlanStepSchema = z.object({
  id: z.string().describe('步骤的唯一标识符'),
  description: z.string().describe('此步骤应完成的内容'),
  requiredTools: z.array(z.string()).optional().describe('此步骤需要的工具'),
  dependencies: z.array(z.string()).optional().describe('前置步骤的 ID'),
});

/**
 * 完整计划的 Zod schema（用于结构化输出）
 */
export const PlanSchema = z.object({
  goal: z.string().describe('要完成的总体目标'),
  steps: z.array(PlanStepSchema).describe('实现目标的有序步骤列表'),
  reasoning: z.string().describe('选择此计划的原因说明'),
});

/**
 * 完整的执行计划
 */
export interface Plan {
  /** 要完成的总体目标 */
  goal: string;
  
  /** 实现目标的有序步骤列表 */
  steps: PlanStep[];
  
  /** 规划推理的说明 */
  reasoning: string;
  
  /** 步骤执行的历史记录，用于上下文 */
  history: Array<{
    stepId: string;
    result: string;
    timestamp: Date;
  }>;
}

/**
 * PlannerExecutor 的配置项
 */
export interface PlannerConfig {
  /** 用于规划的 LLM 模型标识符 */
  plannerModel: string;
  
  /** 用于步骤执行的 LLM 模型标识符 */
  executorModel: string;
  
  /** LLM 提供商。默认：'openai' */
  provider?: LLMProvider;
  
  /** ReActExecutor 中每个步骤的最大迭代次数 */
  maxIterationsPerStep?: number;
  
  /** 最大重规划尝试次数 */
  maxRePlanAttempts?: number;
  
  /** OpenAI/通义千问 API 密钥 */
  apiKey?: string;
  
  /** API 的基础 URL（用于 openai-compatible 模式）*/
  baseUrl?: string;
}

/**
 * PlannerExecutor 的输入
 */
export interface PlannerInput {
  /** 用户的目标或目的 */
  goal: string;
  
  /** 所有可用的工具 */
  tools: Tool[];
  
  /** 接收事件的可选回调 */
  onMessage?: ReActEventHandler;
  
  /** 计划更新时的专用回调 */
  onPlanUpdate?: (plan: Plan) => void | Promise<void>;
}

/**
 * PlannerExecutor 的结果
 */
export interface PlannerResult {
  /** 计划是否成功完成 */
  success: boolean;
  
  /** 给用户的最终响应 */
  response: string;
  
  /** 已执行的计划及所有结果 */
  plan: Plan;
}
