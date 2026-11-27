#!/usr/bin/env python3
"""Codegen: read protocol/*.csv -> emit C header + JS constants.

Single source of truth = CSV files in protocol/ (see ADR-0011). Frame-level
constants and config limits are declared in `frame-spec.md`; this script
mirrors them into generated output so both ends share one numeric contract.

Outputs:
  - firmware/include/protocol_gen.h
  - miniprogram/utils/protocol_gen.js

Run from repo root:
    python protocol/codegen/generate.py [--check]

--check: instead of writing files, compare regenerated output against
checked-in files. Exit 1 if any differ. Used by CI.
"""
from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PROTOCOL_DIR = ROOT / "protocol"
OUT_C = ROOT / "firmware" / "include" / "protocol_gen.h"
OUT_JS = ROOT / "miniprogram" / "utils" / "protocol_gen.js"

PROTOCOL_REPO = "sishoui/bt-model-light"

# Frame + config constants. Numeric contract defined in protocol/frame-spec.md.
FRAME_HEADER_BYTE = 0xAA
FRAME_LEN_MAX = 1500
FRAME_OVERHEAD = 7  # header(1) + len(2) + cmd(1) + seq(1) + crc16(2)
FRAME_TOTAL_MAX = FRAME_LEN_MAX + FRAME_OVERHEAD
CRC16_CCITT_INIT = 0xFFFF
CRC16_CCITT_POLY = 0x1021

PIN_COUNT = 8
LEDS_PER_PIN_MAX = 100
GROUPS_PER_PIN_MAX = 5
LED_RANGE_MAX = LEDS_PER_PIN_MAX - 1
STEPS_PER_GROUP_MAX = 5
LAYERS_PER_STEP_MAX = 2
STEP_DURATION_MIN = 1
STEP_DURATION_MAX = 60


# --- CSV loading ----------------------------------------------------------

def read_csv(name: str) -> list[dict[str, str]]:
    with (PROTOCOL_DIR / name).open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def load_versions() -> dict[str, dict]:
    out: dict[str, dict] = {}
    for row in read_csv("versions.csv"):
        out[row["name"].strip()] = {
            "major": int(row["major"]),
            "minor": int(row["minor"]),
            "released": row["released"].strip(),
            "notes": row["notes"].strip(),
        }
    return out


def load_commands() -> list[dict]:
    return [
        {
            "id": int(row["id"]),
            "name": row["name"].strip(),
            "code": row["code"].strip(),
            "direction": row["direction"].strip(),
            "description": row["description"].strip(),
        }
        for row in read_csv("commands.csv")
    ]


def load_errors() -> list[dict]:
    return [
        {
            "code": row["code"].strip(),
            "name": row["name"].strip(),
            "description": row["description"].strip(),
        }
        for row in read_csv("errors.csv")
    ]


def load_effects() -> list[dict]:
    return [
        {
            "id": int(row["id"]),
            "code": row["code"].strip(),
            "name": row["name"].strip(),
            "description": row["description"].strip(),
            "params": row["params"].strip(),
        }
        for row in read_csv("effects.csv")
    ]


def load_ble() -> list[dict]:
    return [
        {
            "key": row["key"].strip(),
            "value": row["value"].strip(),
            "description": row["description"].strip(),
        }
        for row in read_csv("ble.csv")
    ]


def load_notify() -> list[dict]:
    """STATUS_NOTIFY status codes (notify.csv).

    Byte-level payload layout defined in protocol/frame-spec.md
    ("STATUS_NOTIFY（0x81）负载"); mirrored into both outputs so the two
    ends can never disagree, like the frame constants above.
    """
    return [
        {
            "status": int(row["status"]),
            "code": row["code"].strip(),
            "name": row["name"].strip(),
            "description": row["description"].strip(),
        }
        for row in read_csv("notify.csv")
    ]


def load_ota() -> list[dict]:
    """OTA (0xF0) sub-commands (ota.csv).

    Byte-level payload layouts defined in protocol/frame-spec.md
    ("OTA（0xF0）负载"); mirrored into both outputs like notify.csv.
    """
    return [
        {
            "sub": int(row["sub"]),
            "code": row["code"].strip(),
            "name": row["name"].strip(),
            "direction": row["direction"].strip(),
            "description": row["description"].strip(),
        }
        for row in read_csv("ota.csv")
    ]


# --- shared helpers -------------------------------------------------------

def to_c_hex(value: str) -> str:
    """0xNN -> 0xNN (uppercased); decimal -> 0xNN."""
    s = value.strip()
    if s.lower().startswith("0x"):
        return s.upper().replace("0X", "0x")
    return f"0x{int(s):02X}"


def to_js_hex(value: str) -> str:
    s = value.strip()
    n = int(s, 16) if s.lower().startswith("0x") else int(s)
    return f"0x{n:02X}"


def to_camel_case(key: str) -> str:
    """'service_uuid' -> 'serviceUuid' (JS object key for BLE entries)."""
    parts = key.split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


def parse_effect_params(raw: str) -> list[dict]:
    """Parse 'name:type:min-max;...' into structured param dicts.

    Shared by both C and JS emitters so the two outputs can never disagree.
    """
    out: list[dict] = []
    for spec in (s.strip() for s in raw.split(";")):
        if not spec:
            continue
        name, typ, rng = spec.split(":")
        if typ == "rgb":
            out.append({"name": name, "type": "rgb", "size": 3, "min": 0, "max": 255})
        elif typ in ("u8", "u16", "u32"):
            lo, hi = rng.split("-")
            size = {"u8": 1, "u16": 2, "u32": 4}[typ]
            out.append({"name": name, "type": typ, "size": size, "min": int(lo), "max": int(hi)})
        else:
            raise ValueError(f"unknown param type: {typ}")
    return out


def direction_value(direction: str) -> str:
    """Map a CSV direction token to a C enum member or JS string literal."""
    mapping = {
        "app_to_fw": "CMD_DIR_APP_TO_FW",
        "fw_to_app": "CMD_DIR_FW_TO_APP",
        "bidirectional": "CMD_DIR_BIDIRECTIONAL",
    }
    if direction not in mapping:
        raise ValueError(f"unknown direction: {direction}")
    return mapping[direction]


# --- C header -------------------------------------------------------------

def gen_c_header() -> str:
    versions = load_versions()
    commands = load_commands()
    errors = load_errors()
    effects = load_effects()

    pv, fv, av = versions["protocol_version"], versions["firmware_version"], versions["app_version"]
    lines: list[str] = []
    a = lines.append

    a("// AUTO-GENERATED by protocol/codegen/generate.py — DO NOT EDIT BY HAND.")
    a("// Source of truth: protocol/*.csv + protocol/frame-spec.md. Regenerate: python protocol/codegen/generate.py")
    a(f"// Project: {PROTOCOL_REPO}")
    a("//")
    a(f"// protocol_version {pv['major']}.{pv['minor']} (released {pv['released']})")
    a(f"// firmware_version {fv['major']}.{fv['minor']} (released {fv['released']})")
    a(f"// app_version     {av['major']}.{av['minor']} (released {av['released']})")
    a("")
    a("#ifndef BT_MODEL_LIGHT_PROTOCOL_GEN_H")
    a("#define BT_MODEL_LIGHT_PROTOCOL_GEN_H")
    a("")
    a("#include <stdint.h>")
    a("#include <stddef.h>")
    a("")
    a("#ifdef __cplusplus")
    a('extern "C" {')
    a("#endif")
    a("")

    a("/* ---- versions (versions.csv) ---- */")
    a(f"#define PROTOCOL_VERSION_MAJOR {pv['major']}")
    a(f"#define PROTOCOL_VERSION_MINOR {pv['minor']}")
    a(f'#define PROTOCOL_VERSION_STRING "{pv["major"]}.{pv["minor"]}"')
    a(f"#define FIRMWARE_VERSION_MAJOR {fv['major']}")
    a(f"#define FIRMWARE_VERSION_MINOR {fv['minor']}")
    a(f'#define FIRMWARE_VERSION_STRING "{fv["major"]}.{fv["minor"]}"')
    a(f"#define APP_VERSION_MAJOR {av['major']}")
    a(f"#define APP_VERSION_MINOR {av['minor']}")
    a(f'#define APP_VERSION_STRING "{av["major"]}.{av["minor"]}"')
    a("")

    a("/* ---- frame (frame-spec.md) ---- */")
    a(f"#define FRAME_HEADER_BYTE {to_c_hex(f'{FRAME_HEADER_BYTE:#x}')}")
    a(f"#define FRAME_LEN_MAX {FRAME_LEN_MAX}")
    a(f"#define FRAME_OVERHEAD {FRAME_OVERHEAD}")
    a(f"#define FRAME_TOTAL_MAX (FRAME_LEN_MAX + FRAME_OVERHEAD)")
    a(f"#define CRC16_CCITT_INIT 0x{CRC16_CCITT_INIT:04X}")
    a(f"#define CRC16_CCITT_POLY 0x{CRC16_CCITT_POLY:04X}")
    a("")

    a("/* ---- ble (ble.csv) ---- */")
    for row in load_ble():
        macro = "BLE_" + row["key"].upper()
        a(f'#define {macro} "{row["value"]}"  /* {row["description"]} */')
    a("")
    a("/* ---- STATUS_NOTIFY status codes (notify.csv) ---- */")
    for n in load_notify():
        a(f"#define NOTIFY_STATUS_{n['name']} {n['code']}  /* {n['description']} */")
    a("")

    a("/* ---- commands (commands.csv) ---- */")
    for c in commands:
        a(f"#define CMD_{c['name']:<16} {to_c_hex(c['code'])}  /* {c['description']} */")
    a("")
    a(f"#define CMD_COUNT {len(commands)}")
    a("")

    a("/* ---- command direction ---- */")
    a("typedef enum {")
    a("    CMD_DIR_APP_TO_FW = 0,")
    a("    CMD_DIR_FW_TO_APP = 1,")
    a("    CMD_DIR_BIDIRECTIONAL = 2,")
    a("} cmd_direction_t;")
    a("")
    a("typedef struct {")
    a("    uint8_t code;")
    a("    const char *name;")
    a("    cmd_direction_t direction;")
    a("} cmd_entry_t;")
    a("")
    a("static const cmd_entry_t CMD_TABLE[] = {")
    for c in commands:
        a(f'    {{ {to_c_hex(c["code"])}, "{c["name"]}", {direction_value(c["direction"])} }},')
    a("};")
    a("")

    a("/* ---- errors (errors.csv) ---- */")
    for e in errors:
        a(f"#define ERR_{e['name']:<32} {to_c_hex(e['code'])}  /* {e['description']} */")
    a("")
    a(f"#define ERR_COUNT {len(errors)}")
    a("")

    a("/* ---- OTA (0xF0) sub-commands (ota.csv) ---- */")
    a("/* Payload layouts: protocol/frame-spec.md \"OTA（0xF0）负载\" */")
    for s in load_ota():
        a(f"#define OTA_SUB_{s['name']:<10} {to_c_hex(s['code'])}  /* {s['description']} */")
    a("")
    a(f"#define OTA_SUB_COUNT {len(load_ota())}")
    a("")

    a("/* ---- effects (effects.csv) ---- */")
    for e in effects:
        a(f"#define EFF_{e['name']:<16} {to_c_hex(e['code'])}  /* {e['description']} */")
    a("")
    a(f"#define EFFECT_COUNT {len(effects)}")
    a("")

    a("/* ---- effect parameter schema (effects.csv) ---- */")
    a("/* param type codes: u8, u16le, u32le, rgb (3 bytes R,G,B) */")
    a("typedef enum {")
    a("    PARAM_END = 0,")
    a("    PARAM_U8 = 1,")
    a("    PARAM_U16 = 2,")
    a("    PARAM_U32 = 3,")
    a("    PARAM_RGB = 4,")
    a("} param_type_t;")
    a("")
    a("typedef struct {")
    a("    uint8_t type;        /* param_type_t */")
    a("    uint8_t size;        /* bytes */")
    a("    uint16_t min;        /* for u8/u16/u32; rgb min=0 */")
    a("    uint16_t max;        /* for u8/u16/u32; rgb max=255 */")
    a("    const char *name;")
    a("} effect_param_t;")
    a("")
    a("typedef struct {")
    a("    uint8_t effect_id;")
    a("    const char *name;")
    a("    const effect_param_t *params;  /* terminated by PARAM_END */")
    a("} effect_entry_t;")
    a("")

    for e in effects:
        a(f"static const effect_param_t EFF_PARAMS_{e['name']}[] = {{")
        for p in parse_effect_params(e["params"]):
            a(f'    {{ PARAM_{p["type"].upper()}, {p["size"]}, {p["min"]}, {p["max"]}, "{p["name"]}" }},')
        a("    { PARAM_END, 0, 0, 0, NULL },")
        a("};")
        a("")

    a("static const effect_entry_t EFFECT_TABLE[] = {")
    for e in effects:
        a(f'    {{ {to_c_hex(e["code"])}, "{e["name"]}", EFF_PARAMS_{e["name"]} }},')
    a("};")
    a("")

    a("/* ---- crc (impl: firmware/src/protocol_parser.c) ---- */")
    a("uint16_t crc16_ccitt(const uint8_t *data, size_t len);")
    a("")

    a("/* ---- config limits (frame-spec.md) ---- */")
    a(f"#define PIN_COUNT {PIN_COUNT}")
    a(f"#define LEDS_PER_PIN_MAX {LEDS_PER_PIN_MAX}")
    a(f"#define GROUPS_PER_PIN_MAX {GROUPS_PER_PIN_MAX}")
    a(f"#define LED_RANGE_MAX {LED_RANGE_MAX}")
    a(f"#define STEPS_PER_GROUP_MAX {STEPS_PER_GROUP_MAX}")
    a(f"#define LAYERS_PER_STEP_MAX {LAYERS_PER_STEP_MAX}")
    a(f"#define STEP_DURATION_MIN {STEP_DURATION_MIN}")
    a(f"#define STEP_DURATION_MAX {STEP_DURATION_MAX}")
    a("")

    a("#ifdef __cplusplus")
    a("}")
    a("#endif")
    a("")
    a("#endif /* BT_MODEL_LIGHT_PROTOCOL_GEN_H */")
    a("")

    return "\n".join(lines)


# --- JS constants ---------------------------------------------------------

def gen_js_constants() -> str:
    versions = load_versions()
    commands = load_commands()
    errors = load_errors()
    effects = load_effects()

    pv, fv, av = versions["protocol_version"], versions["firmware_version"], versions["app_version"]
    lines: list[str] = []
    a = lines.append

    a("// AUTO-GENERATED by protocol/codegen/generate.py — DO NOT EDIT BY HAND.")
    a("// Source of truth: protocol/*.csv + protocol/frame-spec.md. Regenerate: python protocol/codegen/generate.py")
    a(f"// Project: {PROTOCOL_REPO}")
    a("//")
    a(f"// protocol_version {pv['major']}.{pv['minor']} (released {pv['released']})")
    a(f"// firmware_version {fv['major']}.{fv['minor']} (released {fv['released']})")
    a(f"// app_version     {av['major']}.{av['minor']} (released {av['released']})")
    a("")
    a("'use strict'")
    a("")

    a("/* ---- versions (versions.csv) ---- */")
    a(f"const PROTOCOL_VERSION = {{ major: {pv['major']}, minor: {pv['minor']}, string: '{pv["major"]}.{pv["minor"]}' }};")
    a(f"const FIRMWARE_VERSION = {{ major: {fv['major']}, minor: {fv['minor']}, string: '{fv["major"]}.{fv["minor"]}' }};")
    a(f"const APP_VERSION = {{ major: {av['major']}, minor: {av['minor']}, string: '{av["major"]}.{av["minor"]}' }};")
    a("")

    a("/* ---- frame (frame-spec.md) ---- */")
    a("const FRAME = {")
    a(f"  header: 0x{FRAME_HEADER_BYTE:02X},")
    a(f"  lenMax: {FRAME_LEN_MAX},")
    a(f"  overhead: {FRAME_OVERHEAD},")
    a(f"  totalMax: {FRAME_LEN_MAX} + {FRAME_OVERHEAD},")
    a(f"  crc16Init: 0x{CRC16_CCITT_INIT:04X},")
    a(f"  crc16Poly: 0x{CRC16_CCITT_POLY:04X},")
    a("};")
    a("")

    a("/* ---- ble (ble.csv) ---- */")
    a("const BLE = {")
    for row in load_ble():
        a(f"  {to_camel_case(row['key'])}: '{row['value']}',  // {row['description']}")
    a("};")
    a("")
    a("/* STATUS_NOTIFY status codes (notify.csv) */")
    a("const NOTIFY = {")
    for n in load_notify():
        a(f"  {n['name']}: {to_js_hex(n['code'])},  // {n['description']}")
    a("};")
    a("")

    a("/* ---- commands (commands.csv) ---- */")
    a("const CMD = {")
    for c in commands:
        a(f"  {c['name']}: {to_js_hex(c['code'])},  // {c['description']}")
    a("};")
    a("")
    a("const CMD_DIRECTION = {")
    for c in commands:
        d = c["direction"]
        a(f"  {c['name']}: '{d}',")
    a("};")
    a("")

    a("/* ---- errors (errors.csv) ---- */")
    a("const ERR = {")
    for e in errors:
        a(f"  {e['name']}: {to_js_hex(e['code'])},  // {e['description']}")
    a("};")
    a("")

    a("/* OTA (0xF0) sub-commands (ota.csv) */")
    a("const OTA_SUB = {")
    for s in load_ota():
        a(f"  {s['name']}: {to_js_hex(s['code'])},  // {s['description']}")
    a("};")
    a("")

    a("/* ---- effects (effects.csv) ---- */")
    a("const EFF = {")
    for e in effects:
        a(f"  {e['name']}: {to_js_hex(e['code'])},  // {e['description']}")
    a("};")
    a("")
    a("/* effect param schema: list of { name, type, size, min, max } */")
    a("const EFFECT_PARAMS = {")
    for e in effects:
        a(f"  {e['name']}: [")
        for p in parse_effect_params(e["params"]):
            a(f"    {{ name: '{p['name']}', type: '{p['type']}', size: {p['size']}, min: {p['min']}, max: {p['max']} }},")
        a("  ],")
    a("};")
    a("")

    a("/* ---- config limits (frame-spec.md) ---- */")
    a("const LIMITS = {")
    a(f"  pinCount: {PIN_COUNT},")
    a(f"  ledsPerPinMax: {LEDS_PER_PIN_MAX},")
    a(f"  groupsPerPinMax: {GROUPS_PER_PIN_MAX},")
    a(f"  ledRangeMax: {LED_RANGE_MAX},")
    a(f"  stepsPerGroupMax: {STEPS_PER_GROUP_MAX},")
    a(f"  layersPerStepMax: {LAYERS_PER_STEP_MAX},")
    a(f"  stepDurationMin: {STEP_DURATION_MIN},")
    a(f"  stepDurationMax: {STEP_DURATION_MAX},")
    a("};")
    a("")

    a("module.exports = {")
    a("  PROTOCOL_VERSION,")
    a("  FIRMWARE_VERSION,")
    a("  APP_VERSION,")
    a("  FRAME,")
    a("  BLE,")
    a("  NOTIFY,")
    a("  CMD,")
    a("  CMD_DIRECTION,")
    a("  ERR,")
    a("  OTA_SUB,")
    a("  EFF,")
    a("  EFFECT_PARAMS,")
    a("  LIMITS,")
    a("};")
    a("")

    return "\n".join(lines)


# --- main -----------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description="Protocol codegen")
    parser.add_argument("--check", action="store_true",
                        help="Compare output against checked-in files; exit 1 on diff")
    args = parser.parse_args()

    targets = [
        (OUT_C, gen_c_header()),
        (OUT_JS, gen_js_constants()),
    ]

    if args.check:
        rc = 0
        for path, content in targets:
            if not path.exists():
                print(f"MISSING: {path.relative_to(ROOT)}", file=sys.stderr)
                rc = 1
                continue
            existing = path.read_text(encoding="utf-8")
            if existing != content:
                print(f"DIFF: {path.relative_to(ROOT)}", file=sys.stderr)
                rc = 1
            else:
                print(f"OK: {path.relative_to(ROOT)}")
        return rc

    for path, content in targets:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8", newline="\n")
        print(f"WROTE: {path.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())