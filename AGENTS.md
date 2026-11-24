# AGENTS.md

## 沟通语言

所有结论（回答、总结、计划、评审报告、issue 评论等面向用户的文本）统一用**中文**回答。

## 测试分工：能自动跑的直接跑，只有人工项才交给用户

交付/验证阶段，按"能否自动执行"分流，不要把自动项丢回给用户：

- **能自动跑的，直接跑完再汇报结果**，不要让用户手动执行。本项目含：
  - 小程序逻辑层：`cd miniprogram && npm test`（Jest）
  - 固件协议解析层：`cd firmware && pio test -e native`（PlatformIO + Unity，无需硬件）
  - 代码生成一致性：`python protocol/codegen/generate.py --check` 与 `python protocol/codegen/test_repeatable.py`
  - CI 三层：push 后到 GitHub Actions 看 workflow 是否全绿（可 `gh run` 查询）
- **只有真机 / 物理硬件才能验证的才展示清单交给用户**，按 `docs/smoke-test.md`（iOS + Android，权限路径、空口 MTU/分包、灯珠实动等）。对这类项，明确说清"需人工真机测试"及其原因，不要用自动测试的结论替代。

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues in `sishoui/bt-model-light` (via `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles (`needs-triage`/`needs-info`/`ready-for-agent`/`ready-for-human`/`wontfix`) plus component labels (`小程序`/`后台`/`后端`/`固件`/`数据库`/`文档`/`测试`/`人工测试`). Component labels are added on top of the role label for every issue that touches a concrete area; `测试` marks test-file changes and `人工测试` marks issues needing manual QA. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (`GLOSSARY.md` + `docs/adr/` at repo root). See `docs/agents/domain.md`.