# 版本维护 Checklist

一个管理版本维护任务和邮件发送的单页 Web 应用，支持多版本、多日期（周一/周四/周五）任务跟踪。

## 功能特点

- **多版本管理** — 支持管理多个版本，每个版本独立配置版本号、负责人、链接等信息
- **多日期支持** — 周一、周四、周五三种维护日程，每种日期有独立的 checklist
- **跨版本/日期复制** — 单个任务可复制到其他版本或其他日期，支持连带子任务一起复制
- **周一邮件配置** — 支持收件人（多个换行填写）、抄送人、主题、内容配置
- **新的一周重置** — 一键重置已勾选任务为待选择状态（不影响版本号）
- **双层数据持久化** — localStorage 缓存（秒开）+ JSON 文件持久化（可备份/同步）
- **数据导入/导出** — JSON 格式备份和恢复
- **响应式设计** — 支持深色模式

## 使用方法

### 启动应用

**方式一：本地服务器（推荐）**
```bash
cd /path/to/version-maintenance-app
python3 -m http.server 8000
# 浏览器访问 http://localhost:8000
```
> 通过 HTTP 服务打开，文件权限可跨 session 保持，备份自动写入 data 目录。

**方式二：直接打开**
双击 `index.html` 打开（数据通过 localStorage 缓存，备份需手动下载）

### 核心操作

| 操作 | 说明 |
|------|------|
| 切换日期 | 点击顶部「周四」「周五」「周一」按钮 |
| 添加版本 | 点击左侧「+ 添加版本」 |
| 编辑版本 | 选中版本后点击「编辑」|
| 复制 Checklist | 选中版本后点击「复制 checklist」批量复制 |
| 复制单个任务 | 点击任务右侧「复制」按钮，可选目标版本和日期 |
| 新的一周 | 点击「新的一周」重置所有已勾选任务的勾选状态 |
| 发送邮件 | 周一视图下填写收件人、主题、内容后保存 |

## 数据存储

数据同时保存在两处：

1. **localStorage** — 浏览器本地缓存，每次操作实时更新，打开页面瞬间加载
2. **data/data.json** — JSON 文件持久化，需要通过 HTTP 服务访问才能自动写入

### 文件说明

```
version-maintenance-app/
├── index.html          # 入口文件
├── app.js              # 应用逻辑
├── styles.css          # 样式
├── data/
│   └── data.json       # 持久化数据文件（需 HTTP 服务）
└── README.md
```

### 任务字段说明

每个任务（checklist item）包含以下字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `text` | string | 任务内容 |
| `completed` | boolean | 是否已勾选（checkbox 状态） |
| `completedAt` | string/null | 勾选时间，格式：`YYYY-MM-DD HH:mm` |
| `taskStatus` | string/null | 状态：`pending`（待选择）、`in-progress`（进行中）、`completed`（已完成） |
| `cautions` | string | **注意事项**（红色显示） |
| `notes` | string | **备注**（黑色显示） |
| `link` | string | 关联链接 |
| `image` | string | 图片（Base64 编码） |
| `suggestTime` | string | 建议完成时间 |
| `subtasks` | array | 子任务数组 |

**注意**：`cautions` 和 `notes` 是两个独立的字段，请勿混淆。

## 技术栈

- 纯 HTML + CSS + JavaScript，无框架依赖
- File System Access API（`showDirectoryPicker`）读写本地文件
- IndexedDB 存储目录句柄
- localStorage 做缓存层

## Claude Code 使用

### 快速开始（新窗口）

在新 Claude Code 窗口中输入以下指令：

```
请先阅读以下文件：
1. PREFERENCES.md（用户偏好和测试要求）
2. CLAUDE.md（项目架构）

然后告诉我当前项目的状态和待办事项。
```

或者复制以下内容直接粘贴：

```markdown
请先阅读以下文件：
1. PREFERENCES.md（用户偏好和测试要求）
2. CLAUDE.md（项目架构）

然后告诉我当前项目的状态和待办事项。
```

### 相关文件

- `PREFERENCES.md` - 用户偏好、工程规范、AI 更新规则
- `CLAUDE.md` - Claude Code 工作指南
- `skill/` - 需求追踪文档

## 浏览器兼容性

- Chrome/Edge 90+（推荐）
- 通过 HTTP 服务访问可获得最佳体验
