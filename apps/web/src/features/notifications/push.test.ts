import { expect, test } from 'bun:test';
import { vapidKeyBytes } from './push.ts';

test('VAPID base64url keys decode without padding', () => {
  // 0xfb 0xff 0xbf -> "-_-_" in base64url (would be "+/+/" in base64)
  expect([...vapidKeyBytes('-_-_')]).toEqual([0xfb, 0xff, 0xbf]);
  expect([...vapidKeyBytes('AQID')]).toEqual([1, 2, 3]);
  expect(vapidKeyBytes(`B${'A'.repeat(86)}`).length).toBe(65); // uncompressed P-256 point
});
