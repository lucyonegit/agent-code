/**
 * ReActParser - ReAct Agent 的结构化输出解析器
 * 
 * 本解析器使用 Zod schema 来验证和解析 LLM 输出。
 * 通过利用 LangChain 的结构化输出能力，完全避免基于正则表达式的解析。
 */

import { z } from 'zod';
import { ReActOutputSchema, type ReActOutput } from '../types/index.js';

/**
 * 解析 LLM 输出的结果
 */
export interface ParseResult {
  success: boolean;
  data?: ReActOutput;
  error?: string;
}

/**
 * ReActParser - 为 ReAct 循环解析和验证 LLM 输出
 * 
 * 使用 Zod schema 确保类型安全的解析，不使用正则表达式。
 * 提供处理格式错误输出的降级机制。
 * 
 * @example
 * ```typescript
 * const parser = new ReActParser();
 * 
 * const result = parser.parse({
 *   thought: "我需要搜索信息",
 *   action: { name: "search", arguments: { query: "test" } }
 * });
 * 
 * if (result.success) {
 *   console.log(result.data.thought);
 * }
 * ```
 */
export class ReActParser {
  private schema: z.ZodSchema<ReActOutput>;

  constructor() {
    this.schema = ReActOutputSchema;
  }

  /**
   * 解析并验证原始 LLM 输出
   * @param output - LLM 的原始输出（对象或 JSON 字符串）
   * @returns 包含成功/失败状态及数据或错误的 ParseResult
   */
  parse(output: unknown): ParseResult {
    try {
      // 如果输出是字符串，尝试解析为 JSON
      let data: unknown = output;
      if (typeof output === 'string') {
        data = this.parseJsonSafe(output);
        if (data === null) {
          return {
            success: false,
            error: '无法将输出解析为 JSON',
          };
        }
      }

      // 按 schema 验证
      const parsed = this.schema.parse(data);

      // 验证必须存在 action 或 final_answer（但不能同时存在）
      if (!parsed.action && !parsed.final_answer) {
        return {
          success: false,
          error: '输出必须包含 "action" 或 "final_answer"',
        };
      }

      if (parsed.action && parsed.final_answer) {
        // 如果两者都存在，优先处理 action（继续循环）
        // 这是一个优雅处理的设计决策
        return {
          success: true,
          data: {
            thought: parsed.thought,
            action: parsed.action,
            final_answer: undefined,
          },
        };
      }

      return {
        success: true,
        data: parsed,
      };
    } catch (error) {
      if (error instanceof z.ZodError) {
        return {
          success: false,
          error: `验证错误: ${error.errors.map(e => e.message).join(', ')}`,
        };
      }
      return {
        success: false,
        error: `解析错误: ${error instanceof Error ? error.message : '未知错误'}`,
      };
    }
  }

  /**
   * 带降级的解析 - 即使失败也尝试提取有用信息
   * @param output - LLM 的原始输出
   * @returns 尽力解析的 ParseResult
   */
  parseWithFallback(output: unknown): ParseResult {
    // 首先尝试正常解析
    const result = this.parse(output);
    if (result.success) {
      return result;
    }

    // 降级：尝试从字符串输出中提取最终答案
    if (typeof output === 'string') {
      // 如果解析完全失败，将整个字符串视为思考
      // 并假设我们需要更多上下文
      return {
        success: true,
        data: {
          thought: output,
          final_answer: undefined,
          action: undefined,
        },
      };
    }

    // 降级：尝试从对象中提取部分数据
    if (typeof output === 'object' && output !== null) {
      const obj = output as Record<string, unknown>;
      
      // 尝试提取 thought
      const thought = typeof obj.thought === 'string' ? obj.thought : '无法解析思考内容';
      
      // 尝试提取 final_answer
      if (typeof obj.final_answer === 'string') {
        return {
          success: true,
          data: {
            thought,
            final_answer: obj.final_answer,
          },
        };
      }

      // 尝试提取 action
      if (typeof obj.action === 'object' && obj.action !== null) {
        const action = obj.action as Record<string, unknown>;
        if (typeof action.name === 'string') {
          return {
            success: true,
            data: {
              thought,
              action: {
                name: action.name,
                arguments: typeof action.arguments === 'object' ? action.arguments as Record<string, any> : {},
              },
            },
          };
        }
      }
    }

    // 如果降级也失败则返回原始错误
    return result;
  }

  /**
   * 安全解析 JSON 字符串，处理常见问题
   * @param jsonString - 要解析的 JSON 字符串
   * @returns 解析后的对象，失败则返回 null
   */
  private parseJsonSafe(jsonString: string): unknown {
    try {
      // 移除可能的 markdown 代码块包装
      let cleaned = jsonString.trim();
      
      // 如果存在 ```json 和 ``` 包装则移除
      if (cleaned.startsWith('```json')) {
        cleaned = cleaned.slice(7);
      } else if (cleaned.startsWith('```')) {
        cleaned = cleaned.slice(3);
      }
      if (cleaned.endsWith('```')) {
        cleaned = cleaned.slice(0, -3);
      }
      
      cleaned = cleaned.trim();
      
      return JSON.parse(cleaned);
    } catch {
      return null;
    }
  }

  /**
   * 获取用于验证的 Zod schema
   * 用于与 LangChain 的 withStructuredOutput 集成
   */
  getSchema(): z.ZodSchema<ReActOutput> {
    return this.schema;
  }

  /**
   * 检查输出是否表示最终答案
   * @param output - 解析后的 ReAct 输出
   */
  isFinalAnswer(output: ReActOutput): boolean {
    return output.final_answer !== undefined && output.final_answer !== null;
  }

  /**
   * 检查输出是否表示动作
   * @param output - 解析后的 ReAct 输出
   */
  isAction(output: ReActOutput): boolean {
    return output.action !== undefined && output.action !== null;
  }
}
