# Codegen

协议单一真相源：`protocol/*.csv`（定义见 `protocol/frame-spec.md` 与 `docs/adr/0011-protocol-codegen.md`）。

## 产物

- `firmware/include/protocol_gen.h` — 固件 C 头文件
- `miniprogram/utils/protocol_gen.js` — 小程序 JS 常量

## 用法

```sh
# 重新生成产物
python protocol/codegen/generate.py

# CI 一致性检查（产物与手写/签入版本一致）
python protocol/codegen/generate.py --check

# 可重复性测试（生成两次 + 对比签入版本）
python protocol/codegen/test_repeatable.py
```

## 约定

- 修改协议定义时，**只改 CSV**（及必要时 `frame-spec.md`），然后跑 `generate.py` 重新生成产物。
- 不要手编 `protocol_gen.h` / `protocol_gen.js`。CI 会跑 `--check`，不一致则失败。
- 跨平台：脚本仅用 Python 3 标准库，可在 Windows / Linux / macOS 运行。