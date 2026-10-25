//! Minimal incremental Server-Sent Events parser. Handles events split across
//! network chunks (including split UTF-8 sequences) and CRLF line endings.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    pub event: String,
    pub data: String,
}

#[derive(Default)]
pub struct SseParser {
    buf: Vec<u8>,
}

impl SseParser {
    /// Feeds bytes and returns every complete event received so far.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        self.buf.extend(chunk.iter().copied().filter(|b| *b != b'\r'));
        let mut events = Vec::new();
        while let Some(end) = self.buf.windows(2).position(|w| w == b"\n\n") {
            let frame: Vec<u8> = self.buf.drain(..end + 2).collect();
            if let Some(ev) = parse_frame(&String::from_utf8_lossy(&frame)) {
                events.push(ev);
            }
        }
        events
    }
}

fn parse_frame(frame: &str) -> Option<SseEvent> {
    let mut event = String::from("message");
    let mut data: Vec<&str> = Vec::new();
    for line in frame.lines() {
        if line.starts_with(':') {
            continue; // comment / keep-alive
        }
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "event" => event = value.to_owned(),
            "data" => data.push(value),
            _ => {}
        }
    }
    (!data.is_empty()).then(|| SseEvent { event, data: data.join("\n") })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_events_split_across_chunks() {
        let mut p = SseParser::default();
        assert!(p.push(b"event: ping\r\ndata: {}\r").is_empty());
        let evs = p.push(b"\n\r\nevent: content_block_delta\ndata: {\"a\":1}\n\n");
        assert_eq!(evs.len(), 2);
        assert_eq!(evs[0].event, "ping");
        assert_eq!(evs[1].data, "{\"a\":1}");
    }

    #[test]
    fn handles_split_utf8() {
        let mut p = SseParser::default();
        let bytes = "data: héllo\n\n".as_bytes();
        let (a, b) = bytes.split_at(8); // splits inside "é"
        assert!(p.push(a).is_empty());
        assert_eq!(p.push(b)[0].data, "héllo");
    }
}
