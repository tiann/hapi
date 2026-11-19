use serde_json::{Map, Value};

pub fn merge(
    base: &Map<String, Value>,
    fields: impl IntoIterator<Item = (String, Option<Value>)>,
) -> Map<String, Value> {
    let mut result = base.clone();
    for (name, value) in fields {
        if let Some(value) = value {
            result.insert(name, value);
        } else {
            result.shift_remove(&name);
        }
    }
    result
}

pub fn deep_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| deep_equal(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(k, v)| b.get(k).is_some_and(|other| deep_equal(v, other)))
        }
        _ => a == b,
    }
}

pub fn number_string(n: f64) -> String {
    if !n.is_finite() {
        return "null".into();
    }
    if n == 0.0 {
        return "0".into();
    }
    let shortest = Value::from(n.abs()).to_string();
    let (mantissa, exponent) = shortest.split_once(['e', 'E']).unwrap_or((&shortest, "0"));
    let decimal = mantissa.find('.').unwrap_or(mantissa.len());
    let raw = mantissa.replace('.', "");
    let significant = raw.trim_start_matches('0');
    let digits = significant.trim_end_matches('0');
    let exp = exponent.parse::<i32>().expect("formatted exponent") + decimal as i32
        - (raw.len() - significant.len()) as i32
        - 1;
    let sign = if n < 0.0 { "-" } else { "" };
    if !(-6..21).contains(&exp) {
        let fraction = if digits.len() > 1 {
            format!(".{}", &digits[1..])
        } else {
            String::new()
        };
        return format!("{sign}{}{fraction}e{exp:+}", &digits[..1]);
    }
    if exp < 0 {
        return format!("{sign}0.{}{digits}", "0".repeat((-exp - 1) as usize));
    }
    let point = exp as usize + 1;
    if point >= digits.len() {
        return format!("{sign}{digits}{}", "0".repeat(point - digits.len()));
    }
    format!("{sign}{}.{}", &digits[..point], &digits[point..])
}

pub fn stringify(value: &Value) -> String {
    match value {
        Value::Number(n) => number_string(n.as_f64().expect("finite JSON number")),
        Value::Array(a) => format!(
            "[{}]",
            a.iter().map(stringify).collect::<Vec<_>>().join(",")
        ),
        Value::Object(o) => {
            let mut entries: Vec<_> = o.iter().collect();
            entries.sort_by_key(|(key, _)| {
                key.parse::<u32>()
                    .ok()
                    .filter(|n| n.to_string() == key.as_str())
                    .unwrap_or(u32::MAX)
            });
            let fields = entries
                .into_iter()
                .map(|(k, v)| format!("{}:{}", Value::String(k.clone()), stringify(v)))
                .collect::<Vec<_>>();
            format!("{{{}}}", fields.join(","))
        }
        _ => value.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn patches_and_equality() {
        let base = json!({"a":1,"b":1,"nested":{"a":1}});
        let merged = merge(
            base.as_object().unwrap(),
            [
                ("a".into(), None),
                ("b".into(), Some(Value::Null)),
                ("nested".into(), Some(json!({"b":2}))),
            ],
        );
        assert!(deep_equal(
            &Value::Object(merged),
            &json!({"nested":{"b":2.0},"b":null})
        ));
        assert!(!deep_equal(&json!([1, 2]), &json!([2, 1])));
    }
    #[test]
    fn ecmascript_format() {
        assert_eq!(
            stringify(&json!({"x": [-0.0,1e-7,1e-6,1e20,1e21],"10":0,"2":1})),
            r#"{"2":1,"10":0,"x":[0,1e-7,0.000001,100000000000000000000,1e+21]}"#
        );
    }
}
