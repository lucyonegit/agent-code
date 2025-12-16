/**
 * 基础用法示例 - ReActExecutor
 * 
 * 本示例演示：
 * 1. 使用 Zod schema 定义工具
 * 2. 创建和配置 ReActExecutor
 * 3. 执行过程中处理事件
 * 4. 运行简单查询
 */

import { z } from 'zod';
import { ReActExecutor, type Tool, type ReActEvent } from '../index.js';

// ============================================================================
// 步骤 1：定义工具
// ============================================================================

/**
 * 示例：天气工具
 * 返回模拟天气数据的模拟工具
 */
const weatherTool: Tool = {
  name: 'get_weather',
  description: '获取指定位置的当前天气信息',
  parameters: z.object({
    location: z.string().describe('要获取天气的城市或位置'),
    unit: z.enum(['celsius', 'fahrenheit']).optional().describe('温度单位，默认摄氏度'),
  }),
  execute: async (args) => {
    // 模拟天气数据 - 实际使用时替换为真实 API 调用
    const weatherData = {
      location: args.location,
      temperature: 25,
      unit: args.unit || 'celsius',
      condition: '晴天',
      humidity: 60,
    };
    return JSON.stringify(weatherData, null, 2);
  },
};

/**
 * 示例：计算器工具
 * 用于基本算术运算的简单计算器
 */
const calculatorTool: Tool = {
  name: 'calculator',
  description: '执行基本算术计算',
  parameters: z.object({
    expression: z.string().describe('要计算的数学表达式（例如 "2 + 2", "10 * 5"）'),
  }),
  execute: async (args) => {
    try {
      // 注意：生产环境中请使用专业的数学解析器而非 eval
      // 这里仅作演示用途
      const sanitized = args.expression.replace(/[^0-9+\-*/().%\s]/g, '');
      const result = Function(`"use strict"; return (${sanitized})`)();
      return `${args.expression} = ${result}`;
    } catch (error) {
      return `错误：无法计算 "${args.expression}"`;
    }
  },
};

/**
 * 示例：搜索工具
 * 返回模拟搜索结果的模拟工具
 */
const searchTool: Tool = {
  name: 'web_search',
  description: '在网上搜索指定主题的信息',
  parameters: z.object({
    query: z.string().describe('搜索查询'),
    maxResults: z.number().optional().describe('返回的最大结果数'),
  }),
  execute: async (args) => {
    // 模拟搜索结果
    const results = [
      { title: `"${args.query}" 的结果 1`, snippet: '这是一个示例搜索结果...' },
      { title: `"${args.query}" 的结果 2`, snippet: '另一个相关结果...' },
    ].slice(0, args.maxResults || 5);
    return JSON.stringify(results, null, 2);
  },
};

// ============================================================================
// 步骤 2：事件处理器
// ============================================================================

/**
 * 自定义事件处理器，用于显示执行进度
 * 支持流式输出和新事件格式
 */
function handleEvent(event: ReActEvent): void {
  switch (event.type) {
    case 'thought':
      // 新事件格式: 使用 chunk 字段
      if (event.chunk) {
        process.stdout.write(event.chunk);
      }
      if (event.isComplete) {
        console.log();  // 思考完成后换行
      }
      break;
    case 'tool_call':
      console.log(`\n🔧 工具调用: ${event.toolName}`);
      console.log('   参数:', JSON.stringify(event.args, null, 2));
      break;
    case 'tool_call_result':
      console.log(`\n👁️ 结果 [${event.success ? '成功' : '失败'}] (${event.duration}ms):`, event.result);
      break;
    case 'final_result':
      console.log('\n✅ 最终答案:', event.content);
      break;
    case 'error':
      console.error('\n❌ 错误:', event.message);
      break;
  }
}

// ============================================================================
// 步骤 3：运行 Agent
// ============================================================================

async function main() {
  console.log('='.repeat(60));
  console.log('ReAct Agent - 基础用法示例');
  console.log('='.repeat(60));

  // 创建执行器（启用流式输出）
  const executor = new ReActExecutor({
    provider: 'tongyi',
    model: 'qwen-max',
    maxIterations: 20,
    streaming: true,  // 启用流式输出
    apiKey: 'sk-2da524e57ee64485ab4208430ab35f4d',
  });

  // 示例 1：天气查询
  console.log('\n--- 示例 1：天气查询 ---');
  try {
    const result = await executor.run({
      input: '北京现在的天气怎么样？',
      tools: [weatherTool],
      onMessage: handleEvent,
    });
    console.log('\n📋 结果:', result);
  } catch (error) {
    console.error('执行失败:', error);
  }

  // 示例 2：多工具查询
  console.log('\n\n--- 示例 2：多工具查询 ---');
  try {
    const result = await executor.run({
      input: '搜索东京的人口，然后计算其 10% 是多少。',
      tools: [searchTool, calculatorTool],
      onMessage: handleEvent,
    });
    console.log('\n📋 结果:', result);
  } catch (error) {
    console.error('执行失败:', error);
  }
}

// 直接执行时运行
main().catch(console.error);
