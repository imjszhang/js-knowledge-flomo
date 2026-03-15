---
name: flomo-assistant
description: 以 flomo 笔记为素材，利用 AI 工具组合完成知识管理任务：洞察发现、关联分析、标签整理、观点追踪、写作辅助。
version: 1.0.0
author: js-knowledge-flomo
---

# Flomo 知识助手

利用 flomo 笔记数据 + AI 分析工具，完成日常知识管理和写作任务。

## 前置条件

首次使用前需完成 flomo OAuth 授权：

```bash
openclaw flomo auth
```

授权成功后 token 自动保存，后续无需重复操作。

## 可用工具

### 笔记操作

| 工具 | 说明 |
|------|------|
| `flomo_memo_create` | 创建笔记（支持 #标签） |
| `flomo_memo_update` | 更新已有笔记 |
| `flomo_memo_search` | 搜索笔记（关键词/标签/时间范围） |
| `flomo_memo_batch_get` | 批量获取笔记详情 |
| `flomo_memo_recommended` | 获取某条笔记的相关推荐 |

### 标签操作

| 工具 | 说明 |
|------|------|
| `flomo_tag_tree` | 获取完整标签层级 |
| `flomo_tag_search` | 搜索标签 |
| `flomo_tag_rename` | 重命名标签（关联笔记同步更新） |

### AI 分析

| 工具 | 说明 |
|------|------|
| `flomo_generate_insights` | 分析笔记中的规律和隐藏模式 |
| `flomo_track_evolution` | 追踪某话题的观点演变 |
| `flomo_find_connections` | 发现跨标签、跨时间的隐藏关联 |
| `flomo_draft_outline` | 从笔记生成写作大纲 |
| `flomo_collect_material` | 搜集主题相关笔记素材 |
| `flomo_suggest_tags` | 为无标签笔记推荐标签 |
| `flomo_audit_tags` | 分析标签体系问题并给出优化建议 |

## 典型工作流

### 1. 每周回顾

适合定期复盘笔记，发现自己没意识到的思维模式。

1. 调用 `flomo_generate_insights`，设 `period: 7`
2. 根据洞察结果，用 `flomo_memo_search` 深入查看相关笔记
3. 将回顾总结用 `flomo_memo_create` 写回 flomo（建议标签 `#回顾`）

### 2. 主题写作

从散落的笔记中提炼出结构化的写作素材。

1. 用 `flomo_collect_material` 搜集主题相关笔记
2. 用 `flomo_find_connections` 发现素材间的隐藏关联
3. 用 `flomo_draft_outline` 生成写作大纲
4. 根据大纲展开写作

### 3. 标签整理

定期清理和优化标签体系。

1. 用 `flomo_audit_tags` 获取标签体系诊断报告
2. 根据建议用 `flomo_tag_rename` 合并/重命名标签
3. 用 `flomo_suggest_tags` 为无标签笔记补充分类

### 4. 观点追踪

追踪自己对某个话题的认知变化轨迹。

1. 用 `flomo_track_evolution` 输入感兴趣的话题
2. 查看时间线上的观点变化
3. 将演变总结写回 flomo 作为元认知记录

## 注意事项

- 所有笔记操作直接作用于你的 flomo 账户，写入和更新操作不可撤销
- AI 分析功能依赖 LLM API，需在插件配置中填写 `llmApiKey` 和 `llmApiBaseUrl`
- 搜索和分析操作不会修改你的笔记数据
