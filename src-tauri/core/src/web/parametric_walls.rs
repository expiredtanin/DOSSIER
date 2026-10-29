//! Bindungen der parametrischen Wand-Engine (`crate::parametric_walls`): zustandslos, JSON hinein, JSON hinaus.
//! Der Zähler der Wand-ids reist mit (`counter`), Zustand hält die TS-Fassade. Kaputte Eingaben → leerer Text.

use crate::parametric_walls::{self as pw, Ctx};
use serde_json::{json, Value};
use wasm_bindgen::prelude::wasm_bindgen;

fn walls_of(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}

/// Rechnung `name`: `resolve` (`{parametricWall, floorId, context, defaultWallType, tolerance, counter}`),
/// `applyRule` (`{rule, ctx: {floorId, defaultWallType, context, existingWalls}, counter}`), `matchesCondition` /
/// `matchesTarget` (`{wall, condition|target, ctx}`), `deduplicate` (`{walls, tolerance}`).
#[wasm_bindgen]
pub fn parametric_call(name: &str, arg_json: &str) -> String {
    let Ok(a) = serde_json::from_str::<Value>(arg_json) else { return String::new() };
    let null = Value::Null;
    let counter = a["counter"].as_u64().unwrap_or(0);
    let out = match name {
        "resolve" => {
            let context = a.get("context").unwrap_or(&null);
            let existing = walls_of(context.get("existingWalls").unwrap_or(&null));
            let ctx = Ctx {
                floor_id: a.get("floorId").unwrap_or(&null),
                default_wall_type: a.get("defaultWallType").unwrap_or(&null),
                context,
                existing,
            };
            let mut n = counter;
            let walls = pw::resolve(a.get("parametricWall").unwrap_or(&null), &ctx, a["tolerance"].as_f64().unwrap_or(0.01), &mut n);
            json!({"walls": walls, "counter": n})
        }
        "applyRule" | "matchesCondition" | "matchesTarget" => {
            let c = a.get("ctx").unwrap_or(&null);
            let ctx = Ctx {
                floor_id: c.get("floorId").unwrap_or(&null),
                default_wall_type: c.get("defaultWallType").unwrap_or(&null),
                context: c.get("context").unwrap_or(&null),
                existing: walls_of(c.get("existingWalls").unwrap_or(&null)),
            };
            let wall = a.get("wall").unwrap_or(&null);
            match name {
                "applyRule" => {
                    let mut n = counter;
                    let walls = pw::apply_rule(a.get("rule").unwrap_or(&null), &ctx, &mut n);
                    json!({"walls": walls, "counter": n})
                }
                "matchesCondition" => json!(pw::matches_condition(wall, a["condition"].as_str().unwrap_or(""), &ctx)),
                _ => json!(pw::matches_target(wall, a["target"].as_str().unwrap_or(""), &ctx)),
            }
        }
        "deduplicate" => json!(pw::deduplicate(walls_of(a.get("walls").unwrap_or(&null)), a["tolerance"].as_f64().unwrap_or(0.01))),
        _ => return String::new(),
    };
    out.to_string()
}
