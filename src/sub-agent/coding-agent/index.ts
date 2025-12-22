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

/**
 * CodingAgent - 基于 PlannerExecutor 的编码智能体
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
      useRag: config.useRag ?? true,
    };

    this.plannerExecutor = new PlannerExecutor({
      plannerModel: config.model,
      executorModel: config.model,
      provider: config.provider,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      maxIterationsPerStep: 15,
      maxRePlanAttempts: 2,
      systemPrompt: CODING_AGENT_PROMPTS.PLANNER_PROMPT,
    });
  }

  /**
   * 运行编码流水线
   */
  async run(input: CodingAgentInput): Promise<CodingAgentResult> {
    const { requirement, files, onProgress } = input;
    console.log(`[CodingAgent] run() called with requirement: ${requirement.slice(0, 50)}... Files context: ${files?.length || 0} files`);

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
      createCodeGenTool({ ...llmConfig, useRag: this.config.useRag }, files, async (event) => {
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
      console.log(`[CodingAgent] Generating greeting...`);
      // 发送友好的开场提示
      const greeting = await this.generateGreeting(requirement);
      console.log(`[CodingAgent] Greeting generated: ${greeting}`);
      await this.emitEvent(onProgress, {
        type: 'normal_message',
        messageId: `greeting_${Date.now()}`,
        content: greeting,
        timestamp: Date.now(),
      });

      // 优化：如果是多轮修改模式（已有文件），跳过规划和架构阶段，直接生成代码
      if (files && files.length > 0) {
        console.log('[CodingAgent] Existing files detected. Switching to Modification Mode (fast-path).');

        await this.emitEvent(onProgress, { type: 'phase_start', phase: 'codegen', message: '检测到项目上下文，正在进行增量修改...', timestamp: Date.now() });

        const codeGenTool = createCodeGenTool({ ...llmConfig, useRag: this.config.useRag }, files, async (event) => {
          await this.emitEvent(onProgress, event as unknown as CodingAgentEvent);
        });

        const rawResult = await codeGenTool.execute({
          bdd_scenarios: `User Modification Request: ${requirement}`,
          architecture: `Existing Project Context: ${files.length} files provided.`,
        });

        // 解析结果
        try {
          const json = JSON.parse(rawResult);
          results.codeResult = {
            files: json.files || [],
            tree: json.tree,
            summary: json.summary || ''
          };

          // 发送 code_generated 事件
          await this.emitEvent(onProgress, {
            type: 'code_generated',
            files: results.codeResult!.files,
            tree: results.codeResult!.tree,
            summary: results.codeResult!.summary,
            timestamp: Date.now(),
          });

          await this.emitEvent(onProgress, {
            type: 'phase_complete',
            phase: 'codegen',
            data: json,
            timestamp: Date.now(),
          });
        } catch (e) {
          console.error('[CodingAgent] Error parsing fast-path result:', e);
          throw new Error('代码生成结果解析失败');
        }

      } else {
        // 正常全流程
        console.log(`[CodingAgent] Starting PlannerExecutor...`);
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
      }

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
        tree: results.codeResult?.tree,
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
        console.log(`[CodingAgent] Tool call result for ${event.toolName}, result length: ${event.result.length}`);
        await this.extractAndStoreResults(event, results, onProgress);
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
      console.log(`[CodingAgent] Parsed JSON keys: ${Object.keys(json).join(', ')}`);

      // 检测 BDD 结果
      if (Array.isArray(json) && json[0]?.feature_id) {
        console.log(`[CodingAgent] BDD features detected: ${json.length} features. Previous count: ${results.bddFeatures.length}`);
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

      // 检测架构结果
      if (Array.isArray(json) && json[0]?.path && json[0]?.type) {
        console.log(`[CodingAgent] Architecture detected: ${json.length} files. Previous count: ${results.architecture.length}`);
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

      // 检测代码生成结果
      if (json.files && Array.isArray(json.files)) {
        console.log(`[CodingAgent] Code generation results detected: ${json.files.length} files. Has tree: ${!!json.tree}`);
        results.codeResult = json;
        // 发送专用的 code_generated 事件
        await this.emitEvent(onProgress, {
          type: 'code_generated',
          files: json.files,
          tree: json.tree, // 包含合并后的文件树
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
    } catch (e) {
      console.error('[CodingAgent] extractAndStoreResults parse error:', e, 'Raw result:', event.result?.slice(0, 200));
    }
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

    console.log(`[CodingAgent] Invoking LLM for greeting...`);
    const response = await llm.invoke([
      new SystemMessage('你是一个友好的编程助手。根据用户的需求，生成一条简短的中文确认消息（20字以内），告诉用户你即将开始为他们做什么。语气要友好专业，可以使用1个emoji。只返回确认消息本身，不要有其他内容。示例："好的，我来帮您生成登录页 ✨"'),
      new HumanMessage(`用户需求: ${requirement}`),
    ]);

    return (response.content as string).trim();
  }
}