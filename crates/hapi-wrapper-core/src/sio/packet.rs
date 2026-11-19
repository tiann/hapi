use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{Error, ErrorKind, Result};

pub(super) fn invalid(message: &'static str) -> Error {
    Error::new(ErrorKind::InvalidData, message)
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Open {
    pub sid: String,
    pub ping_interval: u64,
    pub ping_timeout: u64,
    #[serde(default)]
    pub max_payload: u64,
}

#[derive(Debug, PartialEq)]
pub enum EnginePacket {
    Open(Open),
    Close,
    Noop,
    Ping(String),
    Pong(String),
    Message(String),
}

impl EnginePacket {
    pub fn decode(raw: &str) -> Result<Self> {
        let (kind, data) = raw
            .split_at_checked(1)
            .ok_or_else(|| invalid("invalid Engine.IO packet"))?;
        Ok(match kind {
            "0" => Self::Open(serde_json::from_str(data)?),
            "1" => Self::Close,
            "6" => Self::Noop,
            "2" => Self::Ping(data.into()),
            "3" => Self::Pong(data.into()),
            "4" => Self::Message(data.into()),
            _ => return Err(invalid("unsupported Engine.IO packet")),
        })
    }
    pub fn encode(&self) -> String {
        match self {
            Self::Open(open) => format!("0{}", serde_json::json!(open)),
            Self::Noop => "6".into(),
            Self::Close => "1".into(),
            Self::Ping(s) => format!("2{s}"),
            Self::Pong(s) => format!("3{s}"),
            Self::Message(s) => format!("4{s}"),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Payload {
    Connect(Option<Value>),
    Disconnect,
    Event {
        id: Option<u64>,
        name: Value,
        args: Vec<Value>,
    },
    Ack {
        id: u64,
        args: Vec<Value>,
    },
    ConnectError(Value),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Packet {
    pub namespace: String,
    pub payload: Payload,
}

pub(super) fn reserved(name: &str) -> bool {
    matches!(
        name,
        "connect"
            | "connect_error"
            | "disconnect"
            | "disconnecting"
            | "newListener"
            | "removeListener"
    )
}

fn valid_name(name: &Value) -> bool {
    name.is_number() || name.as_str().is_some_and(|s| !reserved(s))
}

impl Packet {
    pub fn encode(&self) -> Result<String> {
        if !self.namespace.starts_with('/') || self.namespace.contains(',') {
            return Err(invalid("invalid namespace"));
        }
        let (kind, id, data) = match &self.payload {
            Payload::Connect(data) if data.as_ref().is_none_or(Value::is_object) => {
                ('0', None, data.clone())
            }
            Payload::Disconnect => ('1', None, None),
            Payload::Event { id, name, args } if valid_name(name) => {
                let mut values = vec![name.clone()];
                values.extend_from_slice(args);
                ('2', *id, Some(Value::Array(values)))
            }
            Payload::Ack { id, args } => ('3', Some(*id), Some(Value::Array(args.clone()))),
            Payload::ConnectError(v) if v.is_string() || v.is_object() => {
                ('4', None, Some(v.clone()))
            }
            _ => return Err(invalid("invalid socket payload")),
        };
        let mut wire = kind.to_string();
        if self.namespace != "/" {
            wire.push_str(&self.namespace);
            wire.push(',');
        }
        if let Some(id) = id {
            wire.push_str(&id.to_string());
        }
        if let Some(data) = data {
            wire.push_str(&data.to_string());
        }
        Ok(wire)
    }

    pub fn decode(raw: &str) -> Result<Self> {
        let (kind, rest) = raw
            .split_at_checked(1)
            .ok_or_else(|| invalid("invalid Socket.IO packet"))?;
        let (namespace, rest) = if rest.starts_with('/') {
            rest.split_once(',').unwrap_or((rest, ""))
        } else {
            ("/", rest)
        };
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        let id = if digits == 0 {
            None
        } else {
            Some(
                rest[..digits]
                    .parse::<u64>()
                    .map_err(|_| invalid("invalid ack id"))?,
            )
        };
        let data = &rest[digits..];
        let payload = match kind {
            "0" if id.is_none() => {
                let v: Option<Value> = if data.is_empty() {
                    None
                } else {
                    Some(serde_json::from_str(data)?)
                };
                if v.as_ref().is_some_and(|v| !v.is_object()) {
                    return Err(invalid("invalid CONNECT"));
                }
                Payload::Connect(v)
            }
            "1" if id.is_none() && data.is_empty() => Payload::Disconnect,
            "2" => {
                let values: Vec<Value> = serde_json::from_str(data)?;
                let mut args = values.into_iter();
                let Some(name) = args.next().filter(valid_name) else {
                    return Err(invalid("missing event name"));
                };
                Payload::Event {
                    id,
                    name,
                    args: args.collect(),
                }
            }
            "3" => Payload::Ack {
                id: id.ok_or_else(|| invalid("missing ack id"))?,
                args: serde_json::from_str(data)?,
            },
            "4" if id.is_none() => {
                let v: Value = serde_json::from_str(data)?;
                if !v.is_string() && !v.is_object() {
                    return Err(invalid("invalid CONNECT_ERROR"));
                }
                Payload::ConnectError(v)
            }
            _ => return Err(invalid("unsupported Socket.IO packet")),
        };
        Ok(Self {
            namespace: namespace.into(),
            payload,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    fn value() -> impl Strategy<Value = Value> {
        prop_oneof![
            Just(Value::Null),
            any::<bool>().prop_map(Value::from),
            any::<i32>().prop_map(Value::from),
            ".*".prop_map(Value::String)
        ]
        .prop_recursive(3, 32, 4, |inner| {
            prop_oneof![
                prop::collection::vec(inner.clone(), 0..4).prop_map(Value::Array),
                prop::collection::btree_map(".{0,8}", inner, 0..4)
                    .prop_map(|m| Value::Object(m.into_iter().collect()))
            ]
        })
    }
    proptest! {
        #[test]
        fn roundtrip(ns in "/[^,]{0,12}",name in ".*",args in prop::collection::vec(value(),0..4),id in any::<Option<u64>>()){
            prop_assume!(!reserved(&name));
            for payload in [Payload::Connect(None),Payload::Connect(Some(serde_json::json!({"sid":"x"}))),Payload::Disconnect,Payload::ConnectError(Value::String(name.clone())),Payload::Ack{id:id.unwrap_or(0),args:args.clone()},Payload::Event{id,name:name.into(),args}] {
                let packet=Packet{namespace:ns.clone(),payload};
                let wire=EnginePacket::Message(packet.encode().unwrap());
                prop_assert_eq!(EnginePacket::decode(&wire.encode()).unwrap(),wire);
                prop_assert_eq!(Packet::decode(&packet.encode().unwrap()).unwrap(),packet);
            }
        }
        #[test]
        fn malformed_never_panics(bytes in any::<Vec<u8>>()){
            let s=String::from_utf8_lossy(&bytes);
            let _=EnginePacket::decode(&s);let _=Packet::decode(&s);
        }
    }
}
