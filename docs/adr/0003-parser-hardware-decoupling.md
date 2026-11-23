# ADR-0003: 协议解析层与硬件解耦

- 状态: 已接受
- 日期: 2026-11-23
- 标签: 固件, 测试

## 背景

arena-feasibility 分析报告明确指出："单片机协议解析层 Mock 不是现成能力，而是有前提——固件把协议解析抽成纯函数，输入字节数组、输出结构体/状态，硬件副作用接口注入。" 典型嵌入式 C 工程解析与寄存器、中断、定时器混写，直接不可测。

## 决策

固件将协议解析抽成**纯函数**：

- 输入：字节数组 + 长度
- 输出：结构体（命令 + payload）或错误码
- 硬件副作用（写 GPIO、更新灯带缓冲）通过**函数指针接口注入**

解析层可在 PlatformIO 下独立编译为 Unity 单测目标，无需真实硬件。

## 理由

- 是 ADR-0012 CI 单测层可落地的前提
- 协议一致性测试、模糊测试的前提
- 不让解析逻辑与 BLE 栈/灯带驱动耦合

## 影响

- `firmware/include/protocol_parser.h` 声明纯函数接口
- `firmware/src/protocol_parser.c` 仅依赖标准 C，不 `#include <Arduino.h>`
- `firmware/test/test_protocol_parser/` 挂 Unity 单测

## 备选

- 解析与硬件混写：直接不可测，与 arena 分析结论冲突