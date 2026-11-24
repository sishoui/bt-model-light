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

### 小程序变更：自动触发真机预览（免扫码）

只要本次改动落在 `miniprogram/`（`pages/**`、`utils/**`、`app.js`/`app.json`/`app.wxss`、`project.config.json` 等），在跑完 `cd miniprogram && npm test` 后**自动**追加一步真机预览，不要等用户开口。用户明确要求**不要生成二维码让用户扫**，用自动预览：

- 首选 CLI：`cli auto-preview --project <miniprogram 绝对路径>`（手机同账号微信自动打开，无需扫码）。
- GUI 等价路径：开发者工具顶部「预览」→「自动预览」Tab → 勾选「启动手机端自动预览」→「编译并预览」（Shift+Ctrl+P）。
- CLI 路径：`C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat`（已在 PATH 之外，需全路径调用；Git Bash 下用反斜杠路径）。
- 前置条件：手机微信在前台运行且登录与开发者工具同一账号（当前为"死守i"）。不满足时手机端不会自动打开，需提示用户检查账号/前台状态。
- 成功标准：输出 `✔ auto-preview`（或面板正常关闭）且无 error；编译失败时**不要**继续，直接把错误贴出来让用户先修。
- 手机端查看与物理层验证（空口 MTU/分包、灯珠实动等）仍属人工项，不替代 `docs/smoke-test.md`。

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues in `sishoui/bt-model-light` (via `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles (`needs-triage`/`needs-info`/`ready-for-agent`/`ready-for-human`/`wontfix`) plus component labels (`小程序`/`后台`/`后端`/`固件`/`数据库`/`文档`/`测试`/`人工测试`). Component labels are added on top of the role label for every issue that touches a concrete area; `测试` marks test-file changes and `人工测试` marks issues needing manual QA. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (`GLOSSARY.md` + `docs/adr/` at repo root). See `docs/agents/domain.md`.