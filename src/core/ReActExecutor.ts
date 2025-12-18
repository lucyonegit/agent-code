/**
 * ReActExecutor - 核心 ReAct（推理 + 行动）循环引擎
 * 
 * 关键特性：
 * - 业务无关：只处理循环控制，不涉及工具实现
 * - 动态工具注入：工具作为参数传入
 * - 事件驱动：通过 onMessage 回调进行通信
 * - 干净的流式输出：thought 通过 content 流式输出，action 通过 tool_calls 累积
 * - 多模型支持：支持 OpenAI、通义千问和 OpenAI 兼容端点
 * - 可选的最终答案工具：业务层传入，ReAct 内部拼装系统提示词
 * 
 * 这是一个业务无关的基础架构组件。
 * 所有提示词和消息都可通过 ReActConfig 配置。
 */

import { z } from 'zod';
import { ChatOpenAI } from '@langchain/openai';
import { createLLM } from './BaseLLM.js';
import { HumanMessage, SystemMessage, AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { mergeToolCalls, toLangChainToolCalls, type AccumulatedToolCall, type ToolCallChunk } from './utils/streamHelper.js';
import { toolsToLangChain } from './ToolRegistry.js';
import {
  type ReActConfig,
  type ReActInput,
  type ReActEvent,
  type Tool,
  type LLMProvider,
} from '../types/index.js';

/**
 * 默认 ReAct 系统提示词（导出供外部使用）
 */
export const DEFAULT_REACT_PROMPT = `你是一个有帮助的 AI 助手，使用 ReAct（推理 + 行动）方法来解决问题。

工作流程：
1. 首先，在回复内容中写下你的思考过程（这部分会流式输出给用户）
2. 然后，如果需要使用工具获取信息，调用相应的工具
3. 根据工具返回的结果继续思考和行动

重要提示：
- 先思考，后行动
- 思考过程写在回复内容中
- 需要使用工具时调用相应的 function`;

/**
 * 默认最终答案工具（导出供外部使用）
 */
export const defaultFinalAnswerTool: Tool = {
  name: 'give_final_answer',
  description: '当你完成所有思考和推理后，调用此函数给出最终答案。只在你确定答案时调用。',
  parameters: z.object({
    answer: z.string().describe('最终答案的完整内容'),
  }),
  execute: async () => '',
};

/**
 * 最终答案工具的系统提示词后缀模板
 */
const FINAL_ANSWER_PROMPT_SUFFIX = (toolName: string) => `

特别注意：
- 当你有了最终答案，必须调用 ${toolName} 工具来给出答案
- 最终答案必须通过调用 ${toolName} 工具来给出，不要直接在回复中给出最终答案`;

/**
 * 默认用户消息模板（导出供外部使用）
 */
export const defaultUserMessageTemplate = (input: string, toolDescriptions: string, context?: string): string => {
  let message = `任务: ${input}\n\n可用工具:\n${toolDescriptions}`;
  if (context) {
    message += `\n\n之前步骤的上下文:\n${context}`;
  }
  return message;
};

/**
 * ReActExecutor - 核心 ReAct 循环引擎
 */
export class ReActExecutor {
  private config: {
    model: string;
    provider: LLMProvider;
    maxIterations: number;
    systemPrompt: string;
    temperature: number;
    streaming: boolean;
    apiKey?: string;
    baseUrl?: string;
    userMessageTemplate: (input: string, toolDescriptions: string, context?: string) => string;
    finalAnswerTool: Tool;
  };

  constructor(config: ReActConfig) {
    this.config = {
      model: config.model,
      provider: config.provider ?? 'openai',
      maxIterations: config.maxIterations ?? 10,
      systemPrompt: config.systemPrompt ?? DEFAULT_REACT_PROMPT,
      temperature: config.temperature ?? 0,
      streaming: config.streaming ?? false,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      userMessageTemplate: config.userMessageTemplate ?? defaultUserMessageTemplate,
      finalAnswerTool: config.finalAnswerTool || defaultFinalAnswerTool,
    };
  }

  /**
   * 执行 ReAct 循环
   */
  async run(input: ReActInput): Promise<string> {
    const { input: userInput, context, tools, onMessage } = input;
    const startTime = Date.now();

    const llm = createLLM({
      model: this.config.model,
      provider: this.config.provider,
      temperature: this.config.temperature,
      apiKey: this.config.apiKey,
      baseUrl: this.config.baseUrl,
      streaming: this.config.streaming,
    });

    // 如果提供了最终答案工具，添加到工具列表
    const allTools = this.config.finalAnswerTool
      ? [...tools, this.config.finalAnswerTool]
      : tools;

    // 转换为 LangChain 工具格式并绑定
    const langChainTools = toolsToLangChain(allTools);
    const llmWithTools = llm.bindTools(langChainTools, {
      tool_choice: 'auto',
    });

    // 构建提示词的工具描述
    const toolDescriptions = this.formatToolDescriptions(tools);

    // 构建系统提示词（如果有最终答案工具，添加使用说明）
    let systemPrompt = this.config.systemPrompt;
    if (this.config.finalAnswerTool) {
      systemPrompt += FINAL_ANSWER_PROMPT_SUFFIX(this.config.finalAnswerTool.name);
    }

    // 初始化对话历史
    const messages: BaseMessage[] = [
      new SystemMessage(systemPrompt),
    ];

    // 使用模板构建初始用户消息
    const userMessage = this.config.userMessageTemplate(userInput, toolDescriptions, context);
    messages.push(new HumanMessage(userMessage));

    // 跟踪迭代历史和计数
    const iterationHistory: string[] = [];
    let completedIterations = 0;

    console.log('ReAct Executor 循环开始...');

    // 主 ReAct 循环
    for (let iteration = 1; iteration <= this.config.maxIterations; iteration++) {
      completedIterations = iteration;
      console.log(`第${iteration}循环开始... (当前消息数: ${messages.length})`);
      // 为本次迭代生成唯一的 thoughtId
      const iterationId = `thought_${Date.now()}_${iteration}`;

      try {
        if (this.config.streaming) {
          // === 流式模式 ===
          const result = await this.streamIteration(
            llmWithTools, messages, tools, onMessage, iterationId, startTime, iteration
          );

          if (result.isFinalAnswer) {
            return result.content;
          }

          // 继续下一轮迭代（工具结果已添加到 messages）
          iterationHistory.push(result.content);
        } else {
          // === 非流式模式 ===
          const response = await llmWithTools.invoke(messages);
          const content = typeof response.content === 'string' ? response.content : '';

          // 发出思考事件
          if (content) {
            await this.emitEvent(onMessage, {
              type: 'thought',
              thoughtId: iterationId,
              chunk: content,
              isComplete: true,
              timestamp: Date.now(),
            });
          }

          messages.push(response);

          // 检查是否有工具调用
          if (response.tool_calls && response.tool_calls.length > 0) {
            // 检查是否调用了最终答案工具
            if (this.config.finalAnswerTool) {
              const finalAnswerCall = response.tool_calls.find(
                call => call.name === this.config.finalAnswerTool!.name
              );

              if (finalAnswerCall) {
                // 提取最终答案
                const answer = (finalAnswerCall.args as { answer?: string }).answer || content;

                // 发出 final_result 事件
                await this.emitEvent(onMessage, {
                  type: 'final_result',
                  content: answer,
                  totalDuration: Date.now() - startTime,
                  iterationCount: iteration,
                  timestamp: Date.now(),
                });
                return answer;
              }
            }

            // 处理普通工具调用
            for (const call of response.tool_calls) {
              const toolCallId = call.id || `call_${Date.now()}`;
              const toolStartTime = Date.now();

              // 发出 tool_call 事件
              await this.emitEvent(onMessage, {
                type: 'tool_call',
                toolCallId,
                toolName: call.name,
                args: call.args,
                timestamp: toolStartTime,
              });

              // 执行工具
              const tool = allTools.find(t => t.name === call.name);
              let observation: string;
              let success = true;

              if (!tool) {
                observation = `工具 "${call.name}" 未找到`;
                success = false;
                await this.emitEvent(onMessage, { type: 'error', message: observation, timestamp: Date.now() });
              } else {
                try {
                  observation = await tool.execute(call.args);
                } catch (error) {
                  observation = `工具执行失败: ${error instanceof Error ? error.message : '未知错误'}`;
                  success = false;
                  await this.emitEvent(onMessage, { type: 'error', message: observation, timestamp: Date.now() });
                }
              }

              // 发出 tool_call_result 事件
              await this.emitEvent(onMessage, {
                type: 'tool_call_result',
                toolCallId,
                toolName: call.name,
                result: observation,
                success,
                duration: Date.now() - toolStartTime,
                timestamp: Date.now(),
              });

              messages.push(new ToolMessage({
                tool_call_id: toolCallId,
                content: observation,
              }));

              iterationHistory.push(`动作: ${call.name}\n观察: ${observation}`);
            }
          }
          // 没有工具调用 - 继续下一轮迭代
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : '未知错误';
        await this.emitEvent(onMessage, {
          type: 'error',
          message: `第 ${iteration} 次迭代失败: ${errorMessage}`,
          timestamp: Date.now(),
        });
        messages.push(new HumanMessage(`发生错误: ${errorMessage}\n请继续尝试。`));
      }

      // 防止无限循环：如果连续多次没有工具调用且输出为空
      if (!this.config.streaming && !messages[messages.length - 1].content && !(messages[messages.length - 1] as AIMessage).tool_calls?.length) {
        break;
      }
    }

    // 达到最大迭代次数
    const fallbackAnswer = `已达到最大迭代次数 (${this.config.maxIterations})。\n\n${iterationHistory.join('\n\n')}`;
    await this.emitEvent(onMessage, {
      type: 'final_result',
      content: fallbackAnswer,
      totalDuration: Date.now() - startTime,
      iterationCount: completedIterations,
      timestamp: Date.now(),
    });
    return fallbackAnswer;
  }

  /**
   * 流式处理单次迭代
   * - content 部分流式输出作为 thought
   * - tool_calls 部分累积后处理作为 action
   */
  private async streamIteration(
    llm: ReturnType<ChatOpenAI['bindTools']>,
    messages: BaseMessage[],
    tools: Tool[],
    onMessage: ReActInput['onMessage'],
    iterationId: string,
    startTime: number,
    iteration: number
  ): Promise<{ isFinalAnswer: boolean; content: string }> {
    const stream = await llm.stream(messages);

    // 累积内容和工具调用
    let accumulatedContent = '';
    let accumulatedToolCalls: AccumulatedToolCall[] = [];

    // 所有工具（包括最终答案工具）
    const allTools = this.config.finalAnswerTool
      ? [...tools, this.config.finalAnswerTool]
      : tools;

    // 处理流式数据Thought & ToolCall
    for await (const chunk of stream) {
      // 阶段 1: Thought 流式输出
      if (chunk.content) {
        const text = typeof chunk.content === 'string' ? chunk.content : '';
        if (text) {
          process.stdout.write(text);
          accumulatedContent += text;
          await this.emitEvent(onMessage, {
            type: 'thought',
            thoughtId: iterationId,
            chunk: text,
            isComplete: false,
            timestamp: Date.now(),
          });
        }
      }

      // 阶段 2: Action 累积
      if (chunk.tool_call_chunks && chunk.tool_call_chunks.length > 0) {
        accumulatedToolCalls = mergeToolCalls(
          accumulatedToolCalls,
          chunk.tool_call_chunks as ToolCallChunk[]
        );
      }
    }

    if (accumulatedContent) {
      await this.emitEvent(onMessage, {
        type: 'thought',
        thoughtId: iterationId,
        chunk: '',
        isComplete: true,
        timestamp: Date.now(),
      });
    }

    // 构建 AI 消息并添加到历史
    const toolCalls = toLangChainToolCalls(accumulatedToolCalls);
    const aiMessage = new AIMessage({
      content: accumulatedContent,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    });
    messages.push(aiMessage);

    // 处理 Action
    if (accumulatedToolCalls.length > 0) {
      // 检查是否调用了最终答案工具
      const finalAnswerCall = toolCalls.find(
        call => call.name === this.config.finalAnswerTool!.name
      );
      if (finalAnswerCall) {
        // 提取最终答案
        const answer = (finalAnswerCall.args as { answer?: string }).answer || accumulatedContent;

        // 发出 final_result 事件
        await this.emitEvent(onMessage, {
          type: 'final_result',
          content: answer,
          totalDuration: Date.now() - startTime,
          iterationCount: iteration,
          timestamp: Date.now(),
        });

        return { isFinalAnswer: true, content: answer };
      }

      // 处理普通工具调用
      for (const call of toolCalls) {
        const toolCallId = call.id || `call_${Date.now()}`;
        const toolStartTime = Date.now();

        // 发出 tool_call 事件
        await this.emitEvent(onMessage, {
          type: 'tool_call',
          toolCallId,
          toolName: call.name,
          args: call.args,
          timestamp: toolStartTime,
        });

        // 执行工具
        const tool = allTools.find(t => t.name === call.name);
        let observation: string;
        let success = true;

        if (!tool) {
          observation = `工具 "${call.name}" 未找到。可用工具: ${allTools.map(t => t.name).join(', ')}`;
          success = false;
          await this.emitEvent(onMessage, { type: 'error', message: observation, timestamp: Date.now() });
        } else {
          try {
            observation = await tool.execute(call.args);
          } catch (error) {
            observation = `工具执行失败: ${error instanceof Error ? error.message : '未知错误'}`;
            success = false;
            await this.emitEvent(onMessage, { type: 'error', message: observation, timestamp: Date.now() });
          }
        }

        // 发出 tool_call_result 事件
        await this.emitEvent(onMessage, {
          type: 'tool_call_result',
          toolCallId,
          toolName: call.name,
          result: observation,
          success,
          duration: Date.now() - toolStartTime,
          timestamp: Date.now(),
        });

        // 添加工具结果到消息历史
        messages.push(new ToolMessage({
          tool_call_id: toolCallId,
          content: observation,
        }));
      }

      return { isFinalAnswer: false, content: accumulatedContent };
    } else {
      // 没有 tool_calls - 继续下一轮迭代
      return { isFinalAnswer: false, content: accumulatedContent };
    }
  }

  /**
   * 格式化工具描述
   */
  private formatToolDescriptions(tools: Tool[]): string {
    return tools.map(tool => {
      const schemaShape = tool.parameters.shape;
      const paramsDescription = Object.entries(schemaShape)
        .map(([key, schema]) => {
          const zodSchema = schema as { description?: string; _def?: { typeName: string } };
          const type = zodSchema._def?.typeName?.replace('Zod', '') || 'any';
          const desc = zodSchema.description || '';
          return `    - ${key} (${type}): ${desc}`;
        })
        .join('\n');

      return `- ${tool.name}: ${tool.description}\n  参数:\n${paramsDescription}`;
    }).join('\n\n');
  }

  /**
   * 发出事件
   */
  private async emitEvent(
    handler: ReActInput['onMessage'],
    event: ReActEvent
  ): Promise<void> {
    if (handler) {
      await handler(event);
    }
  }
}
