---
name: Tim 充值服务
description: 现有公众充值页与管理工作台的已实现视觉记录
colors:
  bg: "#f4f1ea"
  paper: "#fffdf8"
  ink: "#2c2a27"
  line: "#ddd7ce"
  accent-text: "#9f4f36"
  soft: "#f7e7df"
  public-accent: "#cf6f4f"
  public-accent-dark: "#ad5135"
  public-muted: "#746f68"
  workbench-muted: "#625f59"
  workbench-success: "#266749"
  workbench-danger: "#a43b2a"
typography:
  public-body:
    fontFamily: '"DM Sans", "Noto Sans SC", system-ui, sans-serif'
  workbench-body:
    fontFamily: 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: "15px"
    lineHeight: 1.6
  workbench-title:
    fontSize: "19px"
  workbench-label:
    fontSize: "14px"
    fontWeight: 600
  workbench-hint:
    fontSize: "13px"
  workbench-mono:
    fontFamily: "ui-monospace, Consolas, monospace"
rounded:
  workbench-field: "8px"
  workbench-button: "9px"
  workbench-sheet: "14px"
  public-surface: "18px"
spacing:
  workbench-action-gap: "10px"
  workbench-field-gap: "18px"
  workbench-section: "24px"
  workbench-column-gap: "32px"
components:
  workbench-button-primary:
    backgroundColor: "{colors.accent-text}"
    textColor: "white"
    rounded: "{rounded.workbench-button}"
    padding: "10px 18px"
  workbench-button-quiet:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.workbench-button}"
    padding: "10px 18px"
  workbench-sheet:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.workbench-sheet}"
    padding: "28px"
---

# Design System: Tim 充值服务

## Overview

本记录提取自 `admin.html`、`admin.css` 和 `styles.css` 的现有实现。公众页与工作台共用暖纸色底、深色正文、陶土色强调及细分隔线。工作台承接已有身份，以紧凑表单、操作按钮和表格呈现任务。未确认的品牌比喻不写入规范。

公众页的展示排版、渐变和层次效果保留在公众页；工作台的系统字体、密度及状态颜色仅约束工作台。本记录不替代各页面的产品流程。

**Key Characteristics:**

- 暖纸色背景与深色正文。
- 公众页展示表达与工作台操作密度分别定义。
- 工作台通过边框、底色和文字状态建立层级。

## Colors

### Primary

共享的 `accent-text` 用于公众页强调文字及工作台主操作；`soft` 用于浅色强调。公众页的 `public-accent` 与 `public-accent-dark` 延续原有 CSS 的 green 命名变量，实际为陶土色，不能按变量名字改成绿色。

### Neutral

`bg` 是画布，`paper` 是承载表单和内容的浅色表面，`ink` 是主要文字，`line` 是分隔线。公众页与工作台分别使用自己的弱化文字色。

工作台成功和可用状态用 `workbench-success`，失败和隔离状态用 `workbench-danger`；状态同时有文字说明。公众页另有自己的危险色及彩色品牌渐变，它们不构成工作台状态色。

**The Surface Scope Rule.** 同名用途不代表跨页面共享全部取值；带 public 或 workbench 前缀的规则保持各自作用域。

## Typography

公众页正文使用 DM Sans 与 Noto Sans SC；首页主标题使用 Noto Serif SC、Georgia、serif，标题的响应字号及彩色副标题属于该首页局部实现。

工作台正文、表单和表格延续系统界面字体。二级标题、标签和辅助文字形成前述 token 层级，表格正文为 14px。账号和标识符采用等宽字体并允许长内容换行。段落最大宽度为 75ch。工作台页面标题在桌面为 30px、窄屏为 26px，属于操作页层级，不推广为品牌展示字体。

## Layout

公众页已观察到的页头和主视觉使用最大 1180px、两侧合计 48px 的容器。此处仅记录已读取区域，不推断全站响应断点。

工作台主体最大宽度 1240px，桌面水平留白 24px。任务表单与结果使用 1.25:1 双列，列距取 `workbench-column-gap`；结果区在宽屏吸顶，顶部距离 20px。双字段并列，筛选区四列，搜索项占两列。

780px 及以下，主任务区改为单列、结果取消吸顶、筛选为两列、表单内边距变为 20px。440px 及以下，主体水平留白变为 16px、双字段改为单列、表单内边距 18px，页头允许换行。表格容器保留横向滚动，并提供窄屏提示。

## Elevation & Depth

公众页保留柔和环境光、渐变和阴影；根阴影 token 为 `0 24px 70px rgba(56, 47, 38, 0.10)`。这些效果不能推断为每个容器的必需效果。

工作台表单和表格以实色表面及一像素边框区分，无常规投影。身份验证对话框通过 `rgba(30,30,26,.5)` 背景遮罩区分前后层。

## Shapes

工作台输入框、按钮和表单分别采用前述圆角；表格外框为 10px，导航项为 7px。公众页保留自己的 18px 基础圆角及胶囊型通道切换器，不把胶囊外形扩展到工作台按钮。

## Components

### Buttons

工作台主按钮为陶土底白字，quiet 变体为纸色底、深色文字和细边框。最小高度 44px，字重 600。悬停亮度为 .94；禁用透明度 .55，指针显示不可用。焦点为强调色 3px 外轮廓，偏移 3px。表格按钮缩小内边距，继续保留最小高度。

### Inputs / Fields

工作台字段白底，边框为 `#b8b0a5`，内边距 11px 12px，最小高度 44px。字段标题始终可见；多行输入可纵向调整。复选框使用原生控件及强调色，不使用输入框的全宽尺寸。

### Navigation

工作台导航使用按钮及 `aria-current="page"`，当前页为浅陶土底和强调文字。公众页导航使用链接及短下划线标识活动项，两者保持各自实现。

### Cards / Containers

工作台表单 sheet、登录区和对话框共用纸色表面、细边框及表面圆角；订单回执是无卡片背景的文本结果区。表格使用浅色表头、横向行分隔及左对齐文字。空表状态保留说明文本。

### Status and Feedback

工作台状态为字重 650 的文字，成功与失败额外使用语义色。通知提供实时状态播报，重新验证错误提供警报播报。隐藏页面使用 hidden，跳转主要内容链接在聚焦时显示。工作台未实现装饰动画，不从公众页继承轮播动画。

## Do's and Don'ts

### Do:

- Do 保留共享暖色基底及各表面的局部字体、状态色和布局规则。
- Do 让工作台状态同时包含文字说明，保留可见标签、键盘焦点和表格横向滚动。
- Do 从实际组件实现提取后续规则，并注明页面作用域。

### Don't:

- Don't 将公众页的渐变、阴影或胶囊切换器规定为工作台默认样式。
- Don't 将工作台的紧凑表格、系统字体或无阴影容器提升为公众页的全局禁令。
- Don't 根据历史 CSS 变量的 green 名称改变实际陶土色身份。
