/**
 * CodingAgent - 编码智能体
 *
 * 固定工作流模式：
 * 用户需求 → BDD 拆解 → 架构设计 → 代码生成
 *
 * 通过程序化传递工具输出，避免 LLM 丢失或改写复杂 JSON 参数。
 */

import { createBDDTool } from './tools/bdd';
import { createArchitectTool } from './tools/architect';
import { createCodeGenTool } from './tools/codegen';
import type {
  CodingAgentConfig,
  CodingAgentInput,
  CodingAgentResult,
  CodingAgentEvent,
  BDDFeature,
  ArchitectureFile,
  CodeGenResult,
} from '../types/index';
import type { Plan } from '../../types/index';

/**
 * CodingAgent - 基于固定工作流的编码智能体
 */
export class CodingAgent {
  private config: CodingAgentConfig;

  constructor(config: CodingAgentConfig) {
    this.config = {
      model: config.model,
      provider: config.provider,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      streaming: config.streaming ?? false,
      useRag: config.useRag ?? true,
    };
  }

  /**
   * 运行编码流水线
   */
  async run(input: CodingAgentInput): Promise<CodingAgentResult> {
    const { requirement, files, onProgress } = input;

    // 创建 LLM 配置
    const llmConfig = {
      model: this.config.model,
      provider: this.config.provider,
      apiKey: this.config.apiKey,
      baseUrl: this.config.baseUrl,
    };

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

      // 优化：如果是多轮修改模式（已有文件），跳过规划和架构阶段，直接生成代码
      if (files && files.length > 0) {
        await this.runIncrementalMode(requirement, files, llmConfig, results, onProgress);
      } else {
        // 正常全流程 - 使用固定工作流
        await this.runFixedWorkflow(requirement, llmConfig, results, onProgress);
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
      await this.emitEvent(onProgress, {
        type: 'error',
        message: errorMessage,
        timestamp: Date.now(),
      });
      return { success: false, error: errorMessage };
    }
  }

  /**
   * 固定工作流：BDD → Architect → CodeGen
   * 程序化传递工具输出，绕过 LLM 参数传递问题
   */
  private async runFixedWorkflow(
    requirement: string,
    llmConfig: {
      model: string;
      provider: CodingAgentConfig['provider'];
      apiKey?: string;
      baseUrl?: string;
    },
    results: {
      bddFeatures: BDDFeature[];
      architecture: ArchitectureFile[];
      codeResult?: CodeGenResult;
    },
    onProgress?: CodingAgentInput['onProgress']
  ): Promise<void> {
    // 推送固定的 Plan 给前端
    const fixedPlan: Plan = {
      goal: requirement,
      steps: [
        { id: 'step_1', description: 'BDD 场景拆解', status: 'pending' },
        { id: 'step_2', description: '架构设计', status: 'pending' },
        { id: 'step_3', description: '代码生成', status: 'pending' },
      ],
      reasoning: '固定三步编码工作流',
      history: [],
    };

    await this.emitEvent(onProgress, {
      type: 'plan_update',
      plan: fixedPlan,
      timestamp: Date.now(),
    });

    // 创建三个工具实例
    const bddTool = createBDDTool(llmConfig);
    const architectTool = createArchitectTool(llmConfig);
    const codegenTool = createCodeGenTool(
      { ...llmConfig, useRag: this.config.useRag },
      undefined,
      async event => {
        await this.emitEvent(onProgress, event as unknown as CodingAgentEvent);
      }
    );

    // ========== Step 1: BDD 拆解 ==========
    fixedPlan.steps[0].status = 'in_progress';
    await this.emitEvent(onProgress, {
      type: 'plan_update',
      plan: { ...fixedPlan },
      timestamp: Date.now(),
    });

    await this.emitEvent(onProgress, {
      type: 'phase_start',
      phase: 'bdd',
      message: '正在拆解 BDD 场景...',
      timestamp: Date.now(),
    });

    const bddCallId = `bdd_${Date.now()}`;
    await this.emitEvent(onProgress, {
      type: 'tool_call',
      toolCallId: bddCallId,
      toolName: 'decompose_to_bdd',
      args: { requirement },
      timestamp: Date.now(),
    });

    const bddStartTime = Date.now();
    const bddResultRaw = await bddTool.execute({ requirement });
    const bddDuration = Date.now() - bddStartTime;

    await this.emitEvent(onProgress, {
      type: 'tool_call_result',
      toolCallId: bddCallId,
      toolName: 'decompose_to_bdd',
      result: bddResultRaw,
      success: true,
      duration: bddDuration,
      timestamp: Date.now(),
    });

    // 解析 BDD 结果
    const bddFeatures: BDDFeature[] = JSON.parse(bddResultRaw);
    results.bddFeatures = bddFeatures;

    await this.emitEvent(onProgress, {
      type: 'bdd_generated',
      features: bddFeatures,
      timestamp: Date.now(),
    });

    await this.emitEvent(onProgress, {
      type: 'phase_complete',
      phase: 'bdd',
      data: bddFeatures,
      timestamp: Date.now(),
    });

    fixedPlan.steps[0].status = 'done';
    fixedPlan.steps[0].result = `生成 ${bddFeatures.length} 个功能场景`;
    fixedPlan.history.push({
      stepId: 'step_1',
      result: bddResultRaw,
      toolName: 'decompose_to_bdd',
      resultType: 'json',
      timestamp: new Date(),
    });

    // ========== Step 2: 架构设计 ==========
    fixedPlan.steps[1].status = 'in_progress';
    await this.emitEvent(onProgress, {
      type: 'plan_update',
      plan: { ...fixedPlan },
      timestamp: Date.now(),
    });

    await this.emitEvent(onProgress, {
      type: 'phase_start',
      phase: 'architect',
      message: '正在设计项目架构...',
      timestamp: Date.now(),
    });

    const archCallId = `arch_${Date.now()}`;
    await this.emitEvent(onProgress, {
      type: 'tool_call',
      toolCallId: archCallId,
      toolName: 'design_architecture',
      args: { bdd_scenarios: bddFeatures },
      timestamp: Date.now(),
    });

    const archStartTime = Date.now();
    // 直接程序化传递 BDD 结果
    const archResultRaw = await architectTool.execute({ bdd_scenarios: bddFeatures });
    const archDuration = Date.now() - archStartTime;

    await this.emitEvent(onProgress, {
      type: 'tool_call_result',
      toolCallId: archCallId,
      toolName: 'design_architecture',
      result: archResultRaw,
      success: true,
      duration: archDuration,
      timestamp: Date.now(),
    });

    // 解析架构结果
    const architecture: ArchitectureFile[] = JSON.parse(archResultRaw);
    results.architecture = architecture;

    await this.emitEvent(onProgress, {
      type: 'architecture_generated',
      files: architecture,
      timestamp: Date.now(),
    });

    await this.emitEvent(onProgress, {
      type: 'phase_complete',
      phase: 'architect',
      data: architecture,
      timestamp: Date.now(),
    });

    fixedPlan.steps[1].status = 'done';
    fixedPlan.steps[1].result = `设计 ${architecture.length} 个文件`;
    fixedPlan.history.push({
      stepId: 'step_2',
      result: archResultRaw,
      toolName: 'design_architecture',
      resultType: 'json',
      timestamp: new Date(),
    });

    // ========== Step 3: 代码生成 ==========
    fixedPlan.steps[2].status = 'in_progress';
    await this.emitEvent(onProgress, {
      type: 'plan_update',
      plan: { ...fixedPlan },
      timestamp: Date.now(),
    });

    await this.emitEvent(onProgress, {
      type: 'phase_start',
      phase: 'codegen',
      message: '正在生成代码...',
      timestamp: Date.now(),
    });

    const codegenCallId = `codegen_${Date.now()}`;
    await this.emitEvent(onProgress, {
      type: 'tool_call',
      toolCallId: codegenCallId,
      toolName: 'generate_code',
      args: { bdd_scenarios: bddFeatures, architecture },
      timestamp: Date.now(),
    });

    const codegenStartTime = Date.now();
    // 直接程序化传递 BDD 和架构结果
    let codegenResultRaw: string;
    try {
      codegenResultRaw = await codegenTool.execute({
        bdd_scenarios: bddFeatures,
        architecture,
      });
    } catch (codegenError) {
      const errorMsg = codegenError instanceof Error ? codegenError.message : String(codegenError);
      console.error('[CodingAgent] CodeGen tool execution failed:', errorMsg);
      console.error(
        '[CodingAgent] BDD count:',
        bddFeatures.length,
        'Arch count:',
        architecture.length
      );
      throw new Error(`代码生成失败: ${errorMsg}`);
    }
    const codegenDuration = Date.now() - codegenStartTime;

    await this.emitEvent(onProgress, {
      type: 'tool_call_result',
      toolCallId: codegenCallId,
      toolName: 'generate_code',
      result: codegenResultRaw,
      success: true,
      duration: codegenDuration,
      timestamp: Date.now(),
    });

    // 解析代码生成结果
    const codegenResult = JSON.parse(codegenResultRaw);
    results.codeResult = {
      files: codegenResult.files || [],
      tree: codegenResult.tree,
      summary: codegenResult.summary || '',
    };

    // 验证 tree 包含完整项目结构（包括 package.json 等模版文件）
    const treeKeys = Object.keys(codegenResult.tree || {});
    console.log('[CodingAgent] Tree contains:', treeKeys.join(', '));
    console.log('[CodingAgent] Has package.json:', 'package.json' in (codegenResult.tree || {}));

    await this.emitEvent(onProgress, {
      type: 'code_generated',
      files: results.codeResult.files,
      tree: results.codeResult.tree,
      summary: results.codeResult.summary,
      timestamp: Date.now(),
    });

    await this.emitEvent(onProgress, {
      type: 'phase_complete',
      phase: 'codegen',
      data: codegenResult,
      timestamp: Date.now(),
    });

    fixedPlan.steps[2].status = 'done';
    fixedPlan.steps[2].result = `生成 ${results.codeResult.files.length} 个代码文件`;

    // 发送最终的 plan_update
    await this.emitEvent(onProgress, {
      type: 'plan_update',
      plan: { ...fixedPlan },
      timestamp: Date.now(),
    });
  }

  /**
   * 增量修改模式：当有现有文件时，跳过 BDD 和架构，直接生成代码
   */
  private async runIncrementalMode(
    requirement: string,
    files: NonNullable<CodingAgentInput['files']>,
    llmConfig: {
      model: string;
      provider: CodingAgentConfig['provider'];
      apiKey?: string;
      baseUrl?: string;
    },
    results: {
      bddFeatures: BDDFeature[];
      architecture: ArchitectureFile[];
      codeResult?: CodeGenResult;
    },
    onProgress?: CodingAgentInput['onProgress']
  ): Promise<void> {
    await this.emitEvent(onProgress, {
      type: 'phase_start',
      phase: 'codegen',
      message: '检测到项目上下文，正在进行增量修改...',
      timestamp: Date.now(),
    });

    const codeGenTool = createCodeGenTool(
      { ...llmConfig, useRag: this.config.useRag },
      files,
      async event => {
        await this.emitEvent(onProgress, event as unknown as CodingAgentEvent);
      }
    );

    // 增量模式：构造符合 Schema 的占位 BDD 和 Architecture 结构
    const incrementalBDD = [
      {
        feature_id: 'incremental_modification',
        feature_title: '增量代码修改',
        description: requirement,
        scenarios: [
          {
            id: 'scenario_incremental',
            title: '用户修改请求',
            given: ['存在现有项目代码'],
            when: ['用户请求修改'],
            then: ['代码按需求更新'],
          },
        ],
      },
    ];

    const incrementalArchitecture = files.map(f => ({
      path: f.path,
      type: 'component' as const,
      description: `现有文件: ${f.path}`,
      bdd_references: ['scenario_incremental'],
      status: 'pending_generation' as const,
      dependencies: [] as { path: string; import: string[] }[],
      rag_context_used: null,
      content: null,
    }));

    const rawResult = await codeGenTool.execute({
      bdd_scenarios: incrementalBDD,
      architecture: incrementalArchitecture,
    });

    // 解析结果
    try {
      const json = JSON.parse(rawResult);
      results.codeResult = {
        files: json.files || [],
        tree: json.tree,
        summary: json.summary || '',
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
      console.error('[CodingAgent] Error parsing incremental result:', e);
      throw new Error('代码生成结果解析失败');
    }
  }

  /**
   * 发出事件
   */
  private async emitEvent(
    handler: CodingAgentInput['onProgress'],
    event: CodingAgentEvent
  ): Promise<void> {
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
      new SystemMessage(
        '你是一个友好的编程助手。根据用户的需求，生成一条简短的中文确认消息（20字以内），告诉用户你即将开始为他们做什么。语气要友好专业，可以使用1个emoji。只返回确认消息本身，不要有其他内容。示例："好的，我来帮您生成登录页 ✨"'
      ),
      new HumanMessage(`用户需求: ${requirement}`),
    ]);

    return (response.content as string).trim();
  }
}
