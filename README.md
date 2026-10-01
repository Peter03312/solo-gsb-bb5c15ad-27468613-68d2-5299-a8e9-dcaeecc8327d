# 彩绘玻璃工作室 · 网页拼片台

为彩绘玻璃工作室设计的网页拼片台：输入矩形窗框的正整数毫米宽高，在画布上以**整数毫米坐标**绘制带**编号与颜色**的简单多边形玻璃片；服务端精确校验每一次编辑，只有**完整覆盖窗框且无空隙**的草稿才能发布；发布时生成**铅条下料清单**（公共边只计一次，外框另列）。历史发布版不可变，随时查阅。

围绕**已发布图纸**还可安排铅条生产：登记原材定尺与库存根数，选择发布版本、制作件数、原材规格与每刀损耗，系统只取该版本铅条清单中的**内部公共边与四根外框**，逐件作为**不可拼接的切段**，按长度降序做首次适应装箱，输出每根原材的逐段切段、余料与需用根数；预览不占库存，确认时**原子预留**库存，并发确认也不会超卖。

## 功能一览

- **窗框建模**：宽、高为正整数毫米（1–100000）。
- **拼片绘制**：画布点击取点（自动吸附已有顶点/窗框角），双击或“闭合多边形”完成；也可直接输入 `x,y` 坐标。每片有独立编号与颜色。
- **编辑校验（拒绝并标出位置，图中红色 ✕ 标记）**：
  - 顶点必须是整数毫米，且在窗框内 —— 越界拒绝；
  - 必须是简单多边形：自交（边交叉/边重叠/非端点相触）、重复顶点、零边、相邻共线均拒绝；
  - 与现有拼片**面积重叠**拒绝（边交叉、顶点穿入、共边同侧重叠、顶点处内角相交）；
  - 允许合法相邻：共边共享、T 接、顶点相接；
  - **允许相邻片边界一侧是整边、另一侧为数段**。
- **覆盖检查与缺口可视化**：未发布前实时分析草稿，缺口区域以红色斜纹多边形标出并给出每块缺口面积；面积重叠以紫色标出。
- **发布**：仅当无缺口、无重叠、面积合计等于窗框面积时可发布，否则返回 422 并附带缺口数据。发布版带递增版本号，快照不可变。
- **发布图纸**：展示每片编号、颜色与面积（mm²），画布上直接标注编号与面积。
- **铅条下料清单**：
  - 内部公共边无论怎样分段都**合并为一根、只计一次**（T 接处直线继续则不断开）；
  - 外框四根（上/下/左/右）另列；
  - 每根长度、分类小计与总长都是**先求和再四舍五入至 0.01 mm**。
- **草稿/发布分离**：后续编辑、删除、改色与清单重算只作用于草稿；历史发布版通过版本下拉框查阅，内容永不变化。
- **铅条生产排产（围绕已发布图纸）**：
  - 登记**原材定尺**（精确到 0.01 mm 的正数长度）与**库存根数**（非负整数），定尺全局唯一，可补货（只增）；
  - 制作计划时选择**发布版本、件数（正整数）、原材规格、每刀损耗（≥0，0.01 mm 精度）**；
  - 切段只取该版本铅条清单中的**内部公共边与四根外框（上/下/左/右）**，按件数逐件复制，**每段不可拼接**；
  - 切段按**长度降序**排列、同长按清单顺序（同一条目再按件号），依次放入**第一根能容纳**它的原材（First-Fit Decreasing）；
  - 每段占用 = 成品长度 + **一刀损耗**；输出逐根原材上的切段顺序、成品/损耗/占用、**余料**与**需用根数**；
  - **预览不占库存**；单段（含损耗）超过定尺直接拒绝（422）；需用根数超过可用数时返回**缺口**，可存为草稿但**不能确认**；
  - 确认时在 SQLite 即时事务内**原子预留**库存；重复确认、重复取消都不会再次改变库存；多个计划并发确认也**不会超卖**；
  - 已确认计划**绑定发布快照**：草稿再编辑或发布新版本都不改变其用料；
  - 网页“铅条生产”标签页可登记原材、预览/制作计划、确认/取消，并查询计划与可用库存。

## 技术栈

- Node.js ≥ 20（CommonJS）
- Express 4（Web/API/静态资源）
- better-sqlite3（SQLite，同步事务）
- 原生 HTML/CSS/Canvas + 原生 JS（无前端构建步骤）
- 几何判定全部使用整数坐标的精确整数运算（叉积/射线法），交点以精确分数表示，避免浮点误差

## 快速启动

### 方式一：Docker Compose（推荐，一键启动并初始化数据库）

```bash
docker compose up -d --build
```

首次启动会自动构建镜像、安装依赖，并在容器内对 `/data/studio.db` 执行建表初始化
（`CREATE TABLE IF NOT EXISTS`），无需手动初始化。

浏览器打开：

```
http://localhost:3000
```

停止：

```bash
docker compose down          # 保留数据卷
docker compose down -v       # 同时删除数据库卷
```

### 方式二：本地 Node.js 运行

```bash
npm install
npm start
```

若 better-sqlite3 需要本地编译，请确保具备 Python 3、make、g++（Debian/Ubuntu：
`apt-get install -y python3 make g++`）。

浏览器同样打开 http://localhost:3000 。

运行几何算法测试：

```bash
npm test
```

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口 |
| `DB_PATH` | `data/studio.db`（本地）/ `/data/studio.db`（Docker） | SQLite 数据库文件路径；目录不存在会自动创建，首次启动自动建表 |

Compose 中通过命名卷 `studio-data` 持久化 `/data`；改宿主机端口只需修改
`docker-compose.yml` 的端口映射（如 `"8080:3000"`）。

## 网页地址与端口

- 应用首页：`http://localhost:3000/`
- 端口：`3000`（可用 `PORT` 环境变量或 compose 端口映射更改）

## HTTP API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/designs` | 图纸列表 |
| POST | `/api/designs` | 新建图纸 `{name,width,height}`（宽高正整数毫米） |
| GET | `/api/designs/:id` | 草稿完整汇总（片/面积/缺口/铅条清单） |
| POST | `/api/designs/:id/pieces` | 新增拼片 `{color,polygon:[[x,y],...]}` |
| PUT | `/api/designs/:id/pieces/:pieceId` | 编辑拼片（改色/改顶点） |
| DELETE | `/api/designs/:id/pieces/:pieceId` | 删除拼片（仅草稿） |
| POST | `/api/designs/:id/publish` | 发布（未完整覆盖返回 422 + 缺口数据） |
| GET | `/api/designs/:id/publications` | 发布版列表 |
| GET | `/api/designs/:id/publications/:version` | 查阅指定发布版（不可变快照） |
| GET | `/api/lead-materials` | 原材库存（定尺/库存/已预留/可用根数） |
| POST | `/api/lead-materials` | 登记原材定尺 `{length, stockCount}`（长度为正、≤2位小数；库存非负整数） |
| POST | `/api/lead-materials/:id/restock` | 补货 `{addCount}`（正整数，只增） |
| POST | `/api/lead-plans/preview` | 排产预览（不占库存），见下 |
| POST | `/api/lead-plans` | 制作计划（草稿，不占库存） |
| GET | `/api/lead-plans` | 全部生产计划 |
| GET | `/api/lead-plans/:id` | 计划详情（逐根切段/余料/库存视角） |
| POST | `/api/lead-plans/:id/confirm` | 确认并原子预留库存（库存不足返回 409 + `shortage`） |
| POST | `/api/lead-plans/:id/cancel` | 取消草稿（不改变库存；已确认不可取消） |

计划/预览请求体：

```json
{ "publicationId": 12, "materialId": 1, "copies": 3, "kerf": 2 }
```

校验规则与错误：

- 定尺与件数必须为正数（件数为正整数），库存根数与每刀损耗不得为负；
- 所有长度精度不得超过 0.01 mm（内部以百分之一毫米整数运算）；
- 非法输入返回 400 且**不改变库存**；单段（成品+一刀损耗）超过定尺返回 422
  （`category:"segment_too_long"`）；需用根数超过可用数时确认返回 409 并带
  `{needed, available, shortage}`；重复确认/取消返回 409 且不重复改变库存。

预览/计划结果关键字段：

```json
{
  "neededCount": 3, "availableCount": 5, "shortage": 0, "feasible": true,
  "segmentCount": 15,
  "totalProduct": 1140.00, "totalKerf": 30.00, "totalUsed": 1170.00,
  "bins": [
    { "no": 1, "used": 306.00, "remainder": 894.00,
      "cuts": [
        { "order": 1, "label": "外框·上框", "copyNo": 1, "kind": "frame",
          "ref": "上框", "from": [0,0], "to": [100,0],
          "length": 100.00, "kerf": 2.00, "occupied": 102.00 } ] }
  ]
}
```

- `bins[].no`：第几根原材；`cuts[]` 为该根上的切段顺序（已按长度降序放置）；
- `length` 为成品长度，`kerf` 为该段分摊的一刀损耗，`occupied = length + kerf`；
- `remainder` 为该根余料长度；`neededCount` 为需用根数。

### 调用示例（curl）

```bash
# 1) 登记 1800mm 定尺原材 10 根
curl -s -X POST http://localhost:3000/api/lead-materials \
  -H 'Content-Type: application/json' \
  -d '{"length":1800,"stockCount":10}'

# 2) 查询发布版，取 publicationId
curl -s http://localhost:3000/api/designs/1/publications

# 3) 预览：v 发布快照、3 件、1 号原材、每刀损耗 2mm（不占库存）
curl -s -X POST http://localhost:3000/api/lead-plans/preview \
  -H 'Content-Type: application/json' \
  -d '{"publicationId":12,"materialId":1,"copies":3,"kerf":2}'

# 4) 存为草稿计划
curl -s -X POST http://localhost:3000/api/lead-plans \
  -H 'Content-Type: application/json' \
  -d '{"publicationId":12,"materialId":1,"copies":3,"kerf":2}'

# 5) 确认（原子预留；不足时 409 返回 shortage 缺口根数）
curl -s -X POST http://localhost:3000/api/lead-plans/7/confirm

# 6) 查询计划与可用库存
curl -s http://localhost:3000/api/lead-plans
curl -s http://localhost:3000/api/lead-materials
```

校验失败统一返回：

```json
{ "ok": false, "error": "原因", "category": "invalid|out_of_frame|overlap|not_covered",
  "at": [x, y], "gaps": [ { "polygon": [[x,y],...], "area": 1234.5 } ] }
```

## 使用流程

1. 左侧“新建图纸”，输入名称与窗框宽高（正整数毫米）。
2. 选择颜色，在画布上依次点击顶点绘制多边形（可自动吸附），双击完成；或在文本框逐行输入 `x,y` 后点“闭合多边形”。
3. 若被拒绝，画布会用红色 ✕ 标出问题位置，顶部红条说明原因与坐标。
4. 重复绘制直到覆盖状态变为“✓ 完整覆盖，无空隙”；绘制过程中缺口实时以红色斜纹显示。
5. 点击“发布图纸”，得到新版本；切到“已发布图纸”标签，选择版本查阅图纸、面积明细与铅条下料清单。
6. 发布后仍可继续编辑草稿（产生新版本），旧版本内容保持不变。
7. 切到“**铅条生产**”标签：
   - 先“登记原材定尺”（如 1800 mm）与库存根数，后续可用 ➕ 补货；
   - 选择图纸与**已发布版本**，填件数、每刀损耗，选择原材规格，点“预览排产”查看每根切段与余料（不占库存）；
   - “存为草稿”后可在计划列表中 ✓ 确认（原子预留库存）或 ✕ 取消；
   - 需用根数超过可用数时会显示**缺口**且确认被拒，补货后即可确认。

## 目录结构

```
Dockerfile               容器镜像（含 better-sqlite3 编译环境）
docker-compose.yml       一键启动 + 数据卷持久化
src/
  server.js              Express 入口与 API
  db.js                  SQLite 初始化与数据访问（含原材/计划与原子预留事务）
  geometry.js            精确几何校验、覆盖/缺口分析、铅条合并
  cutting.js             铅条排产：0.01mm 整数运算、切段来源、First-Fit 装箱
public/
  index.html / style.css / app.js          单页前端（Canvas 编辑器/发布视图）
  production.js          铅条生产视图（原材/预览/计划/确认取消）
test/
  geometry.test.js       几何算法测试（node --test）
  cutting.test.js        排产算法测试（0.01mm 精度、排序、装箱、超长拒绝）
  api.test.js            HTTP API 集成测试（校验、库存、并发不超卖、快照绑定）
```
