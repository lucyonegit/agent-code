/**
 * 架构设计工具
 * 基于 BDD 场景生成项目架构
 */

import { z } from 'zod';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { createLLM } from '../../../core/BaseLLM';
import { CODING_AGENT_PROMPTS } from '../config/prompt';
import type { Tool, LLMProvider } from '../../../types/index';
import {
  BDDFeatureSchema,
  BDDResultSchema,
  ArchitectureResultSchema,
  type BDDResult,
} from './schemas';

export { ArchitectureResultSchema };

export interface LLMConfig {
  model: string;
  provider: LLMProvider;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * 创建架构设计工具
 * 使用强类型 BDDResultSchema 作为参数，确保 LLM 传递正确的数据结构
 */
export function createArchitectTool(config: LLMConfig): Tool {
  return {
    name: 'design_architecture',
    description: `基于 BDD 场景设计项目文件架构。

【极其重要】bdd_scenarios 参数必须是 decompose_to_bdd 工具返回的完整数组数据，严禁任何形式的修改、总结或重写！

正确格式示例：
[{"feature_id":"F1","feature_title":"xxx","description":"xxx","scenarios":[{"id":"scenario_1","title":"xxx","given":["条件"],"when":["动作"],"then":["结果"]}]}]`,
    returnType: 'json',
    // 使用强类型 Schema：必须是 BDD 结果数组
    parameters: z.object({
      bdd_scenarios: z.array(BDDFeatureSchema).describe(
        `【强类型约束】必须是 decompose_to_bdd 工具返回的完整 BDD 数组。
每个元素必须包含：feature_id, feature_title, description, scenarios 字段。
scenarios 数组中每个场景必须包含：id, title, given, when, then 字段。
严禁自己编写、修改或简化！必须原样传递！`
      ),
    }),
    execute: async args => {
      // 使用 Zod 进行强类型验证
      const validationResult = BDDResultSchema.safeParse(args.bdd_scenarios);
      if (!validationResult.success) {
        const errors = validationResult.error.issues
          .map(issue => `[${issue.path.join('.')}] ${issue.message}`)
          .join('; ');
        throw new Error(
          `bdd_scenarios 格式验证失败: ${errors}。请原样传递 decompose_to_bdd 工具的完整输出！`
        );
      }

      const bddData: BDDResult = validationResult.data;

      const llm = createLLM({
        model: 'qwen3-coder-plus',
        provider: config.provider,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
      });

      // LangChain tool 调用返回的 args 总是对象形式，需要用对象包装
      const architectToolSchema = z.object({
        files: ArchitectureResultSchema.describe('架构文件数组'),
      });

      const architectTool = {
        name: 'output_architecture',
        description: '当设计完毕后，严格调用此工具输出架构设计结果',
        schema: architectToolSchema,
      };

      const llmWithTool = llm.bindTools([architectTool], {
        tool_choice: { type: 'function', function: { name: 'output_architecture' } },
      });

      const response = await llmWithTool.invoke([
        new SystemMessage(CODING_AGENT_PROMPTS.ARCHITECT_GENERATOR_PROMPT),
        new HumanMessage(
          `BDD 规范:\n${JSON.stringify(bddData, null, 2)}\n\n请基于以上 BDD 规范设计项目架构。`
        ),
      ]);

      if (response.tool_calls && response.tool_calls.length > 0) {
        const toolArgs = response.tool_calls[0].args as { files: unknown };
        let result = toolArgs.files;

        // 防止 LLM 返回字符串而非对象（某些模型会这样）
        if (typeof result === 'string') {
          console.warn('[ArchitectTool] LLM returned files as string, parsing...');
          try {
            result = JSON.parse(result);
          } catch {
            throw new Error(`架构结果解析失败: LLM 返回了无效的 JSON 字符串`);
          }
        }

        // 验证架构是否符合规范
        const archValidationResult = validateArchitecture(result);
        if (!archValidationResult.valid) {
          throw new Error(`架构验证失败: ${archValidationResult.errors.join('; ')}`);
        }

        return JSON.stringify(result, null, 2);
      }

      throw new Error('架构设计失败');
    },
  };
}

/**
 * 架构验证结果
 */
export interface ArchitectureValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * 验证架构是否符合 Schema 定义
 * @param architecture - 架构 JSON 字符串或对象
 * @returns 验证结果
 */
export function validateArchitecture(architecture: string | unknown): ArchitectureValidationResult {
  const errors: string[] = [];

  // 解析 JSON
  let parsed: unknown;
  if (typeof architecture === 'string') {
    try {
      parsed = JSON.parse(architecture);
    } catch {
      return { valid: false, errors: ['无效的 JSON 格式'] };
    }
  } else {
    parsed = architecture;
  }

  // Schema 校验
  const schemaResult = ArchitectureResultSchema.safeParse(parsed);
  if (!schemaResult.success) {
    schemaResult.error.issues.forEach(issue => {
      errors.push(`[${issue.path.join('.')}] ${issue.message}`);
    });
    return { valid: false, errors };
  }

  // 额外业务规则校验
  const files = schemaResult.data;

  files.forEach((file, index) => {
    // 校验 path 必须从 src 开始
    if (!file.path.startsWith('src/')) {
      errors.push(`[${index}] path "${file.path}" 必须从 src/ 开始`);
    }

    // 校验 dependencies path 必须从 src 开始
    file.dependencies.forEach((dep, depIndex) => {
      if (!dep.path.startsWith('src/')) {
        errors.push(`[${index}].dependencies[${depIndex}] path "${dep.path}" 必须从 src/ 开始`);
      }
    });

    // 校验依赖不能引用自身
    file.dependencies.forEach((dep, depIndex) => {
      if (dep.path === file.path) {
        errors.push(`[${index}].dependencies[${depIndex}] 文件不能依赖自身`);
      }
    });
  });

  // 校验所有依赖路径都在架构中存在
  const allPaths = new Set(files.map(f => f.path));
  files.forEach((file, index) => {
    file.dependencies.forEach((dep, depIndex) => {
      if (!allPaths.has(dep.path)) {
        errors.push(`[${index}].dependencies[${depIndex}] 依赖 "${dep.path}" 不存在于架构中`);
      }
    });
  });

  // 校验必须包含 App.tsx
  const hasAppTsx = files.some(f => f.path === 'src/App.tsx');
  if (!hasAppTsx) {
    errors.push('架构必须包含 src/App.tsx 作为应用入口');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
