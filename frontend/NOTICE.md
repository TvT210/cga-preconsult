# NOTICE — 第三方组件与开源署名

本项目（老年人就医预问诊与老年综合评估系统 · 前端）在医护端重做过程中，
使用了以下开源项目的代码或运行时依赖。按各自许可证要求在此署名。

---

## 1. shadcn/ui

- **来源**：https://github.com/shadcn-ui/ui
- **许可证**：MIT License
- **版权**：Copyright (c) 2023 shadcn (https://ui.shadcn.com)
- **使用方式**：**复制组件源码**进本仓库（`frontend/src/components/ui/`），
  非 npm 依赖。每个组件文件头部保留一行来源与许可注释。
- **已复制组件**：`button`、`card`、`badge`、`table`、`input`、`label`、`select`、
  `tabs`、`separator`、`dropdown-menu`、`dialog`、`tooltip`、`scroll-area`、
  `skeleton`、`switch`。
- **本地改动**：按 `docs/frontend/医护端视觉规范.md` 调整颜色为 Slate 中性 +
  teal 强调（`clin.*` token），调整圆角（8px / 6px）、字号（12~18px）与边框；
  移除 shadcn 默认的 primary 蓝色与 `tailwindcss-animate` 相关动画类。
  **组件 API（`variant` / `size` 等）保持与 shadcn 一致**，便于后续统一调整。

### 随附的 Radix UI primitives（npm 依赖，MIT License）

- https://github.com/radix-ui/primitives — MIT License
  `react-dialog`、`react-dropdown-menu`、`react-label`、`react-popover`、
  `react-scroll-area`、`react-select`、`react-separator`、`react-slot`、
  `react-switch`、`react-tabs`、`react-tooltip`

### 随附的样式工具（npm 依赖）

- `class-variance-authority` — Apache-2.0 License — https://github.com/joe-bell/cva
- `clsx` — MIT License — https://github.com/lukeed/clsx
- `tailwind-merge` — MIT License — https://github.com/dcastil/tailwind-merge
- `lucide-react` — ISC License — https://github.com/lucide-icons/lucide

---

## 2. 知识库图谱

### 2.1 react-force-graph-3d + three.js（3D 图谱，主视图）

- **来源**：https://github.com/vasturiano/react-force-graph
- **版本**：v1.29.2（`react-force-graph-3d`）
- **许可证**：MIT License
- **版权**：Copyright (c) 2019 Vasco Asturiano
- **使用方式**：npm 依赖，用于 `/staff/knowledge` 的 **3D 关系图**：
  左键拖拽任意角度旋转、滚轮缩放、右键平移；随缩放分三档展示
  （远景常见病种 → 中景加量表与高连接症状 → 近景全部节点）；
  中文标签为 **DOM 覆盖层**，按「距相机由近到远」贪心占位、屏幕矩形重叠即隐藏，
  实现「前面的节点带中文、后面的隐藏」。
- **随附依赖**：`three`（MIT · v0.187.0）、`3d-force-graph`（MIT · v1.80.1）、
  `d3-force-3d`（MIT）、`three-forcegraph`（MIT）、`three-render-objects`（MIT）。

### 2.2 cytoscape.js（平面图谱，备选视图）

- **来源**：https://github.com/cytoscape/cytoscape.js
- **版本**：v3.34.4
- **许可证**：MIT License
- **版权**：Copyright (c) 2016-2023 The Cytoscape Consortium
- **使用方式**：npm 依赖，用于同一页面的「平面图谱」视图（2D 精确读关系）。
  布局「一次执行、跑完即静止」，节点位置由用户掌控（可拖拽、可切换布局），
  不存在「引擎冷却结束后自动重排、视图突然变形」的问题。

### 2.3 cytoscape-fcose（平面图谱的力导向布局扩展）

- **来源**：https://github.com/cytoscape/cytoscape-fcose
- **版本**：v2.2.0 · MIT License

> 换型过程留痕：最初采用 `react-force-graph-2d`（MIT），因「引擎结束后视图自动变形 +
> 节点不可拖拽 + 无法切换布局」而更换为 cytoscape.js；后按需求追加 3D 视图，
> 主视图改为 `react-force-graph-3d`。
> 完整复盘见 `docs/research/2026-11-04-知识库可视化开源方案选型.md`。

---

## 3. recharts（图表与矩阵降级视图）

- **来源**：https://github.com/recharts/recharts
- **许可证**：MIT License
- **版权**：Copyright (c) 2015-2023 recharts contributors
- **使用方式**：npm 依赖，用于质控看板图表，以及知识库图谱不可用时的
  「症状 × 疾病」矩阵热力图降级视图。

---

## 4. 明确未使用 / 明确排除的项目

调研阶段曾评估但**未**采纳以下项目，原因如下，特此记录以免误解：

- **Dify / FastGPT**：许可证为 NOASSERTION，含禁止未授权多租户与禁止移除 LOGO 条款，
  不适合本项目。
- **MaxKB / Gephi**：GPL-3.0，与本项目闭源分发方式不兼容。
- **@xyflow/react**（备选方案，MIT）：本次未采用，本项目展示的是
  **多对多关系**而非可编排的层级/流程，节点编辑器模型不对口。
- **@nivo/heatmap**（矩阵备选，MIT）：本次未采用，矩阵降级视图用已有的
  recharts 自绘，不额外引入依赖。
- **react-force-graph-2d**（MIT）：曾采用，因「自动变形 / 不可拖拽 / 无法切布局」
  已更换为 cytoscape.js，依赖已移除。

---

## 5. 本仓库自有代码

除上述明确标注来源的文件外，仓库内其余代码为本项目自有实现。
