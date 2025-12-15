/**
 * CodingAgent - 编码智能体
 * 
 * 完整的编码流水线：
 * 用户需求 → BDD 拆解 → 架构设计 → 代码生成
 */

import { decomposeToBDD } from './tools/bdd';
import { generateArchitecture } from './tools/architect';
import { generateCode } from './tools/codegen';
import type {
  CodingAgentConfig,
  CodingAgentInput,
  CodingAgentResult,
  CodingAgentEvent,
} from '../types/index';

/**
 * CodingAgent - 编码智能体
 * 
 * @example
 * ```typescript
 * const agent = new CodingAgent({
 *   model: 'qwen-plus',
 *   provider: 'tongyi',
 *   apiKey: process.env.DASHSCOPE_API_KEY,
 * });
 * 
 * const result = await agent.run({
 *   requirement: '实现一个用户登录页面，包含用户名、密码输入框和登录按钮',
 *   onProgress: (event) => console.log(event),
 * });
 * ```
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
    };
  }

  /**
   * 运行完整的编码流水线
   */
  async run(input: CodingAgentInput): Promise<CodingAgentResult> {
    const { requirement, onProgress } = input;

    try {
      // === 阶段 1: BDD 拆解 ===
      await this.emitEvent(onProgress, {
        type: 'phase_start',
        phase: 'bdd',
        message: '正在将需求拆解为 BDD 场景...',
      });

      const bddFeatures = await decomposeToBDD(requirement, {
        model: this.config.model,
        provider: this.config.provider,
        apiKey: this.config.apiKey,
        baseUrl: this.config.baseUrl,
      });

      await this.emitEvent(onProgress, {
        type: 'phase_complete',
        phase: 'bdd',
        data: bddFeatures,
      });

      // === 阶段 2: 架构设计 ===
      await this.emitEvent(onProgress, {
        type: 'phase_start',
        phase: 'architect',
        message: '正在基于 BDD 场景设计项目架构...',
      });

      const architecture = await generateArchitecture(bddFeatures, {
        model: this.config.model,
        provider: this.config.provider,
        apiKey: this.config.apiKey,
        baseUrl: this.config.baseUrl,
      });

      await this.emitEvent(onProgress, {
        type: 'phase_complete',
        phase: 'architect',
        data: architecture,
      });

      // === 阶段 3: 代码生成 ===
      await this.emitEvent(onProgress, {
        type: 'phase_start',
        phase: 'codegen',
        message: '正在生成项目代码...',
      });

      // 使用 CodeGenerator 执行代码生成
      const codeResult = await generateCode(bddFeatures, architecture, {
        model: this.config.model,
        provider: this.config.provider,
        apiKey: this.config.apiKey,
        baseUrl: this.config.baseUrl,
      }, {
        onThought: (content) => {
          this.emitEvent(onProgress, { type: 'thought', content });
        },
      });

      await this.emitEvent(onProgress, {
        type: 'phase_complete',
        phase: 'codegen',
        data: codeResult,
      });

      return {
        success: true,
        bddFeatures,
        architecture,
        generatedFiles: codeResult.files,
        summary: codeResult.summary,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误';

      await this.emitEvent(onProgress, {
        type: 'error',
        message: errorMessage,
      });

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * 发出事件
   */
  private async emitEvent(
    handler: CodingAgentInput['onProgress'],
    event: CodingAgentEvent
  ): Promise<void> {
    if (handler) {
      await handler(event);
    }
  }
}