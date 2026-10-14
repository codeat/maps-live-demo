// tests/smart_nav_test.js
const fs = require('fs');
const path = require('path');

const appCode = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf-8');

let activeDestination = "";
let selectedTravelMode = "";
let lastRecommendedDestination = "";
let dispatchState = { hasFc: false, fcArgs: "" };
let routePrepared = null;

function updateDispatchUI() {}
const $ = () => ({ textContent: "", classList: { remove() {}, add() {}, contains() { return false; } } });

function prepareRouteAndModeSelection(dest, mode) {
  activeDestination = dest;
  selectedTravelMode = mode;
  routePrepared = { dest, mode };
}

function remoteLog() {}

const sanMatch = appCode.match(/function sanitizeDestinationName\(name\) \{([\s\S]*?)\n\}/);
const sanitizeDestinationName = sanMatch ? new Function('name', sanMatch[1]) : (n) => String(n || '').trim();

const valMatch = appCode.match(/function isValidDestinationName\(dest\) \{([\s\S]*?)\n\}/);
if (!valMatch) throw new Error("isValidDestinationName not found in app.js");
const isValidDestinationName = (dest) => new Function('dest', 'sanitizeDestinationName', valMatch[1])(dest, sanitizeDestinationName);

const lmMatch = appCode.match(/const CANONICAL_LANDMARKS = (\[[\s\S]*?\n\];)/);
if (!lmMatch) throw new Error("CANONICAL_LANDMARKS not found in app.js");
const CANONICAL_LANDMARKS = eval(lmMatch[1]);

const funcMatch = appCode.match(/function checkAndTriggerSmartNavigation\(userText, modelText, gm, isFinal\) \{([\s\S]*?)\n  \}/);
if (!funcMatch) throw new Error("checkAndTriggerSmartNavigation not found in app.js");

const rawFunc = new Function(
  'userText', 'modelText', 'gm', 'isFinal',
  'CANONICAL_LANDMARKS', 'dispatchState', 'activeDestination', 'lastRecommendedDestination',
  'prepareRouteAndModeSelection', 'updateDispatchUI', '$', 'isValidDestinationName', 'remoteLog',
  `
  function extractRealtimeOptions(t) {
    if (t.includes("第一家是") && t.includes("第二家是")) return [{name:"A"},{name:"B"}];
    return [];
  }
  ` + funcMatch[1]
);

function runTest(u, m, gm, isFinal) {
  rawFunc(u, m, gm, isFinal, CANONICAL_LANDMARKS, dispatchState, activeDestination, lastRecommendedDestination, prepareRouteAndModeSelection, updateDispatchUI, $, isValidDestinationName, remoteLog);
  return { routePrepared, activeDestination, dispatchState, lastRecommendedDestination };
}

let passed = 0;
let failed = 0;

function assert(name, condition, details = "") {
  if (condition) {
    console.log(`PASS [${name}] ${details}`);
    passed++;
  } else {
    console.error(`FAIL [${name}] ${details}`);
    failed++;
  }
}

// Test 1: 用户核心水幕秀 Case
{
  activeDestination = "";
  selectedTravelMode = "";
  dispatchState = { hasFc: false, fcArgs: "" };
  routePrepared = null;

  const userQuery = "搜索一下滨海湾金沙今晚水幕灯光秀几点开始，并规划路线带我去最佳观赏点。";
  const modelReply = "滨海湾金沙的水幕灯光秀“幻彩生辉”今晚有两场，分别在晚上8点和9点开始。 最佳观赏点在金沙酒店门口的活动广场 (Event Plaza)，您可以近距离感受水幕投影和激光的震撼。 我现在就规划路线带您过去。 您是想开车、走路还是骑车去呢？";

  const res = runTest(userQuery, modelReply, null, false);

  assert(
    "水幕秀+规划路线 (流式阶段即时命中)",
    res.routePrepared && res.routePrepared.dest.includes("滨海湾金沙活动广场") && res.dispatchState.hasFc === true,
    `dest="${res.routePrepared && res.routePrepared.dest}" mode="${res.routePrepared && res.routePrepared.mode}"`
  );
}

// Test 2: 肉骨茶规划路线
{
  activeDestination = "";
  selectedTravelMode = "";
  dispatchState = { hasFc: false, fcArgs: "" };
  routePrepared = null;

  const userQuery = "搜索乌节路附近评价最高的新加坡地道肉骨茶名店，规划路线带我过去。";
  const modelReply = "为您规划前往乌节路附近评价最高的松发肉骨茶克拉码头总店，我现在为您规划路线带您过去。";

  const res = runTest(userQuery, modelReply, null, false);

  assert(
    "肉骨茶规划路线",
    res.routePrepared && res.routePrepared.dest.includes("松发肉骨茶"),
    `dest="${res.routePrepared && res.routePrepared.dest}"`
  );
}

// Test 3: 多轮代词消解 (用户说“导航过去”)
{
  activeDestination = "";
  selectedTravelMode = "";
  dispatchState = { hasFc: false, fcArgs: "" };
  routePrepared = null;
  lastRecommendedDestination = "滨海湾金沙活动广场 (Event Plaza · 水幕灯光秀最佳观赏点)";

  const userQuery = "导航过去";
  const modelReply = "好的，马上为您规划路线。";

  const res = runTest(userQuery, modelReply, null, false);

  assert(
    "多轮代词'导航过去'命中上下文",
    res.routePrepared && res.routePrepared.dest.includes("滨海湾金沙活动广场"),
    `dest="${res.routePrepared && res.routePrepared.dest}"`
  );
}

// Test 4: 负例 - 纯天气问答不误触发
{
  activeDestination = "";
  selectedTravelMode = "";
  dispatchState = { hasFc: false, fcArgs: "" };
  routePrepared = null;

  const userQuery = "今天新加坡天气怎么样？气温多高？";
  const modelReply = "今天新加坡天气晴朗，最高气温约32摄氏度，下午可能有局部短暂雷阵雨。";

  const res = runTest(userQuery, modelReply, null, false);

  assert(
    "纯天气资讯不误触发导航",
    res.routePrepared === null && res.dispatchState.hasFc === false,
    `routePrepared=${res.routePrepared}`
  );
}

// Test 5: 负例 - 推荐两个候选地点时不抢跑单选
{
  activeDestination = "";
  selectedTravelMode = "";
  dispatchState = { hasFc: false, fcArgs: "" };
  routePrepared = null;

  const userQuery = "推荐乌节路周边两家特色美食";
  const modelReply = "为您推荐两家：第一家是松发肉骨茶，第二家是天天海南鸡饭。您想去哪一家？";

  const res = runTest(userQuery, modelReply, null, false);

  assert(
    "多候选推荐不盲目抢跑单目的地",
    res.routePrepared === null && res.dispatchState.hasFc === false,
    `routePrepared=${res.routePrepared}`
  );
}

// Test 6: 复合提问多选推荐“推荐周边热门打卡景点并规划路线带我过去”不误抢跑上一轮目的地或单目的地
{
  activeDestination = "";
  selectedTravelMode = "";
  dispatchState = { hasFc: false, fcArgs: "" };
  routePrepared = null;
  lastRecommendedDestination = "滨海湾金沙活动广场 (上一轮遗留)";

  const userQuery = "推荐当前位置周边 10 公里内评分最高的热门打卡景点，并规划路线带我过去。";
  const modelReply = "为您推荐周边评分最高的两个热门打卡景点：一个是滨海湾花园，评分4.7；另一个是鱼尾狮公园，评分4.6。您想去哪一个？";

  const res = runTest(userQuery, modelReply, null, false);

  assert(
    "多候选景点推荐带规划路线不被误抢跑",
    res.routePrepared === null && res.dispatchState.hasFc === false,
    `routePrepared=${res.routePrepared}`
  );
}

// Test 7: 蜜雪冰城规划路线 (命中武吉士/城联广场近店而非 10km 郊区远店)
{
  activeDestination = "";
  selectedTravelMode = "";
  dispatchState = { hasFc: false, fcArgs: "" };
  routePrepared = null;

  const userQuery = "推荐乌节路附近的蜜雪冰城，规划路线带我过去。";
  const modelReply = "乌节路商圈内暂无直营分店，离您最近的是武吉士的蜜雪冰城 (MIXUE 武吉士店 Bugis Village)，车程约3.2公里。我现在就为您规划前往武吉士店。";

  const res = runTest(userQuery, modelReply, null, false);

  assert(
    "蜜雪冰城规划路线 (精准命中武吉士近店)",
    res.routePrepared && res.routePrepared.dest.includes("蜜雪冰城") && res.routePrepared.dest.includes("武吉士"),
    `dest="${res.routePrepared && res.routePrepared.dest}"`
  );
}

// Test 8: 精品咖啡真实提问 - 流式前几个字吐出“为您推荐两家”时，绝不误抢跑导航到“两家”
{
  activeDestination = "";
  selectedTravelMode = "";
  dispatchState = { hasFc: false, fcArgs: "" };
  routePrepared = null;

  const userQuery = "帮我找乌节路附近一家评价高的精品咖啡店，规划路线带我过去。";
  const streamingChunk = "为您推荐两家";

  const res = runTest(userQuery, streamingChunk, null, false);

  assert(
    "流式出现'为您推荐两家'时绝对不误触发'两家'导航",
    res.routePrepared === null && res.dispatchState.hasFc === false,
    `routePrepared=${res.routePrepared}`
  );
}

// Test 9: 精品咖啡真实提问 - 完整回复介绍两家咖啡店并询问“您想去哪一个”，等待用户选点，决不抢跑
{
  activeDestination = "";
  selectedTravelMode = "";
  dispatchState = { hasFc: false, fcArgs: "" };
  routePrepared = null;

  const userQuery = "帮我找乌节路附近一家评价高的精品咖啡店，规划路线带我过去。";
  const modelFull = "为您推荐两家乌节路附近评价很高的精品咖啡店：第一家是 Alchemist The Heeren，评分4.2，咖啡非常专业；第二家是 Kurasu Singapore \"The Stand\"，评分4.6，是来自京都的极简风咖啡。您想去哪一个？";

  const res = runTest(userQuery, modelFull, null, false);

  assert(
    "两家精品咖啡推荐全文本输出时绝不抢跑单目的地导航",
    res.routePrepared === null && res.dispatchState.hasFc === false,
    `routePrepared=${res.routePrepared}`
  );
}

// Test 10: isValidDestinationName 严格过滤量词与非实体
{
  assert("isValidDestinationName('两家') === false", isValidDestinationName("两家") === false);
  assert("isValidDestinationName('一家') === false", isValidDestinationName("一家") === false);
  assert("isValidDestinationName('几个') === false", isValidDestinationName("几个") === false);
  assert("isValidDestinationName('目的地') === false", isValidDestinationName("目的地") === false);
  assert("isValidDestinationName('上车点') === false", isValidDestinationName("上车点") === false);
  assert("isValidDestinationName('Alchemist The Heeren') === true", isValidDestinationName("Alchemist The Heeren") === true);
  assert("isValidDestinationName('滨海湾金沙') === true", isValidDestinationName("滨海湾金沙") === true);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
