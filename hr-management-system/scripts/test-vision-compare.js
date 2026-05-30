#!/usr/bin/env node
/**
 * 视觉模型对比测试：Qwen2-VL vs 豆包
 * 用法：
 *   DASHSCOPE_API_KEY=sk-xxx node scripts/test-vision-compare.js <图片路径或URL> <prompt类型>
 *
 * prompt类型：
 *   closing   收档报告
 *   delivery  外卖日报
 *
 * 示例：
 *   DASHSCOPE_API_KEY=sk-xxx node scripts/test-vision-compare.js ./test.jpg closing
 *   DASHSCOPE_API_KEY=sk-xxx node scripts/test-vision-compare.js https://example.com/img.jpg delivery
 */

import fs from 'fs';
import path from 'path';
import https from 'https';

const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;
const [,, imagePath, promptType = 'closing'] = process.argv;

if (!DASHSCOPE_API_KEY) {
  console.error('缺少 DASHSCOPE_API_KEY 环境变量');
  process.exit(1);
}
if (!imagePath) {
  console.error('用法：DASHSCOPE_API_KEY=sk-xxx node scripts/test-vision-compare.js <图片路径或URL> [closing|delivery]');
  process.exit(1);
}

const PROMPTS = {
  closing: `你是一位拥有"鹰眼"视觉的食药监与消防安全审计员。
你的任务是执行【收档合规性检查】。
你的判罚原则是"视觉定罪"——只有在画面中清晰、无歧义地看到定义的违规现象时，才认定为【违规】。对于模糊不清或存在遮挡的区域，绝不扣分，但必须触发【安全预警】。

Logic (判罚逻辑)
 * 基准分：10 分。
 * 违规（扣分项）：命中【Part 1】清单 -> 每一处违规扣 2 分（最低扣至 0 分）。
 * 预警（风险项）：命中【Part 2】清单 -> 不扣分，但必须列出并高亮提示。

Part 1: 【违规清单】
A. 卫生与食品安全
 * 所有设备表面有污渍油渍等不清洁的地方
 * 地面台面的物品摆放不整齐不整洁，看上去凌乱
 * 地面/台面积水：地面或操作台有明显水坑、液体汇聚（排除反光）。
 * 固体废弃物：可见纸团、牙签、残渣、烟头、陈旧油垢。
 * 食品裸露：熟食或原料容器（盆/碗）未加盖、未覆膜，直接暴露。
 * 交叉污染：私人物品（手机、钥匙、水杯）放在食品操作台上。
B. 5S整洁与消防
 * 工具未归位：抹布乱放（未折叠/悬挂）；拖把扫把横躺或随意靠墙。
 * 通道堵塞：过道堆放杂物（纸箱/筐），阻碍通行。
 * 物品摆放凌乱：瓶罐、设备东倒西歪，极度无序。
C. 能源浪费
 * 设备未关：收银机、电子秤、打印机屏幕亮着（排除电源指示小红灯；排除电箱）。

Part 2: 【预警清单】
 * 电箱/配电盘：只要出现在图中，且无法100%确认开关全关。
 * 燃气阀/管道：只要出现在图中，且无法100%确认手柄垂直关闭。
 * 设施破损：插座碎裂、电线裸露乱接。

Output格式（严格遵守）：
第一行状态栏（仅选一个）：
 * 若有任何Part2预警：⚠️ 严重警告 (存在高危隐患)
 * 若无预警且得分<6：🔴 不合格 (严重违规)
 * 若无预警且得分6-8：🟡 待改进
 * 若无预警且得分10：🟢 完美收档

收档评分：[最终得分]/10
简明评论：[一句话总结]
检查详情：
 * ❌ 违规：[具体描述]
 * ⚠️ 预警：[具体描述]`,

  delivery: `# Role
你是一位严格的餐厅外卖出品质检员。请对这张外卖图片进行视觉评估。

# Evaluation Criteria
1. 摆盘 (10分制)：重点看是否居中、干净、无洒漏、分量充实。
2. 食欲 (10分制)：重点看颜色光泽、食材新鲜度、不油腻。

# Output格式（严格遵守，只输出一行）：
摆盘X分，理由：xxx；食欲X分，理由：xxx

理由必须控制在10个字以内，不要任何其他输出。`
};

async function imageToBase64(filePath) {
  if (filePath.startsWith('http')) {
    return new Promise((resolve, reject) => {
      https.get(filePath, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const ext = filePath.split('.').pop().split('?')[0].toLowerCase();
          const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
          resolve(`data:${mime};base64,${buf.toString('base64')}`);
        });
        res.on('error', reject);
      });
    });
  }
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function callQwen(imageData, prompt) {
  const body = JSON.stringify({
    model: 'qwen-vl-max',
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: imageData } },
        { type: 'text', text: prompt }
      ]
    }]
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'dashscope.aliyuncs.com',
      path: '/compatible-mode/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.choices?.[0]?.message?.content || JSON.stringify(json));
        } catch (e) { resolve(data); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const prompt = PROMPTS[promptType];
  if (!prompt) {
    console.error(`未知 prompt 类型：${promptType}，可选：closing / delivery`);
    process.exit(1);
  }

  console.log(`\n📸 图片：${imagePath}`);
  console.log(`📋 类型：${promptType === 'closing' ? '收档报告' : '外卖日报'}`);
  console.log('─'.repeat(60));

  console.log('\n⏳ 调用 Qwen-VL-Max...\n');
  const t0 = Date.now();

  let imageData;
  try {
    imageData = await imageToBase64(imagePath);
  } catch (e) {
    console.error('图片加载失败：', e.message);
    process.exit(1);
  }

  const result = await callQwen(imageData, prompt);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log('【Qwen-VL-Max 结果】');
  console.log('─'.repeat(60));
  console.log(result);
  console.log('─'.repeat(60));
  console.log(`\n⏱ 耗时：${elapsed}s`);
  console.log('\n💡 与豆包对比：把同一张图片在飞书AI字段里跑一遍，对比输出结果');
}

main().catch(e => { console.error(e); process.exit(1); });
