// Factory-default playback implementation.

#include "factory_default.h"
#include "effects.h"
#include "led_driver.h"

void factoryDefaultFillAll(uint32_t t_ticks) {
    for (uint8_t pin = 0; pin < PIN_COUNT; pin++) {
        breathRainbowFill(pin, FACTORY_LED_PER_PIN, t_ticks);
    }
}
