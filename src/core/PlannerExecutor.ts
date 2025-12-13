/**
 * PlannerExecutor - 双循环规划架构
 * 
 * 实现 Planner + ReAct 两层循环：
 * - 外层循环：Planner 生成和调整计划
 * - 内层循环：ReActExecutor 执行每个步骤
 * 
 * 关键特性：
 * - 基于执行结果的动态重规划
 * - 带上下文传递的逐步执行
 * - 计划生成使用 tool call 实现结构化输出
 * - 多模型支持：OpenAI、通义千问和 OpenAI 兼容端点
 */

import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { ReActExecutor } from './ReActExecutor.js';
import {
  PlanSchema,
  type Plan,
  type PlanStep,
  type PlannerConfig,
  type PlannerInput,
  type PlannerResult,
  type Tool,
  type LLMProvider,
} from '../types/index.js';

/**
 * 计划优化输出的 Zod schema
 */
const PlanRefinementSchema = z.object({
  shouldReplan: z.boolean().describe('计划是否需要调整'),
  reasoning: z.string().describe('决策的解释'),
  updatedSteps: z.array(z.object({
    id: z.string(),
    description: z.string(),
    requiredTools: z.array(z.string()).optional(),
    status: z.enum(['pending', 'skipped']).optional(),
  })).optional().describe('如果需要重规划，更新后的剩余步骤'),
});

type PlanRefinement = z.infer<typeof PlanRefinementSchema>;

/**
 * 规划器的系统提示词
 */
const PLANNER_SYSTEM_PROMPT = `你是一个战略规划 AI。你的工作是将复杂目标分解为可执行的步骤。

对于每个目标，创建一个包含以下内容的计划：
1. 清晰、具体的步骤，可以独立执行
2. 每个步骤适当的工具分配
3. 必要时的逻辑排序和依赖关系

返回一个包含以下内容的 JSON 对象：
- goal: 总体目标
- steps: 步骤数组，每个步骤包含 id、description、requiredTools（可选）、dependencies（可选）
- reasoning: 选择此计划的理由

保持步骤专注且可实现。每个步骤应该能够被拥有指定工具的 AI agent 完成。`;

/**
 * 计划优化的系统提示词
 */
const REFINE_SYSTEM_PROMPT = `你是一个战略规划 AI。根据已完成步骤的执行结果，决定剩余计划是否需要调整。

考虑：
1. 步骤是否产生了预期结果？
2. 剩余步骤是否仍然相关？
3. 是否应该添加、修改或跳过某些步骤？

返回一个包含以下内容的 JSON 对象：
- shouldReplan: 布尔值，表示是否需要更改
- reasoning: 决策的解释
- updatedSteps:（如果重规划）更新后的剩余步骤列表`;

/**
 * PlannerExecutor - 实现 Planner + ReAct 双循环架构
 * 
 * @example
 * ```typescript
 * // 使用 OpenAI
 * const planner = new PlannerExecutor({
 *   plannerModel: 'gpt-4',
 *   executorModel: 'gpt-3.5-turbo',
 *   provider: 'openai'
 * });
 * 
 * // 使用通义千问
 * const planner = new PlannerExecutor({
 *   plannerModel: 'qwen-plus',
 *   executorModel: 'qwen-turbo',
 *   provider: 'tongyi',
 *   apiKey: process.env.DASHSCOPE_API_KEY
 * });
 * ```
 */
export class PlannerExecutor {
  private config: {
    plannerModel: string;
    executorModel: string;
    provider: LLMProvider;
    maxIterationsPerStep: number;
    maxRePlanAttempts: number;
    apiKey?: string;
    baseUrl?: string;
  };

  constructor(config: PlannerConfig) {
    this.config = {
      plannerModel: config.plannerModel,
      executorModel: config.executorModel,
      provider: config.provider ?? 'openai',
      maxIterationsPerStep: config.maxIterationsPerStep ?? 10,
      maxRePlanAttempts: config.maxRePlanAttempts ?? 3,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    };
  }

  /**
   * 运行完整的 Planner + ReAct 工作流
   */
  async run(input: PlannerInput): Promise<PlannerResult> {
    const { goal, tools, onMessage, onPlanUpdate } = input;

    try {
      // 步骤 1：生成初始计划
      let plan = await this.generatePlan(goal, tools);

      // 步骤 2：执行计划步骤
      let rePlanAttempts = 0;

      while (!this.isPlanComplete(plan)) {
        const currentStep = this.getNextStep(plan);
        if (!currentStep) {
          break;
        }

        // 将步骤标记为进行中
        currentStep.status = 'in_progress';
        await onPlanUpdate?.(plan);

        // 获取此步骤的工具
        const stepTools = this.getToolsForStep(currentStep, tools);

        // 为此步骤创建 ReActExecutor
        const executor = new ReActExecutor({
          model: this.config.executorModel,
          provider: this.config.provider,
          maxIterations: this.config.maxIterationsPerStep,
          apiKey: this.config.apiKey,
          baseUrl: this.config.baseUrl,
          streaming:true
        });

        // 执行步骤
        await onMessage?.({
          type: 'thought',
          content: `正在执行步骤 ${currentStep.id}: ${currentStep.description}`,
        });

        const stepResult = await executor.run({
          input: currentStep.description,
          context: this.formatPlanHistory(plan),
          tools: stepTools,
          onMessage,
        });

        // 更新步骤状态
        currentStep.result = stepResult;
        currentStep.status = 'done';
        plan.history.push({
          stepId: currentStep.id,
          result: stepResult,
          timestamp: new Date(),
        });
        await onPlanUpdate?.(plan);

        // 动态重规划
        if (rePlanAttempts < this.config.maxRePlanAttempts) {
          const refinement = await this.refinePlan(plan, stepResult, tools);
          
          if (refinement.shouldReplan && refinement.updatedSteps) {
            await onMessage?.({
              type: 'thought',
              content: `重规划中: ${refinement.reasoning}`,
            });

            const completedStepIds = new Set(
              plan.steps.filter(s => s.status === 'done').map(s => s.id)
            );

            plan.steps = [
              ...plan.steps.filter(s => completedStepIds.has(s.id)),
              ...refinement.updatedSteps.map(s => ({
                id: s.id,
                description: s.description,
                status: s.status || 'pending' as const,
                requiredTools: s.requiredTools,
              })),
            ];

            rePlanAttempts++;
            await onPlanUpdate?.(plan);
          }
        }
      }

      // 生成最终响应
      const response = await this.generateFinalResponse(plan);

      return { success: true, response, plan };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误';
      await onMessage?.({
        type: 'error',
        message: `规划器失败: ${errorMessage}`,
      });

      return {
        success: false,
        response: `无法完成计划: ${errorMessage}`,
        plan: { goal, steps: [], reasoning: '计划执行失败', history: [] },
      };
    }
  }

  /**
   * 为给定目标生成初始计划
   * 使用 tool call 方式实现结构化输出
   */
  private async generatePlan(goal: string, tools: Tool[]): Promise<Plan> {
    const llm = this.createLLM(this.config.plannerModel);
    
    // 定义 generate_plan 工具，用于获取结构化的计划输出
    const generatePlanTool = {
      name: 'generate_plan',
      description: '生成一个分步执行计划。你必须调用此工具来返回你的计划。',
      schema: PlanSchema,
    };
    
    // 绑定工具并强制使用
    const llmWithTool = llm.bindTools([generatePlanTool], {
      tool_choice: { type: 'function', function: { name: 'generate_plan' } },
    });
    
    const toolDescriptions = tools.map(t => `- ${t.name}: ${t.description}`).join('\n');

    const response = await llmWithTool.invoke([
      new SystemMessage(PLANNER_SYSTEM_PROMPT),
      new HumanMessage(`目标: ${goal}\n\n可用工具:\n${toolDescriptions}\n\n创建一个分步计划来实现这个目标。你必须调用 generate_plan 工具来返回你的计划。`),
    ]);

    // 从 tool_calls 中提取计划数据
    if (!response.tool_calls || response.tool_calls.length === 0) {
      throw new Error('LLM 未返回计划工具调用');
    }

    const toolCall = response.tool_calls[0];
    if (toolCall.name !== 'generate_plan') {
      throw new Error(`意外的工具调用: ${toolCall.name}`);
    }

    const planData = toolCall.args as z.infer<typeof PlanSchema>;

    return {
      goal: planData.goal,
      steps: planData.steps.map(step => ({
        id: step.id,
        description: step.description,
        status: 'pending' as const,
        requiredTools: step.requiredTools,
        dependencies: step.dependencies,
      })),
      reasoning: planData.reasoning,
      history: [],
    };
  }

  /**
   * 根据执行结果优化计划
   */
  private async refinePlan(plan: Plan, latestResult: string, tools: Tool[]): Promise<PlanRefinement> {
    const llm = this.createLLM(this.config.plannerModel);
    const structuredLLM = llm.withStructuredOutput(PlanRefinementSchema);

    const completedSteps = plan.steps.filter(s => s.status === 'done');
    const pendingSteps = plan.steps.filter(s => s.status === 'pending');

    const prompt = `目标: ${plan.goal}

已完成步骤:
${completedSteps.map(s => `- ${s.id}: ${s.description}\n  结果: ${s.result}`).join('\n')}

最新结果: ${latestResult}

剩余步骤:
${pendingSteps.map(s => `- ${s.id}: ${s.description}`).join('\n')}

可用工具: ${tools.map(t => t.name).join(', ')}

根据最新执行结果，剩余计划是否需要调整？`;

    const response = await structuredLLM.invoke([
      new SystemMessage(REFINE_SYSTEM_PROMPT),
      new HumanMessage(prompt),
    ]);

    return response as PlanRefinement;
  }

  /**
   * 生成汇总计划执行的最终响应
   */
  private async generateFinalResponse(plan: Plan): Promise<string> {
    const llm = this.createLLM(this.config.plannerModel);
    const stepSummaries = plan.steps
      .filter(s => s.status === 'done')
      .map(s => `步骤 ${s.id}: ${s.description}\n结果: ${s.result}`)
      .join('\n\n');

    const response = await llm.invoke([
      new SystemMessage('你是一个有帮助的助手。将已完成计划的结果汇总为给用户的清晰、全面的回复。'),
      new HumanMessage(`原始目标: ${plan.goal}\n\n已完成步骤:\n${stepSummaries}\n\n提供一个回答用户原始目标的最终摘要。`),
    ]);

    return response.content as string;
  }

  /** 检查计划是否完成 */
  private isPlanComplete(plan: Plan): boolean {
    return plan.steps.every(step => step.status === 'done' || step.status === 'skipped');
  }

  /** 获取下一个待执行的步骤 */
  private getNextStep(plan: Plan): PlanStep | undefined {
    return plan.steps.find(step => {
      if (step.status !== 'pending') return false;
      if (step.dependencies?.length) {
        return step.dependencies.every(depId => {
          const depStep = plan.steps.find(s => s.id === depId);
          return depStep?.status === 'done';
        });
      }
      return true;
    });
  }

  /** 获取特定步骤相关的工具 */
  private getToolsForStep(step: PlanStep, allTools: Tool[]): Tool[] {
    if (step.requiredTools?.length) {
      return allTools.filter(t => step.requiredTools!.includes(t.name));
    }
    return allTools;
  }

  /** 格式化计划历史作为执行器的上下文 */
  private formatPlanHistory(plan: Plan): string {
    if (!plan.history.length) return '';
    const entries = plan.history.map(entry => {
      const step = plan.steps.find(s => s.id === entry.stepId);
      return `步骤 ${entry.stepId} (${step?.description || '未知'}): ${entry.result}`;
    });
    return `之前步骤的结果:\n${entries.join('\n\n')}`;
  }

  /**
   * 创建 LLM 实例
   * 支持 OpenAI、通义千问和 OpenAI 兼容端点
   * 统一使用 ChatOpenAI 以支持 bindTools
   */
  private createLLM(model: string): ChatOpenAI {
    const baseConfig = {
      model,
      temperature: 0,
      apiKey: this.config.apiKey,
    };

    switch (this.config.provider) {
      case 'tongyi':
        // 使用通义千问的 OpenAI 兼容端点
        return new ChatOpenAI({
          ...baseConfig,
          configuration: {
            baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          },
        });
      
      case 'openai-compatible':
        return new ChatOpenAI({
          ...baseConfig,
          configuration: { baseURL: this.config.baseUrl },
        });
      
      case 'openai':
      default:
        return new ChatOpenAI(baseConfig);
    }
  }
}
