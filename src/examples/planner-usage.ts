/**
 * 规划器用法示例 - PlannerExecutor
 * 
 * 本示例演示 Planner + ReAct 双循环架构：
 * 1. Planner 生成多步骤计划
 * 2. 每个步骤由 ReActExecutor 执行
 * 3. 基于结果的动态重规划
 */

import { z } from 'zod';
import { PlannerExecutor, type Tool, type ReActEvent, type Plan } from '../index.js';

// ============================================================================
// 为研究任务定义工具
// ============================================================================

/**
 * 网络搜索工具
 */
const searchTool: Tool = {
  name: 'search',
  description: '在网上搜索信息',
  parameters: z.object({
    query: z.string().describe('搜索查询'),
  }),
  execute: async (args) => {
    console.log(`    [搜索 API 调用: "${args.query}"]`);
    
    if (args.query.toLowerCase().includes('气候')) {
      return JSON.stringify([
        { title: '2024 气候变化报告', summary: '全球气温上升了 1.2°C...' },
        { title: '可再生能源趋势', summary: '太阳能和风能容量增长了 25%...' },
      ]);
    }
    
    return JSON.stringify([
      { title: `${args.query} 的结果`, summary: '示例搜索结果...' },
    ]);
  },
};

/**
 * 数据分析工具
 */
const analyzeTool: Tool = {
  name: 'analyze_data',
  description: '分析数据并提取洞察',
  parameters: z.object({
    data: z.string().describe('要分析的数据'),
    focusArea: z.string().optional().describe('要关注的特定领域'),
  }),
  execute: async (args) => {
    console.log(`    [分析数据，关注: "${args.focusArea || '通用'}"]`);
    return `分析完成。关键发现：数据显示 ${args.focusArea || '分析领域'} 存在显著趋势。主要洞察：1) 趋势 A 在增长，2) 因素 B 与 C 相关。`;
  },
};

/**
 * 摘要工具
 */
const summarizeTool: Tool = {
  name: 'summarize',
  description: '创建提供内容的简洁摘要',
  parameters: z.object({
    content: z.string().describe('要摘要的内容'),
    maxLength: z.number().optional().describe('摘要的最大字数'),
  }),
  execute: async (args) => {
    console.log(`    [摘要内容（最多 ${args.maxLength || 100} 字）]`);
    return `摘要: ${args.content.slice(0, 200)}... [已提取关键点]`;
  },
};

/**
 * 报告生成工具
 */
const reportTool: Tool = {
  name: 'generate_report',
  description: '从发现中生成格式化报告',
  parameters: z.object({
    title: z.string().describe('报告标题'),
    sections: z.array(z.object({
      heading: z.string(),
      content: z.string(),
    })).describe('报告章节'),
  }),
  execute: async (args) => {
    console.log(`    [生成报告: "${args.title}"]`);
    const report = `
# ${args.title}

${args.sections.map((s: { heading: string; content: string }) => `## ${s.heading}\n${s.content}`).join('\n\n')}
    `;
    return report.trim();
  },
};

// ============================================================================
// 事件处理器
// ============================================================================

function handleEvent(event: ReActEvent): void {
  switch (event.type) {
     case 'stream':
      // 流式输出：直接打印增量内容（不换行）
      if (event.isThought) {
        process.stdout.write(event.chunk);
      }
      break;
    case 'thought':
      console.log(`  💭 ${event.content}`);
      break;
    case 'action':
      console.log(`  🔧 使用工具: ${event.toolName}`);
      break;
    case 'observation':
      console.log(`  👁️ 结果: ${event.content.slice(0, 100)}...`);
      break;
    case 'final_answer':
      console.log(`  ✅ 步骤完成`);
      break;
    case 'error':
      console.error(`  ❌ 错误: ${event.message}`);
      break;
  }
}

function handlePlanUpdate(plan: Plan): void {
  console.log('\n📋 计划更新:');
  console.log(`   目标: ${plan.goal}`);
  console.log('   步骤:');
  plan.steps.forEach((step) => {
    const status = step.status === 'done' ? '✅' : 
                   step.status === 'in_progress' ? '🔄' : 
                   step.status === 'skipped' ? '⏭️' : '⏳';
    console.log(`   ${status} ${step.id}: ${step.description}`);
  });
  console.log('');
}

// ============================================================================
// 主执行
// ============================================================================

async function main() {
  console.log('='.repeat(60));
  console.log('Planner + ReAct - 双循环架构示例');
  console.log('='.repeat(60));

  const planner = new PlannerExecutor({
    provider:'tongyi',
    plannerModel: 'qwen-max',
    executorModel: 'qwen-max',
    maxIterationsPerStep: 5,
    maxRePlanAttempts: 2,
    apiKey: 'sk-2da524e57ee64485ab4208430ab35f4d',
  });

  const allTools = [searchTool, analyzeTool, summarizeTool, reportTool];

  try {
    console.log('\n🎯 开始复杂研究任务...\n');
    
    const result = await planner.run({
      goal: '研究最新的气候变化趋势，并创建一份包含关键发现的简要摘要报告',
      tools: allTools,
      onMessage: handleEvent,
      onPlanUpdate: handlePlanUpdate,
    });
  } catch (error) {
    console.error('规划器执行失败:', error);
  }
}

main().catch(console.error);
