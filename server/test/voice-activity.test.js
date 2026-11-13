const test = require("node:test");
const assert = require("node:assert/strict");
const {
  updateVoiceActivity,
} = require("../../client/src/lib/voice-activity.js");
test("speech indicator bridges word pauses and quiet syllables without fluttering", () => {
  const meter = {};
  assert.equal(updateVoiceActivity(meter, 0.001, 0, false), false);
  assert.equal(updateVoiceActivity(meter, 0.02, 250, false), true);
  assert.equal(updateVoiceActivity(meter, 0.001, 500, false), true);
  assert.equal(updateVoiceActivity(meter, 0.009, 1000, false), true);
  assert.equal(updateVoiceActivity(meter, 0, 2000, false), true);
  assert.equal(updateVoiceActivity(meter, 0, 2250, false), false);
});
test("manual mute clears the indicator immediately; background noise never starts it", () => {
  const meter = {};
  for (let t = 0; t < 10000; t += 250)
    assert.equal(updateVoiceActivity(meter, 0.007, t, false), false);
  assert.equal(updateVoiceActivity(meter, 0.1, 10000, false), true);
  assert.equal(updateVoiceActivity(meter, 0.1, 10250, true), false);
  assert.equal(updateVoiceActivity(meter, 0, 10500, false), false);
});
