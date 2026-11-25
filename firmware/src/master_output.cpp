// 输出级整机控制实现（纯 C++，native 可测）。

#include "master_output.h"

static bool    sPower = MASTER_POWER_DEFAULT;
static uint8_t sBrightness = MASTER_BRIGHTNESS_DEFAULT;

void masterSetPower(bool on) {
    sPower = on;
}

bool masterGetPower(void) {
    return sPower;
}

void masterSetBrightness(uint8_t value) {
    sBrightness = value;
}

uint8_t masterGetBrightness(void) {
    return sBrightness;
}

Rgb masterScaleBrightness(Rgb c, uint8_t value) {
    if (value == 255) return c;
    if (value == 0) {
        Rgb z = {0, 0, 0};
        return z;
    }
    Rgb o;
    o.r = (uint8_t)(((uint16_t)c.r * value) / 255);
    o.g = (uint8_t)(((uint16_t)c.g * value) / 255);
    o.b = (uint8_t)(((uint16_t)c.b * value) / 255);
    return o;
}

Rgb masterApplyOutput(Rgb c) {
    if (!sPower) {
        Rgb z = {0, 0, 0};
        return z;   // 关机：全黑，但不动配置与各引脚状态（ADR-0032）
    }
    return masterScaleBrightness(c, sBrightness);
}

void masterResetDefaults(void) {
    sPower = MASTER_POWER_DEFAULT;
    sBrightness = MASTER_BRIGHTNESS_DEFAULT;
}
