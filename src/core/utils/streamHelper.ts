/**
 * 流式工具调用合并辅助函数
 * 
 * 用于合并 LangChain 流式返回的 tool_call_chunks 片段
 */

/**
 * LangChain tool_call_chunk 类型
 * 来自 @langchain/core/messages
 */
export interface ToolCallChunk {
  index?: number;
  id?: string;
  name?: string;
  args?: string;
  type?: string;
}

/**
 * 累积的工具调用类型
 */
export interface AccumulatedToolCall {
  index: number;
  id: string;
  name: string;
  args: string;  // 累积的 JSON 字符串
}

/**
 * 合并流式返回的 tool_call_chunks 片段
 * 
 * LangChain 流式返回时，tool_call_chunks 会分多个 chunk 返回：
 * - 第一个 chunk 可能包含 id, name
 * - 后续 chunks 包含 args 的增量片段
 * 
 * @param accumulated - 当前累积的 tool_calls 数组
 * @param chunks - 新的 tool_call_chunk 增量片段
 * @returns 合并后的 tool_calls 数组
 */
export function mergeToolCalls(
  accumulated: AccumulatedToolCall[],
  chunks: ToolCallChunk[]
): AccumulatedToolCall[] {
  for (const chunk of chunks) {
    const index = chunk.index ?? 0;
    
    // 查找或创建对应索引的 tool_call
    let toolCall = accumulated.find(tc => tc.index === index);
    
    if (!toolCall) {
      // 新的 tool_call，初始化
      toolCall = {
        index,
        id: chunk.id || '',
        name: chunk.name || '',
        args: chunk.args || '',
      };
      accumulated.push(toolCall);
    } else {
      // 已存在的 tool_call，合并增量
      if (chunk.id) toolCall.id = chunk.id;
      if (chunk.name) toolCall.name = chunk.name;
      if (chunk.args) toolCall.args += chunk.args;
    }
  }
  
  return accumulated;
}

/**
 * 将累积的 tool_calls 转换为 LangChain 格式
 */
export function toLangChainToolCalls(accumulated: AccumulatedToolCall[]): Array<{
  id: string;
  name: string;
  args: Record<string, any>;
}> {
  return accumulated
    .filter(tc => tc.name)  // 过滤掉没有 name 的
    .map(tc => {
      let args: Record<string, any> = {};
      try {
        if (tc.args) {
          args = JSON.parse(tc.args);
        }
      } catch (e) {
        console.error('Tool call arguments parse error:', tc.args);
      }
      return {
        id: tc.id || `call_${tc.index}`,
        name: tc.name,
        args,
      };
    });
}
