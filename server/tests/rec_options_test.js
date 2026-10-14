#!/usr/bin/env node
// 推荐选项抽取引擎回归测试（无需浏览器）：从 static/app.js 中切出引擎与 sanitizeDisplayText，在 Node 里跑 41 组正负样例。
// 运行：node tests/rec_options_test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const src = fs.readFileSync(path.join(__dirname, "..", "static", "app.js"), "utf8");
const a = src.indexOf("// v78: 纯实时动态推荐选项抽取引擎 2.0");
const b = src.indexOf("// 绑定全新全屏语音助手交互");
const c = src.indexOf("function sanitizeDisplayText(raw)");
const d = src.indexOf("// 2. 大模型流式回复实时全端字字同屏广播");
if (a < 0 || b < 0 || c < 0 || d < 0) { console.error("engine markers not found in static/app.js"); process.exit(2); }
const ctx = { console, currentCity: { shortName: "新加坡" } };
vm.createContext(ctx);
vm.runInContext(src.slice(a, b) + "\n" + src.slice(c, d) + "\nthis.extractRealtimeOptions = extractRealtimeOptions; this.sanitizeDisplayText = sanitizeDisplayText;", ctx);
const { extractRealtimeOptions, sanitizeDisplayText } = ctx;
const cases = [
  ["用户实例(完整转写)", "为您推荐周边热门的打卡景点：第一家是滨海湾花园 (Gardens by the Bay)，评分4.7分，巨大的超级树和温室非常震撼；第二家是鱼尾狮公园 (Merlion Park)，评分4.6分，是新加坡的标志性打卡点。您想去哪一个，这就为您规划路线。 为您推荐周边10公里内评分", true, ["滨海湾花园","鱼尾狮公园"]],
  ["用户实例(流式半截·非final)", "为您推荐周边热门的打卡景点：第一家是滨海湾花园 (Gardens by the Bay)，评分4.7分，巨大的超级树和温室非常震撼；第二家是鱼尾狮公", false, []],
  ["用户实例(流式已到逗号·非final)", "第一家是滨海湾花园 (Gardens by the Bay)，评分4.7分；第二家是鱼尾狮公园 (Merlion Park)，", false, ["滨海湾花园","鱼尾狮公园"]],
  ["一个是/另一个是", "附近有两个不错的选择，一个是滨海湾花园，另一个是鱼尾狮公园。您想去哪个？", true, ["滨海湾花园","鱼尾狮公园"]],
  ["首先/其次/最后", "首先是滨海湾花园，其次是鱼尾狮公园，最后是圣淘沙名胜世界。", true, ["滨海湾花园","鱼尾狮公园","圣淘沙名胜世界"]],
  ["一是/二是/三是", "一是外滩，二是豫园，三是东方明珠。", true, ["外滩","豫园","东方明珠"]],
  ["显式标记", "两家都很棒。【推荐选项：滨海湾花园 | 鱼尾狮公园】", true, ["滨海湾花园","鱼尾狮公园"]],
  ["标记ASR变体-顿号", "两家都很棒。推荐选项：滨海湾花园、鱼尾狮公园。您想去哪一个？", true, ["滨海湾花园","鱼尾狮公园"]],
  ["标记ASR变体-逗号", "推荐选项，滨海湾花园，鱼尾狮公园，您想去哪一个", true, ["滨海湾花园","鱼尾狮公园"]],
  ["标记流式未闭合(非final)", "两家都很棒。【推荐选项：滨海湾花园 | 鱼尾", false, []],
  ["数字编号", "为您找到：1. 滨海湾花园 2. 鱼尾狮公园 3. 新加坡摩天观景轮", true, ["滨海湾花园","鱼尾狮公园","新加坡摩天观景轮"]],
  ["数字编号-小数不误判", "1.5公里外有滨海湾花园，2.3公里外有鱼尾狮公园。", true, []],
  ["A还是B疑问", "您想去滨海湾花园还是鱼尾狮公园？", true, ["滨海湾花园","鱼尾狮公园"]],
  ["包括A和B", "附近评分最高的包括滨海湾花园和鱼尾狮公园，两家都很不错。", true, ["滨海湾花园","鱼尾狮公园"]],
  ["分别是双语", "分别是滨海湾花园 (Gardens by the Bay) 和鱼尾狮公园 (Merlion Park)。", true, ["滨海湾花园","鱼尾狮公园"]],
  ["推荐你试试A或B(旧规则3)", "我推荐你试试亚坤咖椰吐司或者松发肉骨茶，都很地道。", true, ["亚坤咖椰吐司","松发肉骨茶"]],
  ["景点有A、B和C", "热门的打卡景点有滨海湾花园、鱼尾狮公园和圣淘沙。", true, ["滨海湾花园","鱼尾狮公园","圣淘沙"]],
  ["英文名含空格", "推荐两家咖啡馆：第一家是 Common Man Coffee Roasters，第二家是 Chye Seng Huat Hardware。", true, ["Common Man Coffee Roasters","Chye Seng Huat Hardware"]],
  ["如家不被误剥", "推荐如家酒店或者汉庭酒店，都在附近。", true, ["如家酒店","汉庭酒店"]],
  ["第一个推荐是", "第一个推荐是东京塔，第二个是浅草寺。", true, ["东京塔","浅草寺"]],
  ["您可以去A或者B", "您可以去滨海湾花园或者鱼尾狮公园，都很不错。", true, ["滨海湾花园","鱼尾狮公园"]],
  ["城市前缀剥离(仅“的”)", "第一家是新加坡的滨海湾花园，第二家是新加坡鱼尾狮公园。", true, ["滨海湾花园","新加坡鱼尾狮公园"]],
  ["英文成对", "I'd recommend Gardens by the Bay or Merlion Park. Both are great.", true, ["Gardens by the Bay","Merlion Park"]],
  ["英文序数", "First, Gardens by the Bay. Second, Merlion Park.", true, ["Gardens by the Bay","Merlion Park"]],
  ["第一站冒号", "第一站：滨海湾花园；第二站：鱼尾狮公园。", true, ["滨海湾花园","鱼尾狮公园"]],
  ["首先逗号", "首先，滨海湾花园很值得去；其次，鱼尾狮公园也不错。", true, ["滨海湾花园","鱼尾狮公园"]],
  ["负例-步骤说明", "第一步是打开设置，第二步是点击确认。", true, []],
  ["负例-列举理由", "推荐理由有两个：一是离得近，二是评分高。", true, []],
  ["三选一双语", "为您推荐三处：第一处是滨海湾金沙 (Marina Bay Sands)，第二处是新加坡摩天观景轮 (Singapore Flyer)，第三处是克拉码头 (Clarke Quay)。", true, ["滨海湾金沙","新加坡摩天观景轮","克拉码头"]],
  ["The Bund 不被剥", "推荐外滩 (The Bund) 或者豫园 (Yu Garden)。", true, ["外滩","豫园"]],
  ["评分粘连无逗号", "第一家是滨海湾花园评分4.7分，第二家是鱼尾狮公园评分4.6分。", true, ["滨海湾花园","鱼尾狮公园"]],
  ["负例-单地点", "为您推荐滨海湾花园，评分4.7分。要现在导航过去吗？", true, []],
  ["负例-描述性和", "滨海湾花园非常值得一去，最震撼的是超级树和云雾林。", true, []],
  ["负例-天气", "今天天气不错，气温28度和湿度80%，适合出门。", true, []],
  ["负例-闲聊", "哈哈，这个问题很有意思。我觉得第一是要开心，第二是要健康。", true, []],
  ["负例-导航播报", "好的，已为您规划前往滨海湾花园的路线，全程约5公里，开车大约12分钟。", true, []],
  ["grounding对齐", "第一家是滨海湾花园，第二家是鱼尾狮公园。", true, ["滨海湾花园","鱼尾狮公园"], {groundingChunks:[{maps:{title:"Gardens by the Bay"}},{maps:{title:"Merlion Park"}},{maps:{title:"Marina Bay Sands"}}]}],
  ["grounding兜底(文本无规则)", "这两个地方都很推荐哦。", true, ["Gardens by the Bay","Merlion Park"], {groundingChunks:[{maps:{title:"Gardens by the Bay"}},{maps:{title:"Merlion Park"}}]}],
  ["其一其二", "其一是克拉码头，其二是牛车水。", true, ["克拉码头","牛车水"]],
  ["中文顿号编号", "一、滨海湾花园 二、鱼尾狮公园", true, ["滨海湾花园","鱼尾狮公园"]],
  ["已打断尾巴", "第一家是滨海湾花园，第二家是鱼尾狮公园（已打断）", true, ["滨海湾花园","鱼尾狮公园"]],
  ["负例-流式半截咖啡描述", "第一家是 Alchemist，特色是提供高品质的单品咖啡和意式咖啡", false, []],
  ["负例-终态纯饮品词描述", "这家店特色是提供高品质的单品咖啡和意式咖啡。", true, []],
];
let pass = 0, fail = 0;
for (const [label, text, isFinal, expect, gm] of cases) {
  const got = extractRealtimeOptions(text, gm || null, { final: isFinal });
  const names = got.map(o => o.name);
  const ok = JSON.stringify(names) === JSON.stringify(expect);
  if (ok) pass++; else fail++;
  console.log((ok ? "PASS" : "FAIL") + " [" + label + "] rule=" + (got.__rule || "-") + " => " + JSON.stringify(names) + (ok ? "" : "  expected " + JSON.stringify(expect)));
  if (ok && got.length) console.log("       dest=" + JSON.stringify(got.map(o => o.destination)) + " icons=" + got.map(o=>o.icon).join(""));
}
const sanCases = [
  ["两家都很棒。您想去哪一个？【推荐选项：滨海湾花园 | 鱼尾狮公园】", "两家都很棒。您想去哪一个？"],
  ["两家都很棒。您想去哪一个？推荐选项：滨海湾花园、鱼尾狮公园。", "两家都很棒。您想去哪一个？"],
  ["您想去哪一个？【推荐选", "您想去哪一个？"],
  ["您想去哪一个？【推荐选项：滨海湾花", "您想去哪一个？"],
  ["这里的推荐选项很多，比如滨海湾花园。", "这里的推荐选项很多，比如滨海湾花园。"],
];
for (const [inp, exp] of sanCases) {
  const got = sanitizeDisplayText(inp);
  const ok = got === exp; if (ok) pass++; else fail++;
  console.log((ok ? "PASS" : "FAIL") + " [sanitize] " + JSON.stringify(inp) + " -> " + JSON.stringify(got) + (ok ? "" : "  expected " + JSON.stringify(exp)));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
