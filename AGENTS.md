# AGENTS.md

## 沟通语言

所有结论（回答、总结、计划、评审报告、issue 评论等面向用户的文本）统一用**中文**回答。

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues in `sishoui/bt-model-light` (via `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles (`needs-triage`/`needs-info`/`ready-for-agent`/`ready-for-human`/`wontfix`) plus component labels (`小程序`/`后台`/`后端`/`固件`/`数据库`/`文档`/`测试`/`人工测试`). Component labels are added on top of the role label for every issue that touches a concrete area; `测试` marks test-file changes and `人工测试` marks issues needing manual QA. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (`GLOSSARY.md` + `docs/adr/` at repo root). See `docs/agents/domain.md`.