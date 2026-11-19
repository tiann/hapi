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

fn unicode_escape(input: &[u8]) -> Option<u16> {
    let digits = input.strip_prefix(br"\u")?.get(..4)?;
    if !digits.iter().all(u8::is_ascii_hexdigit) {
        return None;
    }
    u16::from_str_radix(std::str::from_utf8(digits).ok()?, 16).ok()
}

pub(crate) fn decode_json<T: serde::de::DeserializeOwned>(data: &str) -> serde_json::Result<T> {
    serde_json::from_str(data).or_else(|error| {
        let bytes = data.as_bytes();
        let mut normalized = None;
        let mut pos = 0;
        while let Some(offset) = bytes[pos..].iter().position(|&b| b == b'\\') {
            let start = pos + offset;
            let Some(unit) = unicode_escape(&bytes[start..]) else {
                pos = (start + 2).min(bytes.len());
                continue;
            };
            pos = start + 6;
            if (0xd800..=0xdbff).contains(&unit)
                && unicode_escape(&bytes[pos..]).is_some_and(|low| (0xdc00..=0xdfff).contains(&low))
            {
                pos += 6;
            } else if (0xd800..=0xdfff).contains(&unit) {
                normalized.get_or_insert_with(|| bytes.to_vec())[start + 2..pos]
                    .copy_from_slice(b"fffd");
            }
        }
        serde_json::from_slice(&normalized.ok_or(error)?)
    })
}

impl Packet {
    pub fn encode(&self) -> Result<String> {
        self.encode_with_prefix(b"")
    }

    pub(super) fn encode_with_prefix(&self, prefix: &[u8]) -> Result<String> {
        if !self.namespace.starts_with('/') || self.namespace.contains(',') {
            return Err(invalid("invalid namespace"));
        }
        let (kind, id) = match &self.payload {
            Payload::Connect(data) if data.as_ref().is_none_or(Value::is_object) => (b'0', None),
            Payload::Disconnect => (b'1', None),
            Payload::Event { id, name, .. } if valid_name(name) => (b'2', *id),
            Payload::Ack { id, .. } => (b'3', Some(*id)),
            Payload::ConnectError(v) if v.is_string() || v.is_object() => (b'4', None),
            _ => return Err(invalid("invalid socket payload")),
        };
        let mut wire = prefix.to_vec();
        wire.push(kind);
        if self.namespace != "/" {
            wire.extend_from_slice(self.namespace.as_bytes());
            wire.push(b',');
        }
        if let Some(id) = id {
            wire.extend_from_slice(id.to_string().as_bytes());
        }
        match &self.payload {
            Payload::Connect(Some(v)) | Payload::ConnectError(v) => {
                serde_json::to_writer(&mut wire, v)?
            }
            Payload::Event { name, args, .. } => {
                serde::Serializer::collect_seq(
                    &mut serde_json::Serializer::new(&mut wire),
                    std::iter::once(name).chain(args),
                )?;
            }
            Payload::Ack { args, .. } => serde_json::to_writer(&mut wire, args)?,
            _ => {}
        }
        String::from_utf8(wire).map_err(Error::other)
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
                    Some(decode_json(data)?)
                };
                if v.as_ref().is_some_and(|v| !v.is_object()) {
                    return Err(invalid("invalid CONNECT"));
                }
                Payload::Connect(v)
            }
            "1" if id.is_none() && data.is_empty() => Payload::Disconnect,
            "2" => {
                let values: Vec<Value> = decode_json(data)?;
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
                args: decode_json(data)?,
            },
            "4" if id.is_none() => {
                let v: Value = decode_json(data)?;
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
    #[test]
    fn normalize_only_unpaired_surrogates() {
        let packet = Packet::decode(
            r#"2["title",{"\ud83d":"\ud83d\udc00\ud83d","literal":"\\ud83d","low":"\ude00"}]"#,
        )
        .unwrap();
        let canonical = r#"2["title",{"�":"🐀�","literal":"\\ud83d","low":"�"}]"#;
        assert_eq!(packet.encode().unwrap(), canonical);
        assert_eq!(Packet::decode(canonical).unwrap(), packet);
        assert!(Packet::decode(r#"30["\ud83d\u12zz"]"#).is_err());
    }

    #[test]
    fn encode_ack_in_engine_frame() {
        let data = "xyz".repeat(1024 * 1024);
        let packet = Packet {
            namespace: "/cli".into(),
            payload: Payload::Ack {
                id: 42,
                args: vec![Value::String(data)],
            },
        };
        let frame = packet.encode_with_prefix(b"4").unwrap();
        assert!(frame.starts_with(r#"43/cli,42["xyz"#));
        assert_eq!(packet, Packet::decode(&frame[1..]).unwrap());
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
