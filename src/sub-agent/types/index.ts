/**
 * Sub-Agent 通用类型定义
 */

import { z } from 'zod';

/**
 * 工具参数定义
 */
export interface ToolParameter {
  name: string;
  type: string;
  description: string;
  required: boolean;
  schema: z.ZodType<any>;
}

/**
 * 工具定义接口（适用于 Sub-Agent 内部工具）
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameter[];
  execute: (input: any) => Promise<any>;
}

/**
 * BDD 场景定义
 */
export interface BDDScenario {
  id: string;
  title: string;
  given: string[];
  when: string[];
  then: string[];
}

/**
 * BDD Feature 定义
 */
export interface BDDFeature {
  feature_id: string;
  feature_title: string;
  description: string;
  scenarios: BDDScenario[];
}

/**
 * 架构文件定义
 */
export interface ArchitectureFile {
  path: string;
  type: 'component' | 'service' | 'config' | 'util' | 'test' | 'route';
  description: string;
  bdd_references: string[];
  status: 'pending_generation' | 'generated' | 'error';
  dependencies: Array<{
    path: string;
    import: string[];
  }>;
  rag_context_used: string | null;
  content: string | null;
}

/**
 * 生成的代码文件
 */
export interface GeneratedFile {
  path: string;
  content: string;
}

/**
 * 代码生成结果
 */
export interface CodeGenResult {
  files: GeneratedFile[];
  summary: string;
}

/**
 * CodingAgent 配置
 */
export interface CodingAgentConfig {
  /** LLM 模型 */
  model: string;
  /** LLM 提供商 */
  provider: 'openai' | 'tongyi' | 'openai-compatible';
  /** API Key */
  apiKey?: string;
  /** Base URL */
  baseUrl?: string;
  /** 是否启用流式输出 */
  streaming?: boolean;
}

/**
 * CodingAgent 输入
 */
export interface CodingAgentInput {
  /** 用户需求描述 */
  requirement: string;
  /** 事件回调 */
  onProgress?: (event: CodingAgentEvent) => void | Promise<void>;
}

import type { Plan } from '../../types/index';

/**
 * BDD 生成完成事件
 */
export interface BDDGeneratedEvent {
  type: 'bdd_generated';
  features: BDDFeature[];
  timestamp: number;
}

/**
 * 架构设计完成事件
 */
export interface ArchitectureGeneratedEvent {
  type: 'architecture_generated';
  files: ArchitectureFile[];
  timestamp: number;
}

/**
 * 代码生成完成事件
 */
export interface CodeGeneratedEvent {
  type: 'code_generated';
  files: GeneratedFile[];
  summary: string;
  timestamp: number;
}

/**
 * CodingAgent 事件
 */
export type CodingAgentEvent =
  | { type: 'phase_start'; phase: 'bdd' | 'architect' | 'codegen'; message: string; timestamp: number }
  | { type: 'phase_complete'; phase: 'bdd' | 'architect' | 'codegen'; data: any; timestamp: number }
  | { type: 'thought'; thoughtId: string; chunk: string; isComplete: boolean; timestamp: number }
  | { type: 'tool_call'; toolCallId: string; toolName: string; args: Record<string, any>; timestamp: number }
  | { type: 'tool_call_result'; toolCallId: string; toolName: string; result: string; success: boolean; duration: number; timestamp: number }
  | { type: 'plan_update'; plan: Plan; timestamp: number }
  | { type: 'error'; message: string; timestamp: number }
  | { type: 'complete'; timestamp: number }
  | BDDGeneratedEvent
  | ArchitectureGeneratedEvent
  | CodeGeneratedEvent;

/**
 * CodingAgent 结果
 */
export interface CodingAgentResult {
  success: boolean;
  bddFeatures?: BDDFeature[];
  architecture?: ArchitectureFile[];
  generatedFiles?: GeneratedFile[];
  summary?: string;
  error?: string;
}
