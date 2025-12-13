/**
 * ReActExecutor - 核心 ReAct（推理 + 行动）循环引擎
 * 
 * 关键特性：
 * - 业务无关：只处理循环控制，不涉及工具实现
 * - 动态工具注入：工具作为参数传入
 * - 事件驱动：通过 onMessage 回调进行通信
 * - 干净的流式输出：thought 通过 content 流式输出，action 通过 tool_calls 累积
 * - 多模型支持：支持 OpenAI、通义千问和 OpenAI 兼容端点
 */

import { ChatOpenAI } from '@langchain/openai';
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
 * ReAct agent 的默认系统提示词
 * 设计为让 LLM 在 content 中输出思考，在 tool_call 中输出动作
 */
const DEFAULT_SYSTEM_PROMPT = `你是一个有帮助的 AI 助手，使用 ReAct（推理 + 行动）方法来解决问题。

工作流程：
1. 首先，在回复内容中写下你的思考过程（这部分会流式输出给用户）
2. 然后，如果需要使用工具，调用相应的工具
3. 如果你已经有了最终答案，直接在回复内容中给出，不需要调用工具

重要提示：
- 先思考，后行动
- 思考过程写在回复内容中
- 使用工具时调用相应的 function
- 最终答案直接写在回复内容中，不需要调用任何工具`;

/**
 * ReActExecutor - 核心 ReAct 循环引擎
 * 
 * @example
 * ```typescript
 * const executor = new ReActExecutor({
 *   model: 'qwen-plus',
 *   provider: 'tongyi',
 *   streaming: true,
 *   apiKey: process.env.DASHSCOPE_API_KEY
 * });
 * 
 * const result = await executor.run({
 *   input: '北京现在的天气怎么样？',
 *   tools: [weatherTool],
 *   onMessage: (event) => {
 *     if (event.type === 'stream') {
 *       process.stdout.write(event.chunk);
 *     }
 *   }
 * });
 * ```
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
  };

  constructor(config: ReActConfig) {
    this.config = {
      model: config.model,
      provider: config.provider ?? 'openai',
      maxIterations: config.maxIterations ?? 10,
      systemPrompt: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      temperature: config.temperature ?? 0,
      streaming: config.streaming ?? false,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    };
  }

  /**
   * 执行 ReAct 循环
   */
  async run(input: ReActInput): Promise<string> {
    const { input: userInput, context, tools, onMessage } = input;
    
    // 创建 LLM 实例
    const llm = this.createLLM();
    
    // 转换为 LangChain 工具格式并绑定
    const langChainTools = toolsToLangChain(tools);
    const llmWithTools = llm.bindTools(langChainTools, {
      tool_choice: 'auto',  // 让 LLM 自己决定是否使用工具
    });

    // 构建提示词的工具描述
    const toolDescriptions = this.formatToolDescriptions(tools);
    
    // 初始化对话历史
    const messages: BaseMessage[] = [
      new SystemMessage(this.config.systemPrompt),
    ];

    // 构建初始用户消息
    let userMessage = `任务: ${userInput}\n\n可用工具:\n${toolDescriptions}`;
    if (context) {
      userMessage = `之前步骤的上下文:\n${context}\n\n${userMessage}`;
    }
    messages.push(new HumanMessage(userMessage));

    // 跟踪迭代历史
    const iterationHistory: string[] = [];

    // 主 ReAct 循环
    for (let iteration = 1; iteration <= this.config.maxIterations; iteration++) {
      // 为本次迭代生成唯一的 thoughtId
      const iterationId = `thought_${Date.now()}_${iteration}`;
      
      try {
        if (this.config.streaming) {
          // === 流式模式 ===
          const result = await this.streamIteration(llmWithTools, messages, tools, onMessage, iterationId);
          
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
              content,
            });
          }
          
          messages.push(response);
          
          // 检查是否有工具调用
          if (response.tool_calls && response.tool_calls.length > 0) {
            for (const call of response.tool_calls) {
              await this.emitEvent(onMessage, {
                type: 'action',
                toolName: call.name,
                args: call.args,
              });
              
              // 执行工具
              const tool = tools.find(t => t.name === call.name);
              let observation: string;
              
              if (!tool) {
                observation = `工具 "${call.name}" 未找到`;
                await this.emitEvent(onMessage, { type: 'error', message: observation });
              } else {
                try {
                  observation = await tool.execute(call.args);
                } catch (error) {
                  observation = `工具执行失败: ${error instanceof Error ? error.message : '未知错误'}`;
                  await this.emitEvent(onMessage, { type: 'error', message: observation });
                }
              }
              
              await this.emitEvent(onMessage, { type: 'observation', content: observation });
              
              messages.push(new ToolMessage({
                tool_call_id: call.id || 'call_id',
                content: observation,
              }));
              
              iterationHistory.push(`动作: ${call.name}\n观察: ${observation}`);
            }
          } else {
            // 没有工具调用 = 最终答案
            await this.emitEvent(onMessage, {
              type: 'final_answer',
              content,
            });
            return content;
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : '未知错误';
        await this.emitEvent(onMessage, {
          type: 'error',
          message: `第 ${iteration} 次迭代失败: ${errorMessage}`,
        });
        messages.push(new HumanMessage(`发生错误: ${errorMessage}\n请继续尝试。`));
      }
    }

    // 达到最大迭代次数
    const fallbackAnswer = `已达到最大迭代次数 (${this.config.maxIterations})。\n\n${iterationHistory.join('\n\n')}`;
    await this.emitEvent(onMessage, { type: 'final_answer', content: fallbackAnswer });
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
    iterationId: string  // 每次迭代的唯一 ID
  ): Promise<{ isFinalAnswer: boolean; content: string }> {
    const stream = await llm.stream(messages);

    // 累积内容和工具调用
    let accumulatedContent = '';
    let accumulatedToolCalls: AccumulatedToolCall[] = [];

    // === 流式处理循环 ===
    for await (const chunk of stream) {
      // Phase 1: Thought 流式输出
      // content 部分 = 思考过程
      if (chunk.content) {
        const text = typeof chunk.content === 'string' ? chunk.content : '';
        if (text) {
          accumulatedContent += text;
          // 实时推送 thought，附带 thoughtId
          await this.emitEvent(onMessage, {
            type: 'stream',
            thoughtId: iterationId,
            chunk: text,
            isThought: true,
          });
        }
      }

      // Phase 2: Action 累积
      // tool_call_chunks 部分 = 动作信息（分片到达）
      if (chunk.tool_call_chunks && chunk.tool_call_chunks.length > 0) {
        accumulatedToolCalls = mergeToolCalls(
          accumulatedToolCalls,
          chunk.tool_call_chunks as ToolCallChunk[]
        );
      }
    }

    // === 流结束后处理 ===
    
    // 发出完整的 thought 事件
    if (accumulatedContent) {
      await this.emitEvent(onMessage, {
        type: 'thought',
        content: accumulatedContent,
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
      for (const call of toolCalls) {
        // 发出 action 事件
        await this.emitEvent(onMessage, {
          type: 'action',
          toolName: call.name,
          args: call.args,
        });

        // 执行工具
        const tool = tools.find(t => t.name === call.name);
        let observation: string;

        if (!tool) {
          observation = `工具 "${call.name}" 未找到。可用工具: ${tools.map(t => t.name).join(', ')}`;
          await this.emitEvent(onMessage, { type: 'error', message: observation });
        } else {
          try {
            observation = await tool.execute(call.args);
          } catch (error) {
            observation = `工具执行失败: ${error instanceof Error ? error.message : '未知错误'}`;
            await this.emitEvent(onMessage, { type: 'error', message: observation });
          }
        }

        // 发出 observation 事件
        await this.emitEvent(onMessage, {
          type: 'observation',
          content: observation,
        });

        // 添加工具结果到消息历史
        messages.push(new ToolMessage({
          tool_call_id: call.id,
          content: observation,
        }));
      }

      return { isFinalAnswer: false, content: accumulatedContent };
    } else {
      // 没有 tool_calls = 最终答案
      await this.emitEvent(onMessage, {
        type: 'final_answer',
        content: accumulatedContent,
      });
      return { isFinalAnswer: true, content: accumulatedContent };
    }
  }

  /**
   * 创建 LLM 实例
   */
  private createLLM(): ChatOpenAI {
    const baseConfig = {
      model: this.config.model,
      temperature: this.config.temperature,
      apiKey: this.config.apiKey,
      streaming: this.config.streaming,
    };

    switch (this.config.provider) {
      case 'tongyi':
        return new ChatOpenAI({
          ...baseConfig,
          configuration: {
            baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          },
        });
      
      case 'openai-compatible':
        return new ChatOpenAI({
          ...baseConfig,
          configuration: {
            baseURL: this.config.baseUrl,
          },
        });
      
      case 'openai':
      default:
        return new ChatOpenAI(baseConfig);
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
