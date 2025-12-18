/**
 * CodingAgent - 编码智能体
 * 
 * 基于 PlannerExecutor 的编码流水线：
 * 用户需求 → BDD 拆解 → 架构设计 → 代码生成
 */

import { PlannerExecutor } from '../../core/PlannerExecutor';
import { CODING_AGENT_PROMPTS } from './config/prompt';
import { createBDDTool } from './tools/bdd';
import { createArchitectTool } from './tools/architect';
import { createCodeGenTool } from './tools/codegen';
import type { Tool, ReActEvent } from '../../types/index';
import type {
  CodingAgentConfig,
  CodingAgentInput,
  CodingAgentResult,
  CodingAgentEvent,
  BDDFeature,
  ArchitectureFile,
  CodeGenResult,
} from '../types/index';

// ============================================================================
// CodingAgent 自定义 Prompt
// ============================================================================

const CODING_PLANNER_PROMPT = `你是编码规划器。
你的任务是分析用户请求，输出精炼的高层实现计划（严格为 3 步）。

范围与约束：
1. 不包含任何查询组件 API/属性或文档的步骤。
2. 不包含数据抓取或工具执行的步骤。
3. 仅关注高层阶段：明确目标、BDD 拆解、项目搭建、组件/页面接线、路由、测试。
4. 组件文档的使用留给代码生成阶段。

工作流程固定为以下三步：
1. **需求分析与 BDD 拆解**: 使用 decompose_to_bdd 工具将用户需求转换为 BDD 格式
2. **架构设计**: 使用 design_architecture 工具基于 BDD 场景设计项目文件结构
3. **代码生成**: 使用 generate_code 工具生成代码（该工具会自动获取组件文档）

返回格式要求返回一个JSON 对象，包含以下字段：
- goal: 总体目标
- steps: 步骤数组，每个步骤包含 id、description、requiredTools（可选）、dependencies（可选）
- reasoning: 选择此计划的理由

保持步骤专注且可实现。每个步骤应该能够被拥有指定工具的 AI agent 完成。

可用工具：
- decompose_to_bdd: 将需求拆解为 BDD 场景
- design_architecture: 设计项目架构
- generate_code: 生成项目代码（自动获取组件文档）`;

/**
 * CodingAgent - 基于 PlannerExecutor 的编码智能体
 * ```
 */
export class CodingAgent {
  private config: CodingAgentConfig;
  private plannerExecutor: PlannerExecutor;

  constructor(config: CodingAgentConfig) {
    this.config = {
      model: config.model,
      provider: config.provider,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      streaming: config.streaming ?? false,
    };

    this.plannerExecutor = new PlannerExecutor({
      plannerModel: config.model,
      executorModel: config.model,
      provider: config.provider,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      maxIterationsPerStep: 15,
      maxRePlanAttempts: 2,
      systemPrompt: CODING_PLANNER_PROMPT,
    });
  }

  /**
   * 运行编码流水线
   */
  async run(input: CodingAgentInput): Promise<CodingAgentResult> {
    const { requirement, onProgress } = input;

    // 创建工具集
    const llmConfig = {
      model: this.config.model,
      provider: this.config.provider,
      apiKey: this.config.apiKey,
      baseUrl: this.config.baseUrl,
    };

    const tools: Tool[] = [
      createBDDTool(llmConfig),
      createArchitectTool(llmConfig),
      createCodeGenTool(llmConfig, async (event) => {
        // 将工作流事件转发给前端（复用 tool_call / tool_call_result 格式）
        await this.emitEvent(onProgress, event as unknown as CodingAgentEvent);
      }),
    ];

    // 存储中间结果
    const results = {
      bddFeatures: [] as BDDFeature[],
      architecture: [] as ArchitectureFile[],
      codeResult: undefined as CodeGenResult | undefined,
    };

    try {
      // 发送友好的开场提示
      const greeting = await this.generateGreeting(requirement);
      await this.emitEvent(onProgress, {
        type: 'normal_message',
        messageId: `greeting_${Date.now()}`,
        content: greeting,
        timestamp: Date.now(),
      });

      await this.plannerExecutor.run({
        goal: `${requirement}`,
        tools,
        onMessage: async (event: ReActEvent) => {
          await this.handleReActEvent(event, results, onProgress);
        },
        onPlanUpdate: async (plan) => {
          await this.emitEvent(onProgress, {
            type: 'plan_update',
            plan,
            timestamp: Date.now(),
          });
        },
      });

      // 发送 complete 事件通知业务层
      await this.emitEvent(onProgress, {
        type: 'complete',
        timestamp: Date.now(),
      });

      // 直接使用通过事件收集的结果
      return {
        success: true,
        bddFeatures: results.bddFeatures,
        architecture: results.architecture,
        generatedFiles: results.codeResult?.files || [],
        summary: results.codeResult?.summary || '',
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误';
      await this.emitEvent(onProgress, { type: 'error', message: errorMessage, timestamp: Date.now() });
      return { success: false, error: errorMessage };
    }
  }

  /**
   * 处理 ReActEvent（包含事件转发和结果提取）
   */
  private async handleReActEvent(
    event: ReActEvent,
    results: { bddFeatures: BDDFeature[]; architecture: ArchitectureFile[]; codeResult?: CodeGenResult },
    onProgress?: CodingAgentInput['onProgress']
  ): Promise<void> {
    switch (event.type) {
      case 'thought':
        // 转发新格式的思考事件
        await this.emitEvent(onProgress, {
          type: 'thought',
          thoughtId: event.thoughtId,
          chunk: event.chunk,
          isComplete: event.isComplete,
          timestamp: event.timestamp,
        });
        break;
      case 'tool_call':
        // 发送 phase_start 事件（针对特定工具）
        if (event.toolName === 'decompose_to_bdd') {
          await this.emitEvent(onProgress, { type: 'phase_start', phase: 'bdd', message: '正在拆解 BDD 场景...', timestamp: Date.now() });
        } else if (event.toolName === 'design_architecture') {
          await this.emitEvent(onProgress, { type: 'phase_start', phase: 'architect', message: '正在设计项目架构...', timestamp: Date.now() });
        } else if (event.toolName === 'generate_code') {
          await this.emitEvent(onProgress, { type: 'phase_start', phase: 'codegen', message: '正在生成代码...', timestamp: Date.now() });
        }
        // 转发 tool_call 事件（让前端可以显示 ToolCard）
        await this.emitEvent(onProgress, {
          type: 'tool_call',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          timestamp: event.timestamp,
        });
        break;
      case 'tool_call_result':
        // 转发 tool_call_result 事件（让前端可以更新 ToolCard 结果）
        await this.emitEvent(onProgress, {
          type: 'tool_call_result',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
          success: event.success,
          duration: event.duration,
          timestamp: event.timestamp,
        });
        // 提取并存储结果
        this.extractAndStoreResults(event, results, onProgress);
        break;
      case 'error':
        await this.emitEvent(onProgress, { type: 'error', message: event.message, timestamp: Date.now() });
        break;
    }
  }

  /**
   * 从 tool_call_result 事件中提取结果并发送专用事件
   */
  private async extractAndStoreResults(
    event: ReActEvent & { type: 'tool_call_result' },
    results: { bddFeatures: BDDFeature[]; architecture: ArchitectureFile[]; codeResult?: CodeGenResult },
    onProgress?: CodingAgentInput['onProgress']
  ): Promise<void> {
    try {
      const json = JSON.parse(event.result);

      // 检测 BDD 结果（只在第一次检测到时发送）
      if (Array.isArray(json) && json[0]?.feature_id && results.bddFeatures.length === 0) {
        results.bddFeatures = json;
        // 发送专用的 bdd_generated 事件
        await this.emitEvent(onProgress, {
          type: 'bdd_generated',
          features: json,
          timestamp: Date.now(),
        });
        // 同时发送 phase_complete 事件以保持向后兼容
        await this.emitEvent(onProgress, {
          type: 'phase_complete',
          phase: 'bdd',
          data: json,
          timestamp: Date.now(),
        });
      }

      // 检测架构结果（只在第一次检测到时发送）
      if (Array.isArray(json) && json[0]?.path && json[0]?.type && results.architecture.length === 0) {
        results.architecture = json;
        // 发送专用的 architecture_generated 事件
        await this.emitEvent(onProgress, {
          type: 'architecture_generated',
          files: json,
          timestamp: Date.now(),
        });
        // 同时发送 phase_complete 事件以保持向后兼容
        await this.emitEvent(onProgress, {
          type: 'phase_complete',
          phase: 'architect',
          data: json,
          timestamp: Date.now(),
        });
      }

      // 检测代码生成结果（只在第一次检测到时发送）
      if (json.files && Array.isArray(json.files) && !results.codeResult) {
        results.codeResult = json;
        // 发送专用的 code_generated 事件
        await this.emitEvent(onProgress, {
          type: 'code_generated',
          files: json.files,
          summary: json.summary || '',
          timestamp: Date.now(),
        });
        // 同时发送 phase_complete 事件以保持向后兼容
        await this.emitEvent(onProgress, {
          type: 'phase_complete',
          phase: 'codegen',
          data: json,
          timestamp: Date.now(),
        });
      }
    } catch { }
  }

  /**
   * 发出事件
   */
  private async emitEvent(handler: CodingAgentInput['onProgress'], event: CodingAgentEvent): Promise<void> {
    if (handler) await handler(event);
  }

  /**
   * 使用 LLM 生成友好的开场提示
   */
  private async generateGreeting(requirement: string): Promise<string> {
    const { createLLM } = await import('../../core/BaseLLM.js');
    const { HumanMessage, SystemMessage } = await import('@langchain/core/messages');

    const llm = createLLM({
      model: this.config.model,
      provider: this.config.provider,
      apiKey: this.config.apiKey,
      baseUrl: this.config.baseUrl,
    });

    const response = await llm.invoke([
      new SystemMessage('你是一个友好的编程助手。根据用户的需求，生成一条简短的中文确认消息（20字以内），告诉用户你即将开始为他们做什么。语气要友好专业，可以使用1个emoji。只返回确认消息本身，不要有其他内容。示例："好的，我来帮您生成登录页 ✨"'),
      new HumanMessage(`用户需求: ${requirement}`),
    ]);

    return (response.content as string).trim();
  }
}