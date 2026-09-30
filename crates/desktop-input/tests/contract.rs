use serde::Deserialize;
use weblink_desktop_input::protocol::parse;

#[derive(Deserialize)]
struct Fixture {
    name: String,
    json: String,
    valid: bool,
}
#[test]
fn shares_wire_fixtures_with_the_browser() {
    let fixtures: Vec<Fixture> = serde_json::from_str(include_str!(
        "../../../test/fixtures/remote-control-signals.json"
    ))
    .unwrap();
    for fixture in fixtures {
        let parsed = parse(fixture.json.as_bytes());
        assert_eq!(parsed.is_some(), fixture.valid, "{}", fixture.name);
        if let Some(value) = parsed {
            assert_eq!(parse(&serde_json::to_vec(&value).unwrap()), Some(value));
        }
    }
}
