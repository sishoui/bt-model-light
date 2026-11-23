// Device config model + binary codec + validation implementation.
//
// See config.h for the contract and protocol/frame-spec.md "配置负载" for
// the byte-level blob layout. Pure C++ (no Arduino), native-testable.

#include "config.h"
#include "protocol_parser.h"   // crc16_ccitt (also declared in protocol_gen.h)

#include <string.h>

// ---------------------------------------------------------------------------
// Param schema helpers (mirror EFFECT_PARAMS in protocol_gen.h)
// ---------------------------------------------------------------------------

const effect_entry_t *config_effect_entry(uint8_t effect_id) {
    for (uint32_t i = 0; i < EFFECT_COUNT; i++) {
        if (EFFECT_TABLE[i].effect_id == effect_id) {
            return &EFFECT_TABLE[i];
        }
    }
    return NULL;
}

uint8_t config_effect_param_size(uint8_t effect_id) {
    const effect_entry_t *e = config_effect_entry(effect_id);
    if (!e) return 0;
    uint8_t total = 0;
    for (const effect_param_t *p = e->params; p->type != PARAM_END; p++) {
        total = (uint8_t)(total + p->size);
    }
    return total;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

void config_init_empty(device_config_t *c) {
    memset(c, 0, sizeof(*c));
    c->version = CONFIG_VERSION;
}

// Factory default: breath on all 8 pins covering the full conservative
// strip, loop forever. Built from the 8-effect set so the renderer plays
// it through the same path as user configs (ADR-0015 / 0017).
void config_load_factory_default(device_config_t *c) {
    config_init_empty(c);
    for (uint8_t pin = 0; pin < PIN_COUNT; pin++) {
        config_pin_t *p = &c->pins[pin];
        p->group_count = 1;
        config_group_t *g = &p->groups[0];
        g->led_start = 0;
        g->led_end = (uint8_t)(FACTORY_LED_PER_PIN - 1);
        g->step_count = 1;
        config_step_t *s = &g->steps[0];
        s->duration = 60;                 // hold 60s then loop
        s->transition = CONFIG_TRANSITION_NONE;
        s->loop_mode = CONFIG_LOOP_LOOP;
        s->layer_count = 1;
        config_layer_t *l = &s->layers[0];
        l->effect_id = EFF_BREATH;
        l->param_len = (uint8_t)config_effect_param_size(EFF_BREATH);
        // color = warm cyan, brightness = 255, speed = 50, direction = 0,
        // period = 3000ms, waveform = 0 (sine).
        l->params[0] = 0x00; l->params[1] = 0xCC; l->params[2] = 0xFF; // R,G,B
        l->params[3] = 255;   // brightness
        l->params[4] = 50;    // speed
        l->params[5] = 0;     // direction
        l->params[6] = (uint8_t)(3000 & 0xFF);         // period lo
        l->params[7] = (uint8_t)((3000 >> 8) & 0xFF);  // period hi
        l->params[8] = 0;     // waveform
    }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

uint8_t config_validate(const device_config_t *c) {
    if (!c) return ERR_INTERNAL_ERROR;
    if (c->version != CONFIG_VERSION) return ERR_INVALID_PARAMETER;

    for (uint8_t pin = 0; pin < PIN_COUNT; pin++) {
        const config_pin_t *p = &c->pins[pin];
        if (p->group_count > GROUPS_PER_PIN_MAX) return ERR_CONFIG_LIMIT_EXCEEDED;
        for (uint8_t gi = 0; gi < p->group_count; gi++) {
            const config_group_t *g = &p->groups[gi];
            if (g->led_start >= LEDS_PER_PIN_MAX) return ERR_INVALID_PARAMETER;
            if (g->led_end >= LEDS_PER_PIN_MAX) return ERR_INVALID_PARAMETER;
            if (g->led_end < g->led_start) return ERR_INVALID_PARAMETER;
            if (g->step_count < 1 || g->step_count > STEPS_PER_GROUP_MAX) {
                return ERR_CONFIG_LIMIT_EXCEEDED;
            }
            for (uint8_t si = 0; si < g->step_count; si++) {
                const config_step_t *s = &g->steps[si];
                if (s->duration < STEP_DURATION_MIN || s->duration > STEP_DURATION_MAX) {
                    return ERR_INVALID_PARAMETER;
                }
                if (s->transition > CONFIG_TRANSITION_SMOOTH) return ERR_INVALID_PARAMETER;
                if (s->loop_mode > CONFIG_LOOP_PINGPONG) return ERR_INVALID_PARAMETER;
                if (s->layer_count < 1 || s->layer_count > LAYERS_PER_STEP_MAX) {
                    return ERR_CONFIG_LIMIT_EXCEEDED;
                }
                for (uint8_t li = 0; li < s->layer_count; li++) {
                    const config_layer_t *l = &s->layers[li];
                    const effect_entry_t *e = config_effect_entry(l->effect_id);
                    if (!e) return ERR_INVALID_PARAMETER; // unknown effect
                    uint8_t want = config_effect_param_size(l->effect_id);
                    if (l->param_len != want) return ERR_INVALID_PARAMETER;
                }
            }
        }
    }
    return 0;
}

// ---------------------------------------------------------------------------
// Wire codec
// ---------------------------------------------------------------------------

// Little-endian append helpers. Return false on capacity overflow.
static bool put_u8(uint8_t *buf, size_t cap, size_t *off, uint8_t v) {
    if (*off + 1 > cap) return false;
    buf[(*off)++] = v;
    return true;
}
static bool put_u16(uint8_t *buf, size_t cap, size_t *off, uint16_t v) {
    if (*off + 2 > cap) return false;
    buf[(*off)++] = (uint8_t)(v & 0xFF);
    buf[(*off)++] = (uint8_t)((v >> 8) & 0xFF);
    return true;
}
static bool put_bytes(uint8_t *buf, size_t cap, size_t *off,
                      const uint8_t *src, size_t n) {
    if (*off + n > cap) return false;
    memcpy(buf + *off, src, n);
    *off += n;
    return true;
}

size_t config_encode(const device_config_t *c, uint8_t *out, size_t cap,
                     uint8_t *err) {
    if (err) *err = 0;
    if (!c || !out) { if (err) *err = ERR_INTERNAL_ERROR; return 0; }

    uint8_t verr = config_validate(c);
    if (verr != 0) { if (err) *err = verr; return 0; }

    // First pass: compute body length.
    size_t body_len = 0;
    for (uint8_t pin = 0; pin < PIN_COUNT; pin++) {
        body_len += 1; // group_count
        const config_pin_t *p = &c->pins[pin];
        for (uint8_t gi = 0; gi < p->group_count; gi++) {
            const config_group_t *g = &p->groups[gi];
            body_len += 3; // led_start + led_end + step_count
            for (uint8_t si = 0; si < g->step_count; si++) {
                const config_step_t *s = &g->steps[si];
                body_len += 5; // duration(2)+transition(1)+loop_mode(1)+layer_count(1)
                for (uint8_t li = 0; li < s->layer_count; li++) {
                    const config_layer_t *l = &s->layers[li];
                    body_len += 2 + l->param_len; // effect_id + param_len + params
                }
            }
        }
    }

    size_t total = CONFIG_BLOB_OVERHEAD + body_len;
    if (total > cap || body_len > CONFIG_BODY_MAX) {
        if (err) *err = ERR_CONFIG_LIMIT_EXCEEDED;
        return 0;
    }

    // Second pass: write.
    size_t off = 0;
    // magic (LE u32)
    out[off++] = (uint8_t)(CONFIG_MAGIC_LE & 0xFF);
    out[off++] = (uint8_t)((CONFIG_MAGIC_LE >> 8) & 0xFF);
    out[off++] = (uint8_t)((CONFIG_MAGIC_LE >> 16) & 0xFF);
    out[off++] = (uint8_t)((CONFIG_MAGIC_LE >> 24) & 0xFF);
    out[off++] = CONFIG_VERSION;
    out[off++] = 0; // flags
    out[off++] = (uint8_t)(body_len & 0xFF);
    out[off++] = (uint8_t)((body_len >> 8) & 0xFF);

    for (uint8_t pin = 0; pin < PIN_COUNT; pin++) {
        const config_pin_t *p = &c->pins[pin];
        put_u8(out, cap, &off, p->group_count);
        for (uint8_t gi = 0; gi < p->group_count; gi++) {
            const config_group_t *g = &p->groups[gi];
            put_u8(out, cap, &off, g->led_start);
            put_u8(out, cap, &off, g->led_end);
            put_u8(out, cap, &off, g->step_count);
            for (uint8_t si = 0; si < g->step_count; si++) {
                const config_step_t *s = &g->steps[si];
                put_u16(out, cap, &off, s->duration);
                put_u8(out, cap, &off, s->transition);
                put_u8(out, cap, &off, s->loop_mode);
                put_u8(out, cap, &off, s->layer_count);
                for (uint8_t li = 0; li < s->layer_count; li++) {
                    const config_layer_t *l = &s->layers[li];
                    put_u8(out, cap, &off, l->effect_id);
                    put_u8(out, cap, &off, l->param_len);
                    put_bytes(out, cap, &off, l->params, l->param_len);
                }
            }
        }
    }

    // crc over magic..body_last_byte
    uint16_t crc = crc16_ccitt(out, off);
    out[off++] = (uint8_t)(crc & 0xFF);
    out[off++] = (uint8_t)((crc >> 8) & 0xFF);
    return off;
}

// Little-endian read helpers. Advance *off; no bounds checking here
// (caller guarantees body_len fits in in_len).
static uint8_t get_u8(const uint8_t *b, size_t *off) {
    return b[(*off)++];
}
static uint16_t get_u16(const uint8_t *b, size_t *off) {
    uint16_t v = (uint16_t)b[*off] | ((uint16_t)b[*off + 1] << 8);
    *off += 2;
    return v;
}

uint8_t config_decode(const uint8_t *in, size_t in_len, device_config_t *out) {
    if (!in || !out || in_len < CONFIG_BLOB_OVERHEAD) return ERR_INTERNAL_ERROR;

    // magic
    uint32_t magic = (uint32_t)in[0] | ((uint32_t)in[1] << 8) |
                     ((uint32_t)in[2] << 16) | ((uint32_t)in[3] << 24);
    if (magic != CONFIG_MAGIC_LE) return ERR_INTERNAL_ERROR;
    if (in[4] != CONFIG_VERSION) return ERR_INVALID_PARAMETER; // version drift
    // in[5] flags reserved; ignore

    size_t body_len = (size_t)in[6] | ((size_t)in[7] << 8);
    size_t total = CONFIG_BLOB_OVERHEAD + body_len;
    if (total > in_len) return ERR_BUFFER_OVERFLOW; // truncated
    if (body_len > CONFIG_BODY_MAX) return ERR_CONFIG_LIMIT_EXCEEDED;

    // crc over magic..body_last_byte = bytes [0 .. total-2)
    uint16_t want_crc = (uint16_t)in[total - 2] | ((uint16_t)in[total - 1] << 8);
    uint16_t got_crc = crc16_ccitt(in, total - 2);
    if (want_crc != got_crc) return ERR_CRC_ERROR;

    // decode body
    config_init_empty(out);
    size_t off = 8;
    size_t body_end = 8 + body_len;
    for (uint8_t pin = 0; pin < PIN_COUNT; pin++) {
        if (off >= body_end) return ERR_INTERNAL_ERROR;
        config_pin_t *p = &out->pins[pin];
        p->group_count = get_u8(in, &off);
        if (p->group_count > GROUPS_PER_PIN_MAX) return ERR_CONFIG_LIMIT_EXCEEDED;
        for (uint8_t gi = 0; gi < p->group_count; gi++) {
            if (off + 3 > body_end) return ERR_INTERNAL_ERROR;
            config_group_t *g = &p->groups[gi];
            g->led_start = get_u8(in, &off);
            g->led_end = get_u8(in, &off);
            g->step_count = get_u8(in, &off);
            if (g->step_count < 1 || g->step_count > STEPS_PER_GROUP_MAX) {
                return ERR_CONFIG_LIMIT_EXCEEDED;
            }
            for (uint8_t si = 0; si < g->step_count; si++) {
                if (off + 5 > body_end) return ERR_INTERNAL_ERROR;
                config_step_t *s = &g->steps[si];
                s->duration = get_u16(in, &off);
                s->transition = get_u8(in, &off);
                s->loop_mode = get_u8(in, &off);
                s->layer_count = get_u8(in, &off);
                if (s->layer_count < 1 || s->layer_count > LAYERS_PER_STEP_MAX) {
                    return ERR_CONFIG_LIMIT_EXCEEDED;
                }
                for (uint8_t li = 0; li < s->layer_count; li++) {
                    if (off + 2 > body_end) return ERR_INTERNAL_ERROR;
                    config_layer_t *l = &s->layers[li];
                    l->effect_id = get_u8(in, &off);
                    l->param_len = get_u8(in, &off);
                    if (l->param_len > CONFIG_EFFECT_PARAM_MAX) {
                        return ERR_INVALID_PARAMETER;
                    }
                    if (off + l->param_len > body_end) return ERR_INTERNAL_ERROR;
                    memset(l->params, 0, sizeof(l->params));
                    for (uint8_t k = 0; k < l->param_len; k++) {
                        l->params[k] = in[off++];
                    }
                }
            }
        }
    }

    // All body bytes must be consumed exactly.
    if (off != body_end) return ERR_INTERNAL_ERROR;

    // Final structural + range validation (catches index/range issues that
    // don't fail the byte-level decode above).
    return config_validate(out);
}

// ---------------------------------------------------------------------------
// Typed param accessors
// ---------------------------------------------------------------------------

bool config_decode_params(const config_layer_t *layer, effect_params_t *out) {
    if (!layer || !out) return false;
    const effect_entry_t *e = config_effect_entry(layer->effect_id);
    if (!e) return false;

    size_t off = 0;
    const uint8_t *p = layer->params;
    uint8_t avail = layer->param_len;
    bool ok = true;

    // Helper macro: ensure `n` bytes remain, advance, else mark not-ok.
#define TAKE(n) ((avail >= (n)) ? (avail -= (n), true) : (ok = false, false))

    for (const effect_param_t *pp = e->params; pp->type != PARAM_END; pp++) {
        switch (pp->type) {
            case PARAM_RGB: {
                if (!TAKE(3)) return false;
                config_rgb_t *dst = (strcmp(pp->name, "color2") == 0)
                                        ? &out->color2 : &out->color;
                dst->r = p[off]; dst->g = p[off + 1]; dst->b = p[off + 2];
                off += 3;
                break;
            }
            case PARAM_U8: {
                if (!TAKE(1)) return false;
                uint8_t v = p[off++];
                if      (strcmp(pp->name, "brightness") == 0) out->brightness = v;
                else if (strcmp(pp->name, "speed") == 0)      out->speed = v;
                else if (strcmp(pp->name, "direction") == 0)  out->direction = v;
                else if (strcmp(pp->name, "waveform") == 0)   out->waveform = v;
                else if (strcmp(pp->name, "led_count") == 0)  out->led_count = v;
                else if (strcmp(pp->name, "gap") == 0)        out->gap = v;
                else if (strcmp(pp->name, "spread") == 0)     out->spread = v;
                else if (strcmp(pp->name, "tail_length") == 0) out->tail_length = v;
                else if (strcmp(pp->name, "decay") == 0)      out->decay = v;
                else if (strcmp(pp->name, "mode") == 0)       out->mode = v;
                else if (strcmp(pp->name, "pattern") == 0)    out->pattern = v;
                else if (strcmp(pp->name, "step_size") == 0)  out->step_size = v;
                break;
            }
            case PARAM_U16: {
                if (!TAKE(2)) return false;
                uint16_t v = (uint16_t)p[off] | ((uint16_t)p[off + 1] << 8);
                off += 2;
                if      (strcmp(pp->name, "period") == 0)   out->period = v;
                else if (strcmp(pp->name, "on_time") == 0) out->on_time = v;
                else if (strcmp(pp->name, "off_time") == 0) out->off_time = v;
                break;
            }
            case PARAM_U32: {
                if (!TAKE(4)) return false;
                // No u32 params in the current effect set; consume anyway.
                off += 4;
                break;
            }
            default:
                return false;
        }
    }
#undef TAKE
    return ok;
}