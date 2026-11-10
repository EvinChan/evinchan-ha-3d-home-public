"""Python port of the original ``@ha3d/schema`` package.

Mirrors ``normalizeFloorplanProject`` / ``validateFloorplanProject`` and the
``sampleProject`` default so the integration stores and validates floor-plan
projects exactly like the Add-on backend did.
"""

from __future__ import annotations

from typing import Any

CURRENT_PROJECT_VERSION = 4

_SUPPORTED_AGGREGATIONS = ("avg", "min", "max", "latest")
_BINDING_ROLES = {
    "environment": ["temperature", "humidity", "pm25", "co2", "voc", "illuminance"],
    "lighting": ["main", "ambient", "scene"],
    "shade": ["curtain", "blind"],
    "security": ["motion", "presence", "doorWindow", "camera", "lock", "alarm"],
}
_SUPPORTED_FURNITURE = (
    "sofa", "bed", "dining_table", "desk", "wardrobe", "cabinet", "tv_stand",
    "kitchen_island", "coffee_table", "bookshelf", "sideboard", "shoe_cabinet",
    "nightstand", "side_table", "wash_basin", "toilet", "water_heater",
    "squat_toilet", "gas_stove",
    # Added by the integration: a cross-door refrigerator modelled by the
    # `appliance-fridge.js` runtime patch. It is stored as furniture so it can
    # be placed from the editor's furniture library.
    "fridge",
    # Round sintered-stone dining table with a turntable, and its dining chair.
    # Both are modelled by `furniture-dining-table.js` and placed from the
    # library by `furniture-library-dining.js`.
    "dining_round_table",
    "dining_chair",
    # Front-load washing machine modelled by `appliance-washer.js` and placed
    # from the library by `furniture-library-washer.js`.
    "washer",
    # Nested black & white round coffee tables (one big + one small) modelled by
    # `furniture-nested-coffee-table.js` and placed from the library by
    # `furniture-library-nested-coffee-table.js`.
    "nested_coffee_table",
    # Potted dracaena ("dragon tree") in a tall octagonal marble planter,
    # modelled by `furniture-dragon-tree.js` and placed from the library by
    # `furniture-library-dragon-tree.js`. Stored as furniture (path A, purely
    # decorative); carried by the native `side_table` kind.
    "dragon_tree",
)
_FURNITURE_FALLBACK = {
    "bed": (1.8, 2.0, 0.42), "bookshelf": (1.1, 0.32, 1.12),
    "cabinet": (1.6, 0.6, 0.72), "coffee_table": (1.0, 0.55, 0.3),
    "desk": (1.2, 0.6, 0.62), "dining_table": (1.4, 0.82, 0.62),
    "kitchen_island": (1.8, 0.9, 0.72), "sofa": (2.2, 0.9, 0.68),
    "side_table": (0.48, 0.48, 0.45), "sideboard": (1.5, 0.42, 0.78),
    "nightstand": (0.5, 0.42, 0.48), "shoe_cabinet": (1.1, 0.32, 0.92),
    "tv_stand": (1.8, 0.38, 0.34), "wardrobe": (1.4, 0.6, 1.22),
    "wash_basin": (0.6, 0.48, 0.82), "toilet": (0.7, 0.72, 0.78),
    "water_heater": (0.58, 0.32, 0.72), "squat_toilet": (0.62, 0.82, 0.16),
    "gas_stove": (0.72, 0.52, 0.12),
    # Panasonic Xtra style cross-door refrigerator (W x D x H, doors included).
    "fridge": (0.822, 0.6, 1.91),
    # Round dining table: 1.5 m top, 0.746 m to the table surface (the
    # turntable sits on top of it and is not part of the recorded height).
    "dining_round_table": (1.5, 1.5, 0.746),
    "dining_chair": (0.55, 0.52, 0.82),
    # Mijia style front-load washer (W x D x H, door protrusion excluded).
    "washer": (0.6, 0.6, 0.85),
    # Nested coffee tables: big top ⌀0.80 at the origin, small top ⌀0.60
    # offset +0.55 along X (total bounding box 1.25 x 0.80, height 0.45).
    "nested_coffee_table": (1.25, 0.8, 0.45),
    # Potted dracaena in a tall octagonal planter: foliage reaches 0.40 x 0.40
    # around the 0.90 m tall pot (across-corners ⌀0.38 top / ⌀0.30 bottom).
    "dragon_tree": (0.4, 0.4, 1.3),
}
_SUPPORTED_DEVICE_KINDS = (
    "light", "switch", "cover", "climate", "sensor", "binary_sensor",
    "camera", "lock", "fan", "media_player", "alarm_control_panel", "vacuum",
    "custom",
)


def _is_record(value: Any) -> bool:
    return isinstance(value, dict)


def _finite(value: Any, fallback: float, lo: float = -1e308, hi: float = 1e308) -> float:
    if isinstance(value, (int, float)) and __import__("math").isfinite(value):
        return min(hi, max(lo, float(value)))
    return fallback


def _text(value: Any, fallback: str) -> str:
    return value.strip() if isinstance(value, str) and value.strip() else fallback


def _optional_text(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


_HEX_COLOR = __import__("re").compile(r"^#[0-9a-fA-F]{6}$")


def _color(value: Any) -> str | None:
    """Normalise a user picked surface colour.

    The model runtime patches let the user recolour an appliance from the
    inspector panel. The choice is stored on the furniture record, so it has to
    survive `normalize_furniture` — which rebuilds the dict field by field and
    silently drops anything it does not list. Only an explicit ``#rrggbb`` is
    accepted; a bare preset name would need a shared preset table on both sides,
    and an unvalidated string would end up straight inside a CSS value.
    """
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text.lower() if _HEX_COLOR.match(text) else None


def _tv_glow_fields(device: Any) -> dict:
    """Whitelist the 75\" TV's glow tuning fields on a *device* record.

    Only `modelId == media_player.tv` gets them: other device models must keep
    their exact record shape. ``glowColor`` is an ``#rrggbb`` string,
    ``glowIntensity`` is clamped to 0..1.5. Both are optional — an old project
    without them is byte-for-byte unchanged after a normalise round-trip.
    """
    if not isinstance(device, dict) or device.get("modelId") != "media_player.tv":
        return {}
    out: dict = {}
    color = _color(device.get("glowColor"))
    if color:
        out["glowColor"] = color
    if "glowIntensity" in device:
        out["glowIntensity"] = _finite(device.get("glowIntensity"), 0.75, 0, 1.5)
    return out


def _mirror_x(source: Any) -> dict:
    """Whitelist the shared ``mirrorX`` flag on BOTH record types.

    ``mirrorX`` mirrors a custom 3D model along its local X axis. It is a
    strict boolean: only ``True`` is written, so unset / false / stray types
    keep old projects byte-for-byte unchanged after a normalise round-trip.
    """
    if not isinstance(source, dict) or source.get("mirrorX") is not True:
        return {}
    return {"mirrorX": True}


# Per-model numeric option: the dynamic wardrobe's door width sits.
# Door count = record width / doorWidth, so it changes the built geometry and
# has to survive `normalize_furniture`. Only that one model reads it; every
# other record stays byte-for-byte unchanged after a normalise round-trip.
_DOOR_WIDTH_RANGE = (0.2, 1.2)


def _door_width(source: Any) -> dict:
    """Whitelist ``doorWidth`` (metres) on the dynamic wardrobe record."""
    if not isinstance(source, dict) or source.get("modelId") != "furniture.wardrobe_dynamic":
        return {}
    value = _finite(source.get("doorWidth"), 0.3, *_DOOR_WIDTH_RANGE)
    return {"doorWidth": round(value, 3)}


# User-tunable vertical nudge for a custom model, in metres. Small by design:
# it compensates a few millimetres of rendering drift, not to relocate a model.
_LIFT_OFF_LIMIT = 0.1


def _lift_off(value: Any) -> float | None:
    """Normalise the ``liftOff`` nudge (metres).

    Clamped to +/-0.1 m and rounded to 0.1 mm so a slider cannot push a model
    into the ceiling or poison the transform with a huge value. ``None`` means
    "not set" (the field is then omitted entirely, keeping old records intact).
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if number != number or number in (float("inf"), float("-inf")):  # NaN/inf
        return None
    clamped = max(-_LIFT_OFF_LIMIT, min(_LIFT_OFF_LIMIT, number))
    if abs(clamped) < 1e-6:
        return None  # exactly 0 is the default: do not write the field
    return round(clamped, 4)


def _vector2(value: Any, fallback: list[float]) -> list[float]:
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        return [_finite(value[0], fallback[0]), _finite(value[1], fallback[1])]
    return list(fallback)


def _vector3(value: Any, fallback: list[float]) -> list[float]:
    if isinstance(value, (list, tuple)) and len(value) >= 3:
        return [
            _finite(value[0], fallback[0]),
            _finite(value[1], fallback[1]),
            _finite(value[2], fallback[2]),
        ]
    return list(fallback)


def _normalize_entity_binding(value: Any) -> dict | None:
    source = value if _is_record(value) else {}
    entity_ids = [
        item.strip()
        for item in source.get("entityIds", [])
        if isinstance(item, str) and "." in item
    ]
    if not entity_ids:
        return None
    result: dict[str, Any] = {"entityIds": list(dict.fromkeys(entity_ids))}
    if source.get("aggregation") in _SUPPORTED_AGGREGATIONS:
        result["aggregation"] = source["aggregation"]
    return result


def _normalize_role_bindings(value: Any, roles: list[str]) -> dict | None:
    if not _is_record(value):
        return None
    entries = [
        (role, _normalize_entity_binding(value.get(role)))
        for role in roles
        if role in value
    ]
    entries = [(r, b) for r, b in entries if b]
    return dict(entries) if entries else None


def _normalize_room_bindings(value: Any) -> dict | None:
    if not _is_record(value):
        return None
    bindings: dict[str, Any] = {}
    env = _normalize_role_bindings(value.get("environment"), _BINDING_ROLES["environment"])
    light = _normalize_role_bindings(value.get("lighting"), _BINDING_ROLES["lighting"])
    shade = _normalize_role_bindings(value.get("shade"), _BINDING_ROLES["shade"])
    sec = _normalize_role_bindings(value.get("security"), _BINDING_ROLES["security"])
    if env:
        bindings["environment"] = env
    if light:
        bindings["lighting"] = light
    if shade:
        bindings["shade"] = shade
    if sec:
        bindings["security"] = sec
    return bindings or None


def normalize_opening(value: Any) -> dict:
    source = value if _is_record(value) else {}
    otype = "window" if source.get("type") == "window" else "door"
    window_style = "floor_to_ceiling" if source.get("windowStyle") == "floor_to_ceiling" else "standard"
    return {
        "id": _text(source.get("id"), f"opening-{__import__('time').time_ns()}"),
        "type": otype,
        "entityId": source.get("entityId") if isinstance(source.get("entityId"), str) and "." in source["entityId"] else None,
        "wallId": _text(source.get("wallId"), ""),
        "offset": _finite(source.get("offset"), 0, 0, 1e308),
        "width": _finite(source.get("width"), 1.2 if otype == "window" else 0.9, 0.1, 20),
        "height": _finite(source.get("height"), 1.2 if otype == "window" else 2.1, 0.1, 12),
        "bottom": 0 if (otype == "window" and window_style == "floor_to_ceiling") else _finite(source.get("bottom"), 0.9 if otype == "window" else 0, 0, 12),
        "windowStyle": window_style,
        "windowOpening": "outward" if source.get("windowOpening") == "outward" else "sliding",
        "hasLeaf": otype == "door" and source.get("hasLeaf", True) is not False,
        "doorStyle": "double" if source.get("doorStyle") == "double" else "single",
        "swing": "outward" if source.get("swing") == "outward" else "inward",
        "hinge": "end" if source.get("hinge") == "end" else "start",
    }


def normalize_furniture(value: Any, floor_id: str) -> dict:
    source = value if _is_record(value) else {}
    kind = source.get("kind") if source.get("kind") in _SUPPORTED_FURNITURE else "sofa"
    size = _FURNITURE_FALLBACK[kind]
    return {
        "id": _text(source.get("id"), f"furniture-{__import__('time').time_ns()}"),
        "kind": kind,
        "floorId": floor_id,
        "roomId": source.get("roomId") if isinstance(source.get("roomId"), str) and source["roomId"] else None,
        "position": _vector2(source.get("position"), [0, 0]),
        "rotation": _finite(source.get("rotation"), 0, -4 * 3.141592653589793, 4 * 3.141592653589793),
        "width": _finite(source.get("width"), size[0], 0.2, 20),
        "depth": _finite(source.get("depth"), size[1], 0.2, 20),
        "height": _finite(source.get("height"), size[2], 0.1, 12),
        "modelId": source.get("modelId") if isinstance(source.get("modelId"), str) and source["modelId"] else None,
        # User picked surface colour for custom models. Consumers:
        #   appliance.fridge  -> appliance-fridge.js  (body panels)
        #   appliance.washer  -> appliance-washer.js  (body)
        #   furniture.dining_round_table -> furniture-dining-table.js (stone top)
        #   furniture.dining_chair       -> furniture-dining-table.js (upholstery)
        #   furniture.nested_coffee_tables -> furniture-nested-coffee-table.js
        #                                     (BIG table top)
        # `chairColor` is the SECOND colour of a round table: the six chairs that
        # are part of the table model. A chair record has no field for them, so
        # the table record owns both options (inspector-surface-color.js shows
        # one swatch row per field).
        # `smallTopColor` is the SMALL tabletop of the nested coffee tables —
        # the two tops are configured independently.
        # Kept out of the record when unset so existing projects keep their
        # exact shape and the style default still applies.
        **({"surfaceColor": _color(source.get("surfaceColor"))} if _color(source.get("surfaceColor")) else {}),
        **({"chairColor": _color(source.get("chairColor"))} if _color(source.get("chairColor")) else {}),
        **({"smallTopColor": _color(source.get("smallTopColor"))} if _color(source.get("smallTopColor")) else {}),
        # `doorColor` / `cabinetColor` are the custom cream sideboard's two
        # independent colour options (furniture-sideboard.js): the lacquered
        # doors and the light-wood carcase are configured separately.
        **({"doorColor": _color(source.get("doorColor"))} if _color(source.get("doorColor")) else {}),
        **({"cabinetColor": _color(source.get("cabinetColor"))} if _color(source.get("cabinetColor")) else {}),
        # `cabinetBodyColor` is the custom TV stand's carcase colour
        # (furniture-tv-stand.js): it paints EVERY part except the five door
        # fronts -- side panels, the two vertical frame boards (the inner
        # walls of the open niches), centre divider, back panel, cabinet
        # bottom, niche shelf, both drawer boxes, the top slab and the
        # plinth. `doorColor` covers only the left door, the two drawer
        # fronts and the two right doors.
        **({"cabinetBodyColor": _color(source.get("cabinetBodyColor"))}
           if _color(source.get("cabinetBodyColor")) else {}),
        # `potColor` is the marble planter base colour of the potted dracaena
        # (furniture-dragon-tree.js); the black veins, gold 福 sticker, canes
        # and foliage stay fixed regardless of it.
        **({"potColor": _color(source.get("potColor"))} if _color(source.get("potColor")) else {}),
        # `blanketColor` / `pillowColor` are the Japanese storage platform
        # bed's two bedding colours (furniture-japanese-storage-bed.js);
        # the mattress and the black drawer seams stay fixed.
        **({"blanketColor": _color(source.get("blanketColor"))} if _color(source.get("blanketColor")) else {}),
        **({"pillowColor": _color(source.get("pillowColor"))} if _color(source.get("pillowColor")) else {}),
        # Shared model flags (strict boolean, omitted when unset).
        **_mirror_x(source),
        # Per-model numeric option (dynamic wardrobe door width).
        **_door_width(source),
        # `liftOff` (metres) nudges a custom model up/down to compensate for
        # rendering-level drift: the geometry can sit exactly on y = 0 and still
        # look sunk into (or floating above) the SPA's floor mesh because of
        # shadow maps, outline shells or the floor slab itself. Written by
        # inspector-model-offset.js, applied by furniture-nested-coffee-table.js.
        # 0 / unset is dropped so existing projects keep their exact shape.
        **(
            {"liftOff": _lift_off(source.get("liftOff"))}
            if _lift_off(source.get("liftOff")) is not None
            else {}
        ),
    }


def normalize_floorplan_project(value: Any) -> dict:
    import time

    source = value if _is_record(value) else dict(sample_project)
    raw_floors = source.get("floors") if isinstance(source.get("floors"), list) and source["floors"] else sample_project["floors"]
    floors = []
    for index, floor_value in enumerate(raw_floors):
        floor = floor_value if _is_record(floor_value) else {}
        fid = _text(floor.get("id"), f"floor-{index + 1}")
        walls = [
            {
                "id": _text(w.get("id"), f"wall-{index + 1}-{wi + 1}"),
                "start": _vector2(w.get("start"), [0, 0]),
                "end": _vector2(w.get("end"), [1, 0]),
                "thickness": _finite(w.get("thickness"), 0.14, 0.05, 1),
                "height": _finite(w.get("height"), _finite(floor.get("height"), 2.8, 1, 12), 1, 12),
                "materialId": w.get("materialId") if isinstance(w.get("materialId"), str) else None,
                **({"transparent": True} if w.get("transparent") is True else {}),
            }
            for wi, w in enumerate(floor.get("walls", []) if isinstance(floor.get("walls"), list) else [])
        ]
        rooms = [
            {
                "id": _text(r.get("id"), f"room-{index + 1}-{ri + 1}"),
                "name": _text(r.get("name"), f"房间 {ri + 1}"),
                "polygon": [_vector2(p, [0, 0]) for p in (r.get("polygon") if isinstance(r.get("polygon"), list) else [])],
                "floorMaterialId": _optional_text(r.get("floorMaterialId")),
                "ceilingMaterialId": _optional_text(r.get("ceilingMaterialId")),
                "haAreaId": _optional_text(r.get("haAreaId")),
                "bindings": _normalize_room_bindings(r.get("bindings")),
            }
            for ri, r in enumerate(floor.get("rooms", []) if isinstance(floor.get("rooms"), list) else [])
        ]
        openings = [
            normalize_opening(o)
            for o in (floor.get("openings") if isinstance(floor.get("openings"), list) else [])
            if any(w["id"] == o.get("wallId") for w in walls)
        ]
        devices = [
            {
                "id": _text(d.get("id"), f"device-{index + 1}-{di + 1}"),
                "entityId": _text(d.get("entityId"), ""),
                "kind": d.get("kind") if d.get("kind") in _SUPPORTED_DEVICE_KINDS else "custom",
                "floorId": fid,
                "roomId": d.get("roomId") if isinstance(d.get("roomId"), str) else None,
                "position": _vector3(d.get("position"), [0, 1.2, 0]),
                "rotation": _vector3(d.get("rotation"), [0, 0, 0]),
                "scale": _vector3(d.get("scale"), [1, 1, 1]) if isinstance(d.get("scale"), list) else None,
                "modelId": d.get("modelId") if isinstance(d.get("modelId"), str) and d["modelId"] else None,
                "icon": d.get("icon") if isinstance(d.get("icon"), str) and d["icon"] else None,
                "lightStrip": None,
                "controlledLightFixtures": None,
                **_mirror_x(d),
                **_tv_glow_fields(d),
            }
            for di, d in enumerate(floor.get("devices", []) if isinstance(floor.get("devices"), list) else [])
            if isinstance(d.get("entityId"), str) and d["entityId"].strip()
        ]
        floors.append({
            "id": fid,
            "name": _text(floor.get("name"), f"{index + 1} 层"),
            "level": _finite(floor.get("level"), index + 1, -20, 200),
            "height": _finite(floor.get("height"), 2.8, 1, 12),
            "walls": walls,
            "rooms": rooms,
            "openings": openings,
            "devices": devices,
            "furniture": [
                normalize_furniture(item, fid)
                for item in (floor.get("furniture") if isinstance(floor.get("furniture"), list) else [])
            ],
        })
    materials = source.get("materials") if isinstance(source.get("materials"), list) else sample_project["materials"]
    assets = source.get("assets") if isinstance(source.get("assets"), list) else []
    return {
        "id": _text(source.get("id"), sample_project["id"]),
        "name": _text(source.get("name"), sample_project["name"]),
        "version": max(CURRENT_PROJECT_VERSION, int(_finite(source.get("version"), CURRENT_PROJECT_VERSION, 1, 1e308))),
        "unit": "m",
        "createdAt": _text(source.get("createdAt"), time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())),
        "updatedAt": _text(source.get("updatedAt"), time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())),
        "floors": floors,
        "materials": [
            {
                "id": _text(m.get("id"), f"material-{i + 1}"),
                "name": _text(m.get("name"), f"材质 {i + 1}"),
                "color": _text(m.get("color"), "#f5f2ec"),
                "roughness": _finite(m.get("roughness"), 0.8, 0, 1) if isinstance(m.get("roughness"), (int, float)) else None,
                "metalness": _finite(m.get("metalness"), 0, 0, 1) if isinstance(m.get("metalness"), (int, float)) else None,
            }
            for i, m in enumerate(m for m in materials if _is_record(m))
        ],
        "assets": [
            {
                "id": _text(a.get("id"), f"asset-{i + 1}"),
                "type": a.get("type") if a.get("type") in ("model", "texture") else "image",
                "name": _text(a.get("name"), f"资源 {i + 1}"),
                "url": _text(a.get("url"), ""),
                "metadata": a.get("metadata") if _is_record(a.get("metadata")) else None,
            }
            for i, a in enumerate(assets)
            if _is_record(a)
        ],
        "dashboardWidgets": _normalize_dashboard_widgets(source.get("dashboardWidgets")),
    }


def _normalize_dashboard_widgets(value: Any) -> list:
    if not isinstance(value, list):
        return []
    seen = set()
    out = []

    def entity_id(v: Any) -> str | None:
        return v.strip() if isinstance(v, str) and "." in v else None

    for index, item in enumerate(value):
        src = item if _is_record(item) else {}
        wid = _text(src.get("id"), f"dashboard-widget-{index + 1}")
        if wid in seen:
            continue
        seen.add(wid)
        common = {
            "id": wid,
            "title": _text(src.get("title"), f"数据卡片 {index + 1}"),
            "color": _optional_text(src.get("color")),
            "order": int(_finite(src.get("order"), index + 1, 0, 10000)),
            "visible": src.get("visible", True) is not False,
            "position": _normalize_widget_position(src.get("position")),
        }
        if src.get("type") == "group":
            items = [
                {
                    "entityId": entity_id(it.get("entityId")),
                    "label": _optional_text(it.get("label")),
                    "unit": _optional_text(it.get("unit")),
                    "precision": int(_finite(it.get("precision"), 0, 0, 4)) if isinstance(it.get("precision"), (int, float)) else None,
                }
                for it in (src.get("items") if isinstance(src.get("items"), list) else [])
                if entity_id(it.get("entityId"))
            ]
            if not items:
                continue
            out.append({**common, "type": "group", "items": items})
        else:
            eid = entity_id(src.get("entityId"))
            if not eid:
                continue
            out.append({
                **common,
                "type": "metric",
                "entityId": eid,
                "unit": _optional_text(src.get("unit")),
                "precision": int(_finite(src.get("precision"), 0, 0, 4)) if isinstance(src.get("precision"), (int, float)) else None,
            })
    out.sort(key=lambda w: w["order"])
    return out


def _normalize_widget_position(value: Any) -> dict | None:
    src = value if _is_record(value) else {}
    if not isinstance(src.get("x"), (int, float)) and not isinstance(src.get("y"), (int, float)):
        return None
    return {"x": _finite(src.get("x"), 4, 0, 100), "y": _finite(src.get("y"), 24, 0, 100)}


def validate_floorplan_project(value: Any) -> dict:
    if not _is_record(value):
        return {"valid": False, "issues": ["项目数据必须是对象"]}
    project = normalize_floorplan_project(value)
    issues: list[str] = []
    if not project["id"]:
        issues.append("项目 id 不能为空")
    if not project["floors"]:
        issues.append("项目至少需要一个楼层")
    for floor in project["floors"]:
        if not floor["id"]:
            issues.append("楼层 id 不能为空")
        for opening in floor["openings"]:
            if not opening["wallId"]:
                issues.append(f"开口 {opening['id']} 未关联墙体")
    if issues:
        return {"valid": False, "issues": issues}
    return {"valid": True, "project": project, "issues": []}


sample_areas = [
    {"id": "living_room", "name": "客厅"},
    {"id": "bedroom", "name": "卧室"},
    {"id": "kitchen", "name": "厨房"},
]
sample_entities = [
    {"entityId": "light.living_room", "domain": "light", "name": "客厅主灯", "state": "off", "attributes": {"brightness": 0}, "areaId": "living_room"},
    {"entityId": "cover.bedroom_curtain", "domain": "cover", "name": "卧室窗帘", "state": "closed", "attributes": {"current_position": 0}, "areaId": "bedroom"},
    {"entityId": "sensor.kitchen_temperature", "domain": "sensor", "name": "厨房温度", "state": "26.4", "attributes": {"unit_of_measurement": "°C", "device_class": "temperature"}, "areaId": "kitchen"},
    {"entityId": "sensor.kitchen_humidity", "domain": "sensor", "name": "厨房湿度", "state": "56", "attributes": {"unit_of_measurement": "%", "device_class": "humidity"}, "areaId": "kitchen"},
    {"entityId": "binary_sensor.living_room_motion", "domain": "binary_sensor", "name": "客厅人体", "state": "off", "attributes": {"device_class": "motion"}, "areaId": "living_room"},
    {"entityId": "lock.entry_door", "domain": "lock", "name": "入户门锁", "state": "locked", "attributes": {}, "areaId": "living_room"},
    {"entityId": "climate.living_room_ac", "domain": "climate", "name": "客厅空调", "state": "cool", "attributes": {"temperature": 26, "current_temperature": 26.2}, "areaId": "living_room"},
]

sample_project: dict = {
    "id": "demo-apartment",
    "name": "Demo Apartment",
    "version": 1,
    "unit": "m",
    "createdAt": "2026-07-21T00:00:00.000Z",
    "updatedAt": "2026-07-21T00:00:00.000Z",
    "materials": [
        {"id": "wall-white", "name": "Warm white wall", "color": "#f5f2ec", "roughness": 0.92},
        {"id": "oak-floor", "name": "Oak floor", "color": "#b58b5b", "roughness": 0.8},
    ],
    "assets": [],
    "dashboardWidgets": [],
    "floors": [
        {
            "id": "floor-1",
            "name": "一层",
            "level": 1,
            "height": 2.8,
            "rooms": [
                {"id": "living", "name": "客厅", "floorMaterialId": "oak-floor", "haAreaId": "living_room", "bindings": {"lighting": {"main": {"entityIds": ["light.living_room"]}}, "environment": {"temperature": {"entityIds": ["climate.living_room_ac"], "aggregation": "latest"}}, "security": {"motion": {"entityIds": ["binary_sensor.living_room_motion"]}, "lock": {"entityIds": ["lock.entry_door"]}}}, "polygon": [[0, 0], [5.2, 0], [5.2, 3.6], [0, 3.6]]},
                {"id": "bedroom", "name": "卧室", "floorMaterialId": "oak-floor", "haAreaId": "bedroom", "bindings": {"shade": {"curtain": {"entityIds": ["cover.bedroom_curtain"]}}}, "polygon": [[5.2, 0], [8.8, 0], [8.8, 3.6], [5.2, 3.6]]},
                {"id": "kitchen", "name": "厨房", "floorMaterialId": "oak-floor", "haAreaId": "kitchen", "bindings": {"environment": {"temperature": {"entityIds": ["sensor.kitchen_temperature"]}, "humidity": {"entityIds": ["sensor.kitchen_humidity"]}}}, "polygon": [[0, 3.6], [3.2, 3.6], [3.2, 6.2], [0, 6.2]]},
            ],
            "walls": [
                {"id": "w1", "start": [0, 0], "end": [8.8, 0], "thickness": 0.14, "height": 2.8, "materialId": "wall-white"},
                {"id": "w2", "start": [8.8, 0], "end": [8.8, 3.6], "thickness": 0.14, "height": 2.8, "materialId": "wall-white"},
                {"id": "w3", "start": [8.8, 3.6], "end": [0, 3.6], "thickness": 0.14, "height": 2.8, "materialId": "wall-white"},
                {"id": "w4", "start": [0, 3.6], "end": [0, 0], "thickness": 0.14, "height": 2.8, "materialId": "wall-white"},
                {"id": "w5", "start": [5.2, 0], "end": [5.2, 3.6], "thickness": 0.12, "height": 2.8, "materialId": "wall-white"},
                {"id": "w6", "start": [0, 3.6], "end": [3.2, 3.6], "thickness": 0.14, "height": 2.8, "materialId": "wall-white", "transparent": True},
                {"id": "w7", "start": [3.2, 3.6], "end": [3.2, 6.2], "thickness": 0.14, "height": 2.8, "materialId": "wall-white"},
                {"id": "w8", "start": [3.2, 6.2], "end": [0, 6.2], "thickness": 0.14, "height": 2.8, "materialId": "wall-white"},
                {"id": "w9", "start": [0, 6.2], "end": [0, 3.6], "thickness": 0.14, "height": 2.8, "materialId": "wall-white"},
            ],
            "openings": [],
            "devices": [
                {"id": "living-light", "entityId": "light.living_room", "kind": "light", "floorId": "floor-1", "roomId": "living", "position": [2.6, 2.0, 2.65], "rotation": [0, 0, 0]},
                {"id": "entry-lock", "entityId": "lock.entry_door", "kind": "lock", "floorId": "floor-1", "roomId": "living", "position": [0.25, 1.0, 1.8], "rotation": [0, 0, 0], "modelId": "lock.door"},
                {"id": "bedroom-cover", "entityId": "cover.bedroom_curtain", "kind": "cover", "floorId": "floor-1", "roomId": "bedroom", "position": [7.0, 0.2, 1.5], "rotation": [0, 0, 0]},
                {"id": "kitchen-sensor", "entityId": "sensor.kitchen_temperature", "kind": "sensor", "floorId": "floor-1", "roomId": "kitchen", "position": [1.6, 1.6, 4.9], "rotation": [0, 0, 0]},
            ],
            "furniture": [
                {"id": "living-sofa", "kind": "sofa", "floorId": "floor-1", "roomId": "living", "position": [1.35, 1.05], "rotation": 0, "width": 2.25, "depth": 0.92, "height": 0.68},
                {"id": "living-coffee-table", "kind": "coffee_table", "floorId": "floor-1", "roomId": "living", "position": [3.0, 1.1], "rotation": 0, "width": 1.15, "depth": 0.6, "height": 0.3},
                {"id": "living-dining", "kind": "dining_table", "floorId": "floor-1", "roomId": "living", "position": [3.65, 2.75], "rotation": 0, "width": 1.45, "depth": 0.84, "height": 0.62},
                {"id": "bedroom-bed", "kind": "bed", "floorId": "floor-1", "roomId": "bedroom", "position": [7.35, 1.1], "rotation": 0, "width": 1.85, "depth": 2.0, "height": 0.42},
                {"id": "bedroom-wardrobe", "kind": "wardrobe", "floorId": "floor-1", "roomId": "bedroom", "position": [8.25, 2.9], "rotation": 1.5707963267948966, "width": 1.55, "depth": 0.58, "height": 1.22},
                {"id": "bedroom-side-cabinet", "kind": "cabinet", "floorId": "floor-1", "roomId": "bedroom", "position": [6.15, 1.05], "rotation": 0, "width": 0.58, "depth": 0.48, "height": 0.48},
                {"id": "kitchen-cabinet-left", "kind": "cabinet", "floorId": "floor-1", "roomId": "kitchen", "position": [0.78, 5.62], "rotation": 0, "width": 1.28, "depth": 0.58, "height": 0.72},
                {"id": "kitchen-cabinet-right", "kind": "cabinet", "floorId": "floor-1", "roomId": "kitchen", "position": [2.35, 5.62], "rotation": 0, "width": 1.28, "depth": 0.58, "height": 0.72},
                {"id": "kitchen-island", "kind": "kitchen_island", "floorId": "floor-1", "roomId": "kitchen", "position": [1.65, 4.65], "rotation": 0, "width": 1.55, "depth": 0.78, "height": 0.72},
            ],
        }
    ],
}
