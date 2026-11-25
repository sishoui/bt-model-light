// 输出级整机控制：整机开关（SET_POWER）+ 整机亮度（SET_BRIGHTNESS）。
//
// 两个整机旋钮在这里落地，且走**同一个出口**（ledSetPixel 写像素前）：
//   - 整机开关：关 = 输出全黑，但**不改配置、不改各引脚自己的灯带开关状态**
//     （config.pins[].power），开机后各引脚按原状态继续渲染（ADR-0032）；
//   - 整机亮度：所有待写出的颜色统一乘以 value/255（与图层参数里的 brightness
//     是相乘关系）。
// 放在输出级而不是渲染层，是为了让配置播放、预览与 IDLE 出厂默认彩虹共用同一个
// 门控/缩放点，且渲染函数签名不变。
//
// 纯 C++（无 Arduino/FreeRTOS），纳入 native 测试（ADR-0003/0012）。
// 两者都是 RAM 态、不落 spiffs：设备重启/断电后回到"开机 + 满亮度"，由小程序
// 重连补发用户设定（ADR-0031/0032）。

#pragma once

#include <stdint.h>

#include "led_driver.h"   // Rgb

// 默认值：开机 + 不缩放（设备未收到过整机命令时的行为）。
#define MASTER_BRIGHTNESS_DEFAULT 255
#define MASTER_POWER_DEFAULT      true

// 整机开关（SET_POWER 0x0B）。
void masterSetPower(bool on);
bool masterGetPower(void);

// 整机亮度 0~255（SET_BRIGHTNESS 0x0A）。
void masterSetBrightness(uint8_t value);
uint8_t masterGetBrightness(void);

// 按目标亮度缩放一个颜色（纯函数）：255 原样返回，0 返回全黑，
// 其余按每通道 (c * value) / 255 整数缩放。
Rgb masterScaleBrightness(Rgb c, uint8_t value);

// 输出级统一处理（ledSetPixel 调用）：关机 → 全黑；开机 → 按整机亮度缩放。
Rgb masterApplyOutput(Rgb c);

// 出厂复位：回到开机 + 满亮度（RESET_DEFAULT 与 BOOT 5s 长按共用）。
void masterResetDefaults(void);
